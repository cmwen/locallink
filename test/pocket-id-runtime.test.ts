import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { detectPocketIdRuntime, pocketIdStartCommand } from '../src/runtime/pocket-id-runtime';
import type { CommandResult, CommandRunner } from '../src/shared/utils';

function result(overrides: Partial<CommandResult> = {}): CommandResult {
  return { ok: true, code: 0, signal: null, stdout: '', stderr: '', timedOut: false, ...overrides };
}

test('detectPocketIdRuntime verifies persistent file-secret deployments without exposing the key', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'locallink-pocket-runtime-'));
  await fs.mkdir(path.join(root, '.locallink', 'secrets', 'pocket-id'), { recursive: true });
  await fs.writeFile(path.join(root, '.locallink', 'secrets', 'pocket-id', 'encryption-key'), 'x'.repeat(32), 'utf8');
  await fs.writeFile(path.join(root, 'docker-compose.yml'), `services:
  identity:
    image: ghcr.io/pocket-id/pocket-id:v2
    environment:
      APP_URL: \${POCKET_ID_APP_URL}
      ENCRYPTION_KEY_FILE: /run/secrets/pocket-id-encryption-key
    ports:
      - "127.0.0.1:\${POCKET_ID_PORT:-1411}:1411"
    volumes:
      - pocket-id-data:/app/data
      - ./.locallink/secrets/pocket-id/encryption-key:/run/secrets/pocket-id-encryption-key:ro
`, 'utf8');
  const calls: string[][] = [];
  const runner: CommandRunner = async (_command, args) => {
    calls.push(args);
    if (args.includes('ps')) {
      return result({ stdout: JSON.stringify({ State: 'running', Health: 'healthy' }) });
    }
    return result();
  };

  const runtime = await detectPocketIdRuntime(root, runner, {
    POCKET_ID_APP_URL: 'https://identity.tailnet.ts.net:7443',
    POCKET_ID_PORT: '1411',
  });

  assert.equal(runtime.available, true);
  assert.equal(runtime.running, true);
  assert.equal(runtime.healthy, true);
  assert.equal(runtime.configured, true);
  assert.equal(runtime.encryptionConfigured, true);
  assert.equal(runtime.encryptionSource, 'file');
  assert.equal(runtime.persistent, true);
  assert.equal(runtime.appUrl, 'https://identity.tailnet.ts.net:7443');
  assert.equal(runtime.port, '1411');
  assert.equal(runtime.detail.includes('xxxxxxxx'), false);
  assert.deepEqual(calls[0], ['compose', '--profile', '*', 'ps', '--all', '--format', 'json', 'identity']);
  assert.deepEqual(pocketIdStartCommand(runtime)?.args, ['compose', '--profile', '*', 'up', '-d', 'identity']);
});

test('detectPocketIdRuntime preserves an existing environment-key deployment and probes health', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'locallink-pocket-runtime-env-'));
  await fs.writeFile(path.join(root, 'docker-compose.yml'), `services:
  pocket-id:
    image: ghcr.io/pocket-id/pocket-id:v2
    environment:
      APP_URL: \${POCKET_ID_APP_URL}
      ENCRYPTION_KEY: \${POCKET_ID_ENCRYPTION_KEY}
    volumes:
      - pocket-id-data:/app/data
`, 'utf8');
  let healthCalls = 0;
  const runner: CommandRunner = async (_command, args) => {
    if (args.includes('ps')) return result({ stdout: JSON.stringify({ State: 'running' }) });
    if (args.includes('healthcheck')) healthCalls += 1;
    return result();
  };

  const runtime = await detectPocketIdRuntime(root, runner, {
    POCKET_ID_APP_URL: 'https://identity.tailnet.ts.net',
    POCKET_ID_ENCRYPTION_KEY: 'existing-secret-that-must-be-preserved',
  });

  assert.equal(runtime.configured, true);
  assert.equal(runtime.encryptionSource, 'environment');
  assert.equal(runtime.healthy, true);
  assert.equal(healthCalls, 1);
});
