import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { buildOtelCollectorConfig } from '../src/extensions/otel-collector-config';
import {
  createOtelLogDeliveryVerifier,
  detectOtelCollectorRuntime,
  otelCollectorStartCommand,
} from '../src/runtime/otel-collector-runtime';
import type { CommandResult, CommandRunner } from '../src/shared/utils';

function result(overrides: Partial<CommandResult> = {}): CommandResult {
  return { ok: true, code: 0, signal: null, stdout: '', stderr: '', timedOut: false, ...overrides };
}

test('detectOtelCollectorRuntime verifies a secretless three-signal workspace gateway', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'locallink-otel-runtime-'));
  await fs.mkdir(path.join(root, '.locallink'), { recursive: true });
  const accessKey = 'credential-must-not-appear-in-generated-yaml';
  const config = buildOtelCollectorConfig('openobserve');
  await fs.writeFile(path.join(root, '.locallink', 'otel-collector.yaml'), config, 'utf8');
  await fs.writeFile(path.join(root, 'docker-compose.yml'), `services:
  otel-collector:
    image: otel/opentelemetry-collector:0.157.0
    environment:
      OPENOBSERVE_ACCESS_KEY_B64: \${OPENOBSERVE_ACCESS_KEY_B64}
      OPENOBSERVE_ORGANIZATION: \${OPENOBSERVE_ORGANIZATION:-default}
      OPENOBSERVE_STREAM: \${OPENOBSERVE_STREAM:-default}
    volumes:
      - ./.locallink/otel-collector.yaml:/etc/otelcol/config.yaml:ro
    ports:
      - "127.0.0.1:\${OTEL_COLLECTOR_GRPC_PORT:-4317}:4317"
      - "127.0.0.1:\${OTEL_COLLECTOR_HTTP_PORT:-4318}:4318"
      - "127.0.0.1:\${OTEL_COLLECTOR_HEALTH_PORT:-13133}:13133"
    labels:
      locallink.provider: opentelemetry-collector
      locallink.managedBy: locallink
`, 'utf8');
  const runner: CommandRunner = async (command, args) => (
    command === 'docker' && args.includes('ps')
      ? result({ stdout: JSON.stringify({ State: 'running' }) })
      : result()
  );

  const runtime = await detectOtelCollectorRuntime(root, runner, {
    OPENOBSERVE_ACCESS_KEY_B64: accessKey,
    OPENOBSERVE_ORGANIZATION: 'default',
    OPENOBSERVE_STREAM: 'apps',
    OTEL_COLLECTOR_GRPC_PORT: '54317',
    OTEL_COLLECTOR_HTTP_PORT: '54318',
    OTEL_COLLECTOR_HEALTH_PORT: '53133',
  }, async () => ({ ok: true, status: 200 }));

  assert.equal(runtime.available, true);
  assert.equal(runtime.running, true);
  assert.equal(runtime.healthy, true);
  assert.equal(runtime.configured, true);
  assert.equal(runtime.configurationState, 'valid');
  assert.equal(runtime.credentialInjectionConfigured, true);
  assert.equal(runtime.loopbackOnly, true);
  assert.equal(runtime.grpcPort, '54317');
  assert.equal(runtime.httpPort, '54318');
  assert.equal(runtime.healthPort, '53133');
  assert.equal(runtime.httpEndpoint, 'http://127.0.0.1:54318');
  assert.doesNotMatch(config, new RegExp(accessKey));
  assert.match(config, /\$\{env:OPENOBSERVE_ACCESS_KEY_B64\}/);
  assert.deepEqual(otelCollectorStartCommand(runtime, true)?.args, [
    'compose',
    '--profile',
    '*',
    'up',
    '-d',
    '--force-recreate',
    'otel-collector',
  ]);
});

test('detectOtelCollectorRuntime does not adopt a custom or broadly bound collector', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'locallink-otel-custom-'));
  await fs.writeFile(path.join(root, 'collector.yaml'), `receivers:
  otlp:
    protocols:
      http: {}
exporters:
  debug: {}
service:
  pipelines:
    logs:
      receivers: [otlp]
      exporters: [debug]
`, 'utf8');
  await fs.writeFile(path.join(root, 'docker-compose.yml'), `services:
  telemetry:
    image: otel/opentelemetry-collector:0.157.0
    volumes:
      - ./collector.yaml:/etc/otelcol/config.yaml:ro
    ports:
      - "4318:4318"
`, 'utf8');
  const runner: CommandRunner = async () => result({ stdout: JSON.stringify({ State: 'running' }) });

  const runtime = await detectOtelCollectorRuntime(
    root,
    runner,
    {},
    async () => ({ ok: true, status: 200 }),
  );

  assert.equal(runtime.managedByLocalLink, false);
  assert.equal(runtime.configurationState, 'custom');
  assert.equal(runtime.credentialInjectionConfigured, false);
  assert.equal(runtime.loopbackOnly, false);
  assert.equal(runtime.configured, false);
});

test('verifyOtelLogDelivery sends a timestamped canary and confirms it through authenticated search', async () => {
  let canary = '';
  let timestamp = '';
  let authorization = '';
  const verify = createOtelLogDeliveryVerifier(async (url, payload, headers = {}) => {
    if (url.endsWith('/v1/logs')) {
      const record = (payload as any).resourceLogs[0].scopeLogs[0].logRecords[0];
      canary = record.body.stringValue;
      timestamp = record.timeUnixNano;
      return { ok: true, status: 200, body: '{"partialSuccess":{}}' };
    }
    authorization = String(headers.Authorization || '');
    assert.match((payload as any).query.sql, /locallink-collector-canary-/);
    return { ok: true, status: 200, body: JSON.stringify({ hits: [{ body: canary }] }) };
  });

  const verification = await verify({
    collectorHttpEndpoint: 'http://127.0.0.1:4318',
    openObserveEndpoint: 'http://127.0.0.1:5080',
    organization: 'default',
    stream: 'apps',
    username: 'root@example.com',
    password: 'not-printed',
    workspaceId: 'workspace-test',
  });

  assert.equal(verification.ok, true);
  assert.equal(verification.receiverAccepted, true);
  assert.equal(verification.backendConfirmed, true);
  assert.match(canary, /^locallink-collector-canary-[a-f0-9]{24}$/);
  assert.ok(BigInt(timestamp) > 0n);
  assert.equal(
    authorization,
    `Basic ${Buffer.from('root@example.com:not-printed').toString('base64')}`,
  );
});
