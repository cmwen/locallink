import assert from 'node:assert/strict';
import test from 'node:test';

import { normalizeLoopbackBindHost } from '../src/shared/network';

test('normalizeLoopbackBindHost only allows loopback hosts', () => {
  assert.equal(normalizeLoopbackBindHost('127.0.0.1'), '127.0.0.1');
  assert.equal(normalizeLoopbackBindHost('localhost'), 'localhost');
  assert.equal(normalizeLoopbackBindHost('::1'), '::1');
  assert.equal(normalizeLoopbackBindHost('0.0.0.0'), '127.0.0.1');
  assert.equal(normalizeLoopbackBindHost('192.168.1.20'), '127.0.0.1');
  assert.equal(normalizeLoopbackBindHost(undefined), '127.0.0.1');
});
