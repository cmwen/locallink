import assert from 'node:assert/strict';
import test from 'node:test';

import {
  buildMdnsQueryPacket,
  MdnsDiscovery,
  type MdnsMessageInfo,
  type MdnsSocket,
  normalizeMdnsDiscoveryConfig,
} from '../src/runtime/mdns-discovery';

type Listener = ((message: Buffer, rinfo: MdnsMessageInfo) => void) | ((error: Error) => void);

class FakeMdnsSocket implements MdnsSocket {
  readonly packets: Array<{ packet: Buffer; port: number; address: string }> = [];
  readonly listeners = new Map<string, Listener>();
  bound = false;
  closed = false;
  membership?: string;
  membershipError?: Error;
  ttl?: number;
  loopback?: boolean;

  on(event: 'message' | 'error', listener: Listener): this {
    this.listeners.set(event, listener);
    return this;
  }

  bind(_port: number, _address: string, callback?: () => void): this {
    this.bound = true;
    callback?.();
    return this;
  }

  addMembership(address: string): void {
    if (this.membershipError) throw this.membershipError;
    this.membership = address;
  }

  setMulticastTTL(ttl: number): void {
    this.ttl = ttl;
  }

  setMulticastLoopback(loopback: boolean): void {
    this.loopback = loopback;
  }

  send(packet: Uint8Array, offset: number, length: number, port: number, address: string, callback?: (error?: Error) => void): void {
    this.packets.push({ packet: Buffer.from(packet.slice(offset, offset + length)), port, address });
    callback?.();
  }

  close(callback?: () => void): void {
    this.closed = true;
    callback?.();
  }

  emitMessage(packet: Buffer, rinfo: MdnsMessageInfo): void {
    const listener = this.listeners.get('message') as ((message: Buffer, info: MdnsMessageInfo) => void) | undefined;
    listener?.(packet, rinfo);
  }
}

function makeConfig() {
  return {
    hostname: 'laptop.local',
    serviceInstance: 'LocalLink Dashboard',
    serviceType: '_locallink._tcp.local',
    port: 4010,
    addresses: ['192.168.1.20'],
    publicTxt: { path: '/', version: '1' },
  } as const;
}

function skipName(packet: Buffer, start: number): number {
  let offset = start;
  while (offset < packet.length) {
    const length = packet[offset]!;
    offset += 1;
    if (length === 0) return offset;
    if ((length & 0xc0) === 0xc0) return offset + 1;
    offset += length;
  }
  throw new Error('Invalid test DNS packet.');
}

function recordTtls(packet: Buffer): number[] {
  let offset = 12;
  const answerCount = packet.readUInt16BE(6);
  const additionalCount = packet.readUInt16BE(8);
  const ttls: number[] = [];
  for (let index = 0; index < answerCount + additionalCount; index += 1) {
    offset = skipName(packet, offset);
    offset += 4;
    ttls.push(packet.readUInt32BE(offset));
    const length = packet.readUInt16BE(offset + 4);
    offset += 6 + length;
  }
  return ttls;
}

test('normalizeMdnsDiscoveryConfig requires safe local names and rejects secret-like TXT metadata', () => {
  const normalized = normalizeMdnsDiscoveryConfig(makeConfig());
  assert.equal(normalized.hostnameFqdn, 'laptop.local.');
  assert.equal(normalized.serviceType, '_locallink._tcp.local.');
  assert.equal(normalized.serviceInstanceFqdn, 'LocalLink Dashboard._locallink._tcp.local.');
  assert.deepEqual(normalized.publicTxt, ['path=/', 'version=1']);

  assert.throws(() => normalizeMdnsDiscoveryConfig({ ...makeConfig(), hostname: 'not-local.example.com' }), /hostname.*\.local/i);
  assert.throws(() => normalizeMdnsDiscoveryConfig({ ...makeConfig(), serviceType: '_bad.local' }), /serviceType/i);
  assert.throws(() => normalizeMdnsDiscoveryConfig({ ...makeConfig(), publicTxt: { password: 'do-not-publish' } }), /TXT/i);
  assert.throws(() => normalizeMdnsDiscoveryConfig({ ...makeConfig(), publicTxt: { status: 'contains-a-token' } }), /TXT/i);
});

test('start advertises host records and DNS-SD PTR/SRV/TXT records through the injected socket', async () => {
  const socket = new FakeMdnsSocket();
  const discovery = new MdnsDiscovery(makeConfig(), { socketFactory: () => socket });

  await discovery.start();

  assert.equal(discovery.isStarted, true);
  assert.equal(socket.bound, true);
  assert.equal(socket.membership, '224.0.0.251');
  assert.equal(socket.ttl, 255);
  assert.equal(socket.loopback, true);
  assert.equal(socket.packets.length, 1);
  assert.equal(socket.packets[0]!.address, '224.0.0.251');
  assert.equal(socket.packets[0]!.port, 5353);
  assert.equal(socket.packets[0]!.packet.readUInt16BE(6), 4);
  assert.match(socket.packets[0]!.packet.toString('utf8'), /path=\/|version=1/);
  assert.equal(socket.packets[0]!.packet.includes(Buffer.from('do-not-publish')), false);

  await discovery.stop();
  assert.equal(discovery.isStarted, false);
  assert.equal(socket.closed, true);
  assert.deepEqual(recordTtls(socket.packets[1]!.packet), [0, 0, 0, 0]);
});

test('relevant multicast queries receive DNS-SD answers and unicast-response queries stay unicast', async () => {
  const socket = new FakeMdnsSocket();
  const discovery = new MdnsDiscovery(makeConfig(), { socketFactory: () => socket });
  await discovery.start();

  socket.emitMessage(
    buildMdnsQueryPacket([{ name: '_locallink._tcp.local.', type: 12, classCode: 0x8001 }]),
    { address: '192.168.1.21', port: 9999 },
  );
  await new Promise<void>((resolve) => setImmediate(resolve));

  assert.equal(socket.packets.length, 2);
  assert.equal(socket.packets[1]!.address, '192.168.1.21');
  assert.equal(socket.packets[1]!.port, 9999);
  assert.equal(socket.packets[1]!.packet.readUInt16BE(2) & 0x8400, 0x8400);
  assert.equal(socket.packets[1]!.packet.readUInt16BE(6), 1);
  assert.equal(socket.packets[1]!.packet.readUInt16BE(8), 3);

  socket.emitMessage(
    buildMdnsQueryPacket([{ name: '_other._tcp.local.', type: 12, classCode: 1 }]),
    { address: '192.168.1.21', port: 5353 },
  );
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.equal(socket.packets.length, 2);

  await discovery.stop();
});

test('malformed queries are ignored and stop is idempotent', async () => {
  const socket = new FakeMdnsSocket();
  const discovery = new MdnsDiscovery(makeConfig(), { socketFactory: () => socket });
  await discovery.start();
  socket.emitMessage(Buffer.from([0, 1, 0]), { address: '192.168.1.21', port: 5353 });
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.equal(socket.packets.length, 1);

  await discovery.stop();
  await discovery.stop();
  assert.equal(socket.packets.length, 2);
});

test('start closes the injected socket when multicast setup fails', async () => {
  const socket = new FakeMdnsSocket();
  socket.membershipError = new Error('membership failed');
  const discovery = new MdnsDiscovery(makeConfig(), { socketFactory: () => socket });

  await assert.rejects(discovery.start(), /membership failed/i);
  assert.equal(socket.closed, true);
  assert.equal(discovery.isStarted, false);
});
