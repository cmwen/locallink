import dgram from 'node:dgram';
import net from 'node:net';
import os from 'node:os';

import { AppError } from '../shared/errors';

export const MDNS_IPV4_ADDRESS = '224.0.0.251';
export const MDNS_PORT = 5353;
export const MDNS_LOCAL_DOMAIN = 'local.';

const IN_CLASS = 0x0001;
const CACHE_FLUSH_CLASS = 0x8001;
const DNS_TYPE_A = 0x0001;
const DNS_TYPE_PTR = 0x000c;
const DNS_TYPE_TXT = 0x0010;
const DNS_TYPE_AAAA = 0x001c;
const DNS_TYPE_SRV = 0x0021;
const DNS_TYPE_ANY = 0x00ff;
const MAX_DNS_LABEL_BYTES = 63;
const MAX_DNS_PACKET_BYTES = 9000;
const SECRET_TEXT_PATTERN = /(password|passwd|secret|token|api[-_]?key|access[-_]?key|private[-_]?key|authorization|cookie|credential|bearer)/i;

type DnsRecordType = 'A' | 'AAAA' | 'PTR' | 'SRV' | 'TXT';

export type MdnsTxtValue = string | number | boolean;

export interface MdnsDiscoveryConfig {
  /** A single safe host label, for example `laptop.local`. */
  hostname: string;
  /** The DNS-SD instance label, for example `LocalLink Dashboard`. */
  serviceInstance: string;
  /** A service type such as `_locallink._tcp.local`. */
  serviceType: string;
  port: number;
  /** Optional explicit host addresses. If omitted, non-internal local interfaces are used. */
  addresses?: readonly string[];
  /** Public metadata only. Secret-like keys and values are rejected. */
  publicTxt?: Readonly<Record<string, MdnsTxtValue>>;
  ttl?: number;
}

export interface NormalizedMdnsDiscoveryConfig {
  hostname: string;
  hostnameFqdn: string;
  serviceInstance: string;
  serviceInstanceFqdn: string;
  serviceType: string;
  port: number;
  addresses?: readonly string[];
  publicTxt: readonly string[];
  ttl: number;
}

export interface MdnsMessageInfo {
  address: string;
  port: number;
  family?: string;
  size?: number;
}

export interface MdnsSocket {
  on(event: 'message', listener: (message: Buffer, rinfo: MdnsMessageInfo) => void): this;
  on(event: 'error', listener: (error: Error) => void): this;
  bind(port: number, address: string, callback?: () => void): this;
  addMembership(multicastAddress: string, interfaceAddress?: string): void;
  dropMembership?(multicastAddress: string, interfaceAddress?: string): void;
  setMulticastTTL(ttl: number): void;
  setMulticastLoopback(loopback: boolean): void;
  send(
    message: Uint8Array,
    offset: number,
    length: number,
    port: number,
    address: string,
    callback?: (error?: Error) => void,
  ): void;
  close(callback?: () => void): void;
}

export type MdnsSocketFactory = () => MdnsSocket;
export type MdnsAddressProvider = () => readonly string[] | Promise<readonly string[]>;

export interface MdnsDiscoveryOptions {
  socketFactory?: MdnsSocketFactory;
  addressProvider?: MdnsAddressProvider;
  multicastAddress?: string;
  multicastPort?: number;
  interfaceAddress?: string;
  onError?: (error: Error) => void;
}

export interface MdnsQuestion {
  name: string;
  type: number;
  classCode: number;
  unicastResponse: boolean;
}

interface DnsRecord {
  name: string;
  type: DnsRecordType;
  classCode: number;
  ttl: number;
  data: string | number | readonly string[] | { target: string; port: number };
}

interface EncodedResponse {
  answers: readonly DnsRecord[];
  additionals: readonly DnsRecord[];
}

interface ReadNameResult {
  name: string;
  nextOffset: number;
}

function appError(code: string, message: string): AppError {
  return new AppError(code, message, 400);
}

function canonicalFqdn(value: string): string {
  return value.endsWith('.') ? value : `${value}.`;
}

function validateDnsLabel(value: string, field: string, pattern: RegExp): string {
  if (!value || Buffer.byteLength(value, 'utf8') > MAX_DNS_LABEL_BYTES || !pattern.test(value)) {
    throw appError('INVALID_MDNS_NAME', `${field} must be a safe DNS label of at most 63 bytes.`);
  }
  return value;
}

function normalizeHostname(value: string): { hostname: string; hostnameFqdn: string } {
  const candidate = value.trim().replace(/\.$/, '');
  const labels = candidate.split('.');
  if (labels.length !== 2 || labels[1]?.toLowerCase() !== 'local') {
    throw appError('INVALID_MDNS_HOSTNAME', 'hostname must be a single safe label ending in .local.');
  }
  const hostname = validateDnsLabel(labels[0]!, 'hostname', /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?$/);
  return { hostname, hostnameFqdn: `${hostname}.local.` };
}

function normalizeServiceType(value: string): string {
  const candidate = value.trim().replace(/\.$/, '').toLowerCase();
  const match = /^(?:_)([a-z0-9](?:[a-z0-9-]{0,13}[a-z0-9])?)\._(tcp|udp)\.local$/.exec(candidate);
  if (!match) {
    throw appError('INVALID_MDNS_SERVICE_TYPE', 'serviceType must look like _service._tcp.local or _service._udp.local.');
  }
  return `_${match[1]}._${match[2]}.local.`;
}

function normalizeServiceInstance(value: string): string {
  return validateDnsLabel(
    value.trim(),
    'serviceInstance',
    /^[A-Za-z0-9](?:[A-Za-z0-9 _-]{0,61}[A-Za-z0-9])?$/,
  );
}

function normalizeAddress(value: string): string {
  const address = value.trim().replace(/%.+$/, '');
  const family = net.isIP(address);
  if (family !== 4 && family !== 6) throw appError('INVALID_MDNS_ADDRESS', `Invalid host address "${value}".`);
  return address;
}

function normalizeTxt(publicTxt: Readonly<Record<string, MdnsTxtValue>> | undefined): readonly string[] {
  if (!publicTxt) return [];
  return Object.entries(publicTxt).map(([key, rawValue]) => {
    if (
      !/^[A-Za-z0-9][A-Za-z0-9._-]{0,62}$/.test(key)
      || SECRET_TEXT_PATTERN.test(key)
    ) {
      throw appError('INVALID_MDNS_TXT', `TXT key "${key}" is not safe public metadata.`);
    }
    const value = typeof rawValue === 'boolean' ? (rawValue ? '' : 'false') : String(rawValue);
    if (/[^\x20-\x7e]/.test(value) || SECRET_TEXT_PATTERN.test(value)) {
      throw appError('INVALID_MDNS_TXT', `TXT value for "${key}" is not safe public metadata.`);
    }
    const entry = value ? `${key}=${value}` : key;
    if (Buffer.byteLength(entry, 'utf8') > 255) {
      throw appError('INVALID_MDNS_TXT', `TXT value for "${key}" exceeds 255 bytes.`);
    }
    return entry;
  });
}

function normalizePort(value: number): number {
  if (!Number.isInteger(value) || value < 1 || value > 65535) {
    throw appError('INVALID_MDNS_PORT', 'port must be an integer from 1 through 65535.');
  }
  return value;
}

export function normalizeMdnsDiscoveryConfig(config: MdnsDiscoveryConfig): NormalizedMdnsDiscoveryConfig {
  const { hostname, hostnameFqdn } = normalizeHostname(config.hostname);
  const serviceType = normalizeServiceType(config.serviceType);
  const serviceInstance = normalizeServiceInstance(config.serviceInstance);
  const ttl = config.ttl ?? 120;
  if (!Number.isInteger(ttl) || ttl < 1 || ttl > 86400) {
    throw appError('INVALID_MDNS_TTL', 'ttl must be an integer from 1 through 86400.');
  }
  const addresses = config.addresses?.map(normalizeAddress);
  return {
    hostname,
    hostnameFqdn,
    serviceInstance,
    serviceInstanceFqdn: `${serviceInstance}.${serviceType}`,
    serviceType,
    port: normalizePort(config.port),
    addresses,
    publicTxt: normalizeTxt(config.publicTxt),
    ttl,
  };
}

function localInterfaceAddresses(): readonly string[] {
  return Object.values(os.networkInterfaces())
    .flatMap((entries) => entries ?? [])
    .filter((entry) => !entry.internal && (entry.family === 'IPv4' || String(entry.family) === '4'))
    .map((entry) => entry.address)
    .filter((address, index, all) => all.indexOf(address) === index);
}

function encodeName(name: string): Buffer {
  const labels = name === '.' ? [] : canonicalFqdn(name).slice(0, -1).split('.');
  const chunks: Buffer[] = [];
  for (const label of labels) {
    const bytes = Buffer.from(label, 'utf8');
    if (bytes.length > MAX_DNS_LABEL_BYTES) throw new Error('DNS label exceeds 63 bytes.');
    chunks.push(Buffer.from([bytes.length]), bytes);
  }
  chunks.push(Buffer.from([0]));
  return Buffer.concat(chunks);
}

function decodeIpv4(address: string): Buffer {
  const parts = address.split('.').map(Number);
  if (parts.length !== 4 || parts.some((part) => !Number.isInteger(part) || part < 0 || part > 255)) {
    throw new Error(`Invalid IPv4 address "${address}".`);
  }
  return Buffer.from(parts);
}

function decodeIpv6(address: string): Buffer {
  const withoutScope = address.replace(/%.+$/, '').toLowerCase();
  const [left, right, ...extra] = withoutScope.split('::');
  if (extra.length > 0) throw new Error(`Invalid IPv6 address "${address}".`);
  const expandPart = (part: string): string[] => {
    if (!part) return [];
    const groups = part.split(':');
    const last = groups.at(-1);
    if (last?.includes('.')) {
      const ipv4 = decodeIpv4(last);
      groups.splice(-1, 1, ipv4.subarray(0, 2).toString('hex'), ipv4.subarray(2, 4).toString('hex'));
    }
    if (groups.some((group) => !/^[0-9a-f]{1,4}$/.test(group))) throw new Error(`Invalid IPv6 address "${address}".`);
    return groups;
  };
  const leftGroups = expandPart(left);
  const rightGroups = expandPart(right);
  const missing = 8 - leftGroups.length - rightGroups.length;
  if ((withoutScope.includes('::') && missing < 1) || (!withoutScope.includes('::') && missing !== 0)) {
    throw new Error(`Invalid IPv6 address "${address}".`);
  }
  const groups = [...leftGroups, ...Array.from({ length: missing }, () => '0'), ...rightGroups];
  const output = Buffer.alloc(16);
  groups.forEach((group, index) => output.writeUInt16BE(parseInt(group, 16), index * 2));
  return output;
}

function encodeAddress(address: string): Buffer {
  return net.isIP(address) === 4 ? decodeIpv4(address) : decodeIpv6(address);
}

function recordData(record: DnsRecord): Buffer {
  if (record.type === 'A' || record.type === 'AAAA') return encodeAddress(String(record.data));
  if (record.type === 'PTR') return encodeName(String(record.data));
  if (record.type === 'SRV') {
    const data = record.data as unknown as { target: string; port: number };
    const header = Buffer.alloc(6);
    header.writeUInt16BE(0, 0);
    header.writeUInt16BE(0, 2);
    header.writeUInt16BE(data.port, 4);
    return Buffer.concat([header, encodeName(data.target)]);
  }
  const entries = record.data as readonly string[];
  return Buffer.concat(entries.map((entry) => {
    const bytes = Buffer.from(entry, 'utf8');
    if (bytes.length > 255) throw new Error('DNS TXT entry exceeds 255 bytes.');
    return Buffer.concat([Buffer.from([bytes.length]), bytes]);
  }));
}

function hostRecords(config: NormalizedMdnsDiscoveryConfig, ttl = config.ttl): DnsRecord[] {
  return (config.addresses ?? []).map((address) => ({
    name: config.hostnameFqdn,
    type: net.isIP(address) === 4 ? 'A' : 'AAAA',
    classCode: CACHE_FLUSH_CLASS,
    ttl,
    data: address,
  }));
}

function serviceRecords(config: NormalizedMdnsDiscoveryConfig, ttl = config.ttl): DnsRecord[] {
  return [
    { name: config.serviceType, type: 'PTR', classCode: IN_CLASS, ttl, data: config.serviceInstanceFqdn },
    {
      name: config.serviceInstanceFqdn,
      type: 'SRV',
      classCode: CACHE_FLUSH_CLASS,
      ttl,
      data: { target: config.hostnameFqdn, port: config.port },
    },
    {
      name: config.serviceInstanceFqdn,
      type: 'TXT',
      classCode: CACHE_FLUSH_CLASS,
      ttl,
      data: config.publicTxt.length > 0 ? config.publicTxt : [''],
    },
  ];
}

function allRecords(config: NormalizedMdnsDiscoveryConfig, ttl = config.ttl): DnsRecord[] {
  return [...serviceRecords(config, ttl), ...hostRecords(config, ttl)];
}

function encodeRecord(record: DnsRecord): Buffer {
  const name = encodeName(record.name);
  const data = recordData(record);
  const header = Buffer.alloc(10);
  header.writeUInt16BE(record.type === 'A' ? DNS_TYPE_A : record.type === 'AAAA' ? DNS_TYPE_AAAA : record.type === 'PTR' ? DNS_TYPE_PTR : record.type === 'TXT' ? DNS_TYPE_TXT : DNS_TYPE_SRV, 0);
  header.writeUInt16BE(record.classCode, 2);
  header.writeUInt32BE(record.ttl, 4);
  header.writeUInt16BE(data.length, 8);
  return Buffer.concat([name, header, data]);
}

function encodeResponse(response: EncodedResponse): Buffer {
  const answers = [...response.answers, ...response.additionals];
  const header = Buffer.alloc(12);
  header.writeUInt16BE(0, 0);
  header.writeUInt16BE(0x8400, 2);
  header.writeUInt16BE(0, 4);
  header.writeUInt16BE(response.answers.length, 6);
  header.writeUInt16BE(response.additionals.length, 8);
  header.writeUInt16BE(0, 10);
  const packet = Buffer.concat([header, ...answers.map(encodeRecord)]);
  if (packet.length > MAX_DNS_PACKET_BYTES) throw new Error('mDNS response exceeds the safe packet size.');
  return packet;
}

export function buildMdnsQueryPacket(questions: readonly Pick<MdnsQuestion, 'name' | 'type' | 'classCode'>[]): Buffer {
  const header = Buffer.alloc(12);
  header.writeUInt16BE(0, 0);
  header.writeUInt16BE(0, 2);
  header.writeUInt16BE(questions.length, 4);
  const chunks: Buffer[] = [header];
  for (const question of questions) {
    const questionHeader = Buffer.alloc(4);
    questionHeader.writeUInt16BE(question.type, 0);
    questionHeader.writeUInt16BE(question.classCode, 2);
    chunks.push(encodeName(question.name), questionHeader);
  }
  return Buffer.concat(chunks);
}

function readName(message: Buffer, startOffset: number): ReadNameResult {
  let offset = startOffset;
  let nextOffset = startOffset;
  let jumped = false;
  const labels: string[] = [];
  const visited = new Set<number>();
  for (let depth = 0; depth < 128; depth += 1) {
    if (offset >= message.length) throw new Error('Truncated DNS name.');
    const length = message[offset]!;
    if ((length & 0xc0) === 0xc0) {
      if (offset + 1 >= message.length) throw new Error('Truncated DNS name pointer.');
      const pointer = ((length & 0x3f) << 8) | message[offset + 1]!;
      if (visited.has(pointer)) throw new Error('DNS name pointer loop.');
      visited.add(pointer);
      if (!jumped) nextOffset = offset + 2;
      offset = pointer;
      jumped = true;
      continue;
    }
    if ((length & 0xc0) !== 0 || length > MAX_DNS_LABEL_BYTES) throw new Error('Invalid DNS name label.');
    offset += 1;
    if (length === 0) {
      if (!jumped) nextOffset = offset;
      return { name: labels.length > 0 ? `${labels.join('.')}.` : '.', nextOffset };
    }
    if (offset + length > message.length) throw new Error('Truncated DNS name label.');
    labels.push(message.subarray(offset, offset + length).toString('utf8'));
    offset += length;
    if (!jumped) nextOffset = offset;
  }
  throw new Error('DNS name is too deeply compressed.');
}

export function parseMdnsQuestions(message: Uint8Array): MdnsQuestion[] {
  const packet = Buffer.from(message);
  if (packet.length < 12) throw new Error('Truncated DNS header.');
  const flags = packet.readUInt16BE(2);
  if ((flags & 0x8000) !== 0 || ((flags >>> 11) & 0x0f) !== 0) return [];
  const count = packet.readUInt16BE(4);
  if (count > 64) throw new Error('DNS question count is too large.');
  const questions: MdnsQuestion[] = [];
  let offset = 12;
  for (let index = 0; index < count; index += 1) {
    const name = readName(packet, offset);
    offset = name.nextOffset;
    if (offset + 4 > packet.length) throw new Error('Truncated DNS question.');
    const type = packet.readUInt16BE(offset);
    const rawClass = packet.readUInt16BE(offset + 2);
    offset += 4;
    questions.push({ name: name.name.toLowerCase(), type, classCode: rawClass & 0x7fff, unicastResponse: (rawClass & 0x8000) !== 0 });
  }
  return questions;
}

function recordTypeCode(type: DnsRecordType): number {
  return type === 'A' ? DNS_TYPE_A : type === 'AAAA' ? DNS_TYPE_AAAA : type === 'PTR' ? DNS_TYPE_PTR : type === 'TXT' ? DNS_TYPE_TXT : DNS_TYPE_SRV;
}

function matchesQuestion(record: DnsRecord, question: MdnsQuestion): boolean {
  return record.name.toLowerCase() === question.name
    && (question.type === DNS_TYPE_ANY || question.type === recordTypeCode(record.type))
    && (question.classCode === 0 || question.classCode === IN_CLASS || question.classCode === DNS_TYPE_ANY);
}

function queryResponse(config: NormalizedMdnsDiscoveryConfig, questions: readonly MdnsQuestion[]): { response: EncodedResponse; unicast: boolean } | undefined {
  const records = allRecords(config);
  const answers = records.filter((record) => questions.some((question) => matchesQuestion(record, question)));
  if (answers.length === 0) return undefined;
  const answerKeys = new Set(answers.map((record) => `${record.name}|${record.type}`));
  const additionals = records.filter((record) => !answerKeys.has(`${record.name}|${record.type}`) && (
    answers.some((answer) => answer.type === 'PTR' || answer.type === 'SRV' || answer.type === 'TXT')
  ));
  return {
    response: { answers, additionals },
    unicast: questions.some((question) => question.unicastResponse),
  };
}

function defaultSocketFactory(): MdnsSocket {
  return dgram.createSocket({ type: 'udp4', reuseAddr: true }) as unknown as MdnsSocket;
}

export class MdnsDiscovery {
  private readonly config: NormalizedMdnsDiscoveryConfig;
  private readonly socketFactory: MdnsSocketFactory;
  private readonly addressProvider: MdnsAddressProvider;
  private readonly multicastAddress: string;
  private readonly multicastPort: number;
  private readonly interfaceAddress?: string;
  private readonly onError?: (error: Error) => void;
  private socket?: MdnsSocket;
  private started = false;
  private bound = false;
  private bindReject?: (error: Error) => void;

  constructor(config: MdnsDiscoveryConfig, options: MdnsDiscoveryOptions = {}) {
    this.config = normalizeMdnsDiscoveryConfig(config);
    this.socketFactory = options.socketFactory ?? defaultSocketFactory;
    this.addressProvider = options.addressProvider ?? localInterfaceAddresses;
    this.multicastAddress = options.multicastAddress ?? MDNS_IPV4_ADDRESS;
    this.multicastPort = options.multicastPort ?? MDNS_PORT;
    this.interfaceAddress = options.interfaceAddress;
    this.onError = options.onError;
    if (net.isIP(this.multicastAddress) !== 4 || this.multicastPort < 1 || this.multicastPort > 65535) {
      throw appError('INVALID_MDNS_TRANSPORT', 'mDNS transport must use a valid IPv4 multicast address and port.');
    }
  }

  get normalizedConfig(): NormalizedMdnsDiscoveryConfig {
    return this.config;
  }

  get isStarted(): boolean {
    return this.started;
  }

  async start(): Promise<void> {
    if (this.started) return;
    const addresses = this.config.addresses ?? await this.addressProvider();
    if (addresses.length === 0) throw appError('MDNS_NO_HOST_ADDRESSES', 'mDNS discovery requires at least one non-internal host address.');
    this.config.addresses = addresses.map(normalizeAddress);
    const socket = this.socketFactory();
    this.socket = socket;
    socket.on('message', (message, rinfo) => {
      void this.handleMessage(message, rinfo).catch((error: unknown) => this.reportError(error));
    });
    socket.on('error', (error) => {
      if (!this.bound) this.bindReject?.(error);
      else this.reportError(error);
    });
    try {
      await new Promise<void>((resolve, reject) => {
        this.bindReject = reject;
        socket.bind(this.multicastPort, '0.0.0.0', () => {
          this.bound = true;
          this.bindReject = undefined;
          resolve();
        });
      });
      socket.setMulticastTTL(255);
      socket.setMulticastLoopback(true);
      socket.addMembership(this.multicastAddress, this.interfaceAddress);
      this.started = true;
      await this.sendRecords(allRecords(this.config), this.multicastAddress, this.multicastPort);
    } catch (error) {
      this.bindReject = undefined;
      this.started = false;
      await this.closeSocket();
      throw error;
    }
  }

  async stop(): Promise<void> {
    const socket = this.socket;
    if (!socket) return;
    let failure: unknown;
    if (this.started && this.bound) {
      try {
        await this.sendRecords(allRecords(this.config, 0), this.multicastAddress, this.multicastPort);
      } catch (error) {
        failure = error;
      }
    }
    this.started = false;
    await this.closeSocket();
    if (failure) throw failure;
  }

  private async handleMessage(message: Buffer, rinfo: MdnsMessageInfo): Promise<void> {
    if (!this.started) return;
    let questions: MdnsQuestion[];
    try {
      questions = parseMdnsQuestions(message);
    } catch {
      return;
    }
    if (questions.length === 0) return;
    const response = queryResponse(this.config, questions);
    if (!response) return;
    const useUnicast = response.unicast && rinfo.port > 0 && Boolean(rinfo.address);
    await this.sendRecords(
      [...response.response.answers, ...response.response.additionals],
      useUnicast ? rinfo.address : this.multicastAddress,
      useUnicast ? rinfo.port : this.multicastPort,
      response.response.answers.length,
    );
  }

  private async sendRecords(records: readonly DnsRecord[], address: string, port: number, answerCount?: number): Promise<void> {
    const split = answerCount === undefined ? records.length : answerCount;
    const packet = encodeResponse({ answers: records.slice(0, split), additionals: records.slice(split) });
    const socket = this.socket;
    if (!socket) throw new Error('mDNS socket is not available.');
    await new Promise<void>((resolve, reject) => {
      socket.send(packet, 0, packet.length, port, address, (error) => error ? reject(error) : resolve());
    });
  }

  private async closeSocket(): Promise<void> {
    const socket = this.socket;
    this.socket = undefined;
    this.bound = false;
    this.bindReject = undefined;
    if (!socket) return;
    try {
      socket.dropMembership?.(this.multicastAddress, this.interfaceAddress);
    } catch {
      // Socket close is still the authoritative lifecycle operation.
    }
    await new Promise<void>((resolve) => socket.close(resolve));
  }

  private reportError(error: unknown): void {
    const normalized = error instanceof Error ? error : new Error(String(error));
    this.onError?.(normalized);
  }
}
