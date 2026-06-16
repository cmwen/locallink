import assert from 'node:assert/strict';
import net from 'node:net';
import test from 'node:test';

import { PortAllocator } from '../src/ports/allocator';

async function canListen(host: string): Promise<boolean> {
  const server = net.createServer();
  return new Promise((resolve, reject) => {
    server.once('error', (error: NodeJS.ErrnoException) => {
      if (error.code === 'EPERM' || error.code === 'EACCES') {
        resolve(false);
        return;
      }
      reject(error);
    });
    server.listen(0, host, () => {
      server.close((error) => (error ? reject(error) : resolve(true)));
    });
  });
}

test('PortAllocator skips ports that are already bound', async (t) => {
  if (!(await canListen('127.0.0.1')) || !(await canListen('0.0.0.0'))) {
    t.skip('local port binding is unavailable in this environment');
    return;
  }

  const blocker = net.createServer();
  await new Promise<void>((resolve) => {
    blocker.listen(0, '127.0.0.1', () => resolve());
  });

  const address = blocker.address();
  assert.ok(address && typeof address === 'object');
  const busyPort = address.port;

  const allocator = new PortAllocator();
  const result = await allocator.findNextAvailablePort(busyPort);

  assert.equal(result.startFrom, busyPort);
  assert.equal(result.busy[0], busyPort);
  assert.ok(result.nextFree > busyPort);

  await new Promise<void>((resolve, reject) => {
    blocker.close((error) => (error ? reject(error) : resolve()));
  });
});
