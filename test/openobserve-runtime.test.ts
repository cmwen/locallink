import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import {
  detectOpenObserveRuntime,
  openObserveStartCommand,
  type OpenObserveHttpProbe,
} from '../src/runtime/openobserve-runtime';
import type { CommandResult, CommandRunner } from '../src/shared/utils';

function result(overrides: Partial<CommandResult> = {}): CommandResult {
  return { ok: true, code: 0, signal: null, stdout: '', stderr: '', timedOut: false, ...overrides };
}

test('detectOpenObserveRuntime verifies health, persistence, loopback binding, and credentials without exposing secrets', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'locallink-openobserve-runtime-'));
  await fs.writeFile(path.join(root, 'docker-compose.yml'), `services:
  telemetry:
    image: public.ecr.aws/zinclabs/openobserve:v0.90.3
    environment:
      ZO_ROOT_USER_EMAIL: \${OPENOBSERVE_USERNAME}
      ZO_ROOT_USER_PASSWORD: \${OPENOBSERVE_PASSWORD}
      ZO_DATA_DIR: /data
    ports:
      - "127.0.0.1:\${OPENOBSERVE_PORT:-5080}:5080"
    volumes:
      - openobserve-data:/data
`, 'utf8');
  const runner: CommandRunner = async () => result({
    stdout: JSON.stringify({ State: 'running' }),
  });
  const probes: Array<{ url: string; authorization?: string }> = [];
  const probe: OpenObserveHttpProbe = async (url, authorization) => {
    probes.push({ url, authorization });
    return { ok: true, status: 200 };
  };

  const runtime = await detectOpenObserveRuntime(root, runner, {
    OPENOBSERVE_PORT: '5510',
    OPENOBSERVE_USERNAME: 'root@local.test',
    OPENOBSERVE_PASSWORD: 'secret-that-must-not-leak',
    OPENOBSERVE_ORGANIZATION: 'local',
    OPENOBSERVE_STREAM: 'apps',
  }, probe);

  assert.equal(runtime.available, true);
  assert.equal(runtime.running, true);
  assert.equal(runtime.healthy, true);
  assert.equal(runtime.configured, true);
  assert.equal(runtime.persistent, true);
  assert.equal(runtime.loopbackOnly, true);
  assert.equal(runtime.credentialState, 'valid');
  assert.equal(runtime.port, '5510');
  assert.equal(runtime.endpoint, 'http://127.0.0.1:5510');
  assert.equal(runtime.otlpBaseUrl, 'http://127.0.0.1:5510/api/local');
  assert.equal(runtime.detail.includes('secret-that-must-not-leak'), false);
  assert.equal(probes[0]?.url, 'http://127.0.0.1:5510/healthz');
  assert.match(probes[1]?.authorization || '', /^Basic /);
  assert.deepEqual(openObserveStartCommand(runtime)?.args, ['compose', '--profile', '*', 'up', '-d', 'telemetry']);
});

test('detectOpenObserveRuntime distinguishes stale credentials from unhealthy or missing state', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'locallink-openobserve-runtime-stale-'));
  await fs.writeFile(path.join(root, 'docker-compose.yml'), `services:
  openobserve:
    image: openobserve/openobserve:v0.91.1
    environment:
      ZO_ROOT_USER_EMAIL: \${OPENOBSERVE_USERNAME}
      ZO_ROOT_USER_PASSWORD: \${OPENOBSERVE_PASSWORD}
      ZO_DATA_DIR: /data/openobserve
    ports:
      - "\${OPENOBSERVE_PORT}:5080"
    volumes:
      - openobserve-data:/data/openobserve
`, 'utf8');
  const runner: CommandRunner = async () => result({
    stdout: JSON.stringify({ State: 'running', Health: 'healthy' }),
  });
  const probe: OpenObserveHttpProbe = async (_url, authorization) => (
    authorization ? { ok: false, status: 401 } : { ok: true, status: 200 }
  );

  const runtime = await detectOpenObserveRuntime(root, runner, {
    OPENOBSERVE_PORT: '5080',
    OPENOBSERVE_USERNAME: 'root@example.com',
    OPENOBSERVE_PASSWORD: 'stale-password',
  }, probe);

  assert.equal(runtime.healthy, true);
  assert.equal(runtime.persistent, true);
  assert.equal(runtime.loopbackOnly, false);
  assert.equal(runtime.credentialState, 'invalid');
  assert.match(runtime.detail, /existing data was not changed/i);
});
