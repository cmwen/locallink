import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { parseDocument } from 'yaml';

import { ConfigRepository } from '../src/config/files';
import {
  findAdoptableOpenObserveRoute,
  ObservabilityPlanner,
} from '../src/extensions/observability-planner';
import { ExtensionPlanner } from '../src/extensions/planner';
import { PortAllocator } from '../src/ports/allocator';
import type { OpenObserveHttpProbe, OpenObserveRuntimeDetection } from '../src/runtime/openobserve-runtime';
import type { CommandResult, CommandRunner } from '../src/shared/utils';
import { WorkspaceStateRepository } from '../src/state/workspace-state';

function result(overrides: Partial<CommandResult> = {}): CommandResult {
  return { ok: true, code: 0, signal: null, stdout: '', stderr: '', timedOut: false, ...overrides };
}

class FixedPortAllocator extends PortAllocator {
  override async findNextAvailablePort(startFrom = 5000) {
    return { startFrom, nextFree: startFrom === 5080 ? 5508 : startFrom, busy: startFrom === 5080 ? [5080] : [] };
  }
}

async function createWorkspace(): Promise<string> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'locallink-observability-plan-'));
  await fs.writeFile(path.join(root, '.env'), [
    'LOCALLINK_WORKSPACE_ID=observability-test',
    'LOCALLINK_PRIVATE_EDGE_PORT_START=27510',
    'API_PORT=5000',
    '',
  ].join('\n'), 'utf8');
  await fs.writeFile(path.join(root, '.env.example'), 'API_PORT=5000\nOPENOBSERVE_TOKEN=\n', 'utf8');
  await fs.writeFile(path.join(root, 'docker-compose.yml'), `services:
  api:
    image: example/api:latest
    ports:
      - "\${API_PORT}:5000"
    labels:
      locallink.name: API
      locallink.portEnv: API_PORT
`, 'utf8');
  await fs.writeFile(path.join(root, 'locallink.extensions.yml'), `extensions:
  - id: tailscale
    name: Private Edge
    kind: network-edge
    enabled: true
    command: tailscale
    exposedPorts:
      - "5000"
`, 'utf8');
  return root;
}

test('Observability apply installs OpenObserve on a free workspace port, generates local credentials, and preserves edge selections', async () => {
  const root = await createWorkspace();
  let openObserveRunning = false;
  let collectorRunning = false;
  const actions: string[] = [];
  const runner: CommandRunner = async (command, args) => {
    if (command === 'tailscale' && args[0] === 'status') {
      return result({ stdout: JSON.stringify({ BackendState: 'Running', Self: { DNSName: 'telemetry.tailnet.ts.net.' } }) });
    }
    if (command === 'tailscale' && args[0] === 'serve') return result({ stdout: '{}' });
    if (command === 'docker' && args.includes('ps')) {
      return result({
        stdout: args.at(-1) === 'openobserve' && openObserveRunning
          ? JSON.stringify({ State: 'running' })
          : args.at(-1) === 'otel-collector' && collectorRunning
            ? JSON.stringify({ State: 'running' })
            : '',
      });
    }
    if (command === 'docker' && args.includes('up')) {
      if (args.at(-1) === 'openobserve') openObserveRunning = true;
      if (args.at(-1) === 'otel-collector') collectorRunning = true;
      actions.push(`up:${args.at(-1)}`);
      return result();
    }
    return result();
  };
  const probe: OpenObserveHttpProbe = async (_url, authorization) => (
    authorization ? { ok: true, status: 200 } : { ok: true, status: 200 }
  );
  const repository = new ConfigRepository(root);
  const state = new WorkspaceStateRepository(path.join(root, '.locallink', 'workspace-state.json'));
  await state.load();
  const edge = new ExtensionPlanner(root, repository, runner, state);
  const planner = new ObservabilityPlanner(
    root,
    repository,
    runner,
    state,
    edge,
    new FixedPortAllocator(),
    probe,
    async () => ({ ok: true, status: 200 }),
    async () => ({
      ok: true,
      receiverAccepted: true,
      backendConfirmed: true,
      verifiedAt: '2026-07-25T14:30:00.000Z',
      detail: 'verified',
    }),
  );

  const preview = await planner.plan('observability');
  assert.equal(preview.canApply, true);
  assert.equal(preview.service.port, '5508');
  assert.equal(preview.service.installed, false);

  const applied = await planner.apply('observability');
  assert.equal(applied.applied, true);
  assert.equal(applied.started, true);
  assert.deepEqual(actions, ['up:openobserve', 'up:otel-collector']);
  assert.equal(applied.plan.service.healthy, true);
  assert.equal(applied.plan.service.credentialState, 'valid');
  assert.equal(applied.plan.service.loopbackOnly, true);
  assert.equal(applied.plan.collector.healthy, true);
  assert.equal(applied.plan.collector.configured, true);
  assert.equal(applied.plan.collector.loopbackOnly, true);
  assert.equal(applied.plan.collector.deliveryVerified, true);
  assert.equal(applied.verification?.backendConfirmed, true);
  assert.equal(applied.plan.telemetry.receiverHttpEndpoint, 'http://127.0.0.1:4318');
  assert.equal(applied.plan.state, 'ready-to-route');

  const compose = parseDocument(await fs.readFile(path.join(root, 'docker-compose.yml'), 'utf8')).toJS() as any;
  assert.equal(compose.services.openobserve.image, 'public.ecr.aws/zinclabs/openobserve:v0.90.3');
  assert.equal(compose.services.openobserve.ports[0], '127.0.0.1:${OPENOBSERVE_PORT:-5080}:5080');
  assert.equal(compose.services.openobserve.environment.ZO_ROOT_USER_PASSWORD, '${OPENOBSERVE_PASSWORD}');
  assert.ok(compose.services.openobserve.volumes.includes('openobserve-data:/data'));
  assert.ok(compose.volumes['openobserve-data']);
  assert.equal(compose.services['otel-collector'].image, 'otel/opentelemetry-collector:0.157.0');
  assert.deepEqual(compose.services['otel-collector'].ports, [
    '127.0.0.1:${OTEL_COLLECTOR_GRPC_PORT:-4317}:4317',
    '127.0.0.1:${OTEL_COLLECTOR_HTTP_PORT:-4318}:4318',
    '127.0.0.1:${OTEL_COLLECTOR_HEALTH_PORT:-13133}:13133',
  ]);
  assert.equal(
    compose.services['otel-collector'].environment.OPENOBSERVE_ACCESS_KEY_B64,
    '${OPENOBSERVE_ACCESS_KEY_B64}',
  );

  const env = await fs.readFile(path.join(root, '.env'), 'utf8');
  assert.match(env, /^OPENOBSERVE_PORT=5508$/m);
  assert.match(env, /^OPENOBSERVE_PASSWORD=.+$/m);
  assert.match(env, /^OPENOBSERVE_ACCESS_KEY_B64=.+$/m);
  assert.match(env, /^OPENOBSERVE_OTLP_BASE_URL=http:\/\/127\.0\.0\.1:5508\/api\/default$/m);
  assert.match(env, /^OTEL_COLLECTOR_GRPC_PORT=4317$/m);
  assert.match(env, /^OTEL_COLLECTOR_HTTP_PORT=4318$/m);
  assert.match(env, /^OTEL_EXPORTER_OTLP_ENDPOINT=http:\/\/127\.0\.0\.1:4318$/m);
  assert.match(env, /^OTEL_EXPORTER_OTLP_PROTOCOL=http\/protobuf$/m);
  assert.equal((await fs.stat(path.join(root, '.env'))).mode & 0o777, 0o600);
  const example = await fs.readFile(path.join(root, '.env.example'), 'utf8');
  assert.match(example, /^OPENOBSERVE_PASSWORD=$/m);
  assert.doesNotMatch(example, /^OPENOBSERVE_TOKEN=/m);
  assert.doesNotMatch(example, /^OTEL_EXPORTER_OTLP_HEADERS=/m);

  const collectorConfig = await fs.readFile(path.join(root, '.locallink', 'otel-collector.yaml'), 'utf8');
  assert.equal((await fs.stat(path.join(root, '.locallink', 'otel-collector.yaml'))).mode & 0o777, 0o644);
  assert.match(collectorConfig, /otlp_http\/openobserve/);
  assert.match(collectorConfig, /\$\{env:OPENOBSERVE_ACCESS_KEY_B64\}/);
  const generatedAccessKey = env.match(/^OPENOBSERVE_ACCESS_KEY_B64=(.+)$/m)?.[1];
  assert.ok(generatedAccessKey);
  assert.doesNotMatch(collectorConfig, new RegExp(generatedAccessKey!));
  const verification = JSON.parse(
    await fs.readFile(path.join(root, '.locallink', 'otel-collector-verification.json'), 'utf8'),
  );
  assert.equal(verification.verifiedAt, '2026-07-25T14:30:00.000Z');
  assert.equal(verification.receiverHttpEndpoint, 'http://127.0.0.1:4318');

  const extensions = parseDocument(await fs.readFile(path.join(root, 'locallink.extensions.yml'), 'utf8')).toJS() as any;
  const edgeDeclaration = extensions.extensions.find((extension: any) => extension.kind === 'network-edge');
  assert.deepEqual(new Set(edgeDeclaration.exposedPorts), new Set(['5000', '5508']));
  const observability = extensions.extensions.find((extension: any) => extension.kind === 'observability');
  assert.deepEqual(observability.requiredEnv, []);
});

test('Observability plan preserves an existing data store when saved credentials are stale', async () => {
  const root = await createWorkspace();
  await fs.appendFile(path.join(root, '.env'), [
    'OPENOBSERVE_PORT=5080',
    'OPENOBSERVE_USERNAME=root@example.com',
    'OPENOBSERVE_PASSWORD=stale-password',
    'OPENOBSERVE_ORGANIZATION=default',
    '',
  ].join('\n'));
  await fs.appendFile(path.join(root, 'docker-compose.yml'), `  openobserve:
    image: openobserve/openobserve:v0.91.1
    ports:
      - "127.0.0.1:\${OPENOBSERVE_PORT}:5080"
    environment:
      ZO_ROOT_USER_EMAIL: \${OPENOBSERVE_USERNAME}
      ZO_ROOT_USER_PASSWORD: \${OPENOBSERVE_PASSWORD}
      ZO_DATA_DIR: /data/openobserve
    volumes:
      - openobserve-data:/data/openobserve
    labels:
      locallink.name: OpenObserve
      locallink.portEnv: OPENOBSERVE_PORT
volumes:
  openobserve-data: {}
`);
  const runner: CommandRunner = async (command, args) => {
    if (command === 'docker' && args.includes('ps')) return result({ stdout: JSON.stringify({ State: 'running', Health: 'healthy' }) });
    if (command === 'tailscale' && args[0] === 'status') return result({ stdout: JSON.stringify({ BackendState: 'Running' }) });
    if (command === 'tailscale' && args[0] === 'serve') return result({ stdout: '{}' });
    return result();
  };
  const probe: OpenObserveHttpProbe = async (_url, authorization) => (
    authorization ? { ok: false, status: 401 } : { ok: true, status: 200 }
  );
  const repository = new ConfigRepository(root);
  const state = new WorkspaceStateRepository(path.join(root, '.locallink', 'workspace-state.json'));
  const edge = new ExtensionPlanner(root, repository, runner, state);
  const planner = new ObservabilityPlanner(root, repository, runner, state, edge, new FixedPortAllocator(), probe);
  const beforeEnv = await fs.readFile(path.join(root, '.env'), 'utf8');

  const plan = await planner.plan('observability');
  const applied = await planner.apply('observability');

  assert.equal(plan.state, 'error');
  assert.equal(plan.canApply, false);
  assert.equal(plan.service.credentialState, 'invalid');
  assert.match(plan.summary, /preserved/i);
  assert.equal(applied.applied, false);
  assert.equal(await fs.readFile(path.join(root, '.env'), 'utf8'), beforeEnv);
});

test('findAdoptableOpenObserveRoute recognizes an existing matching Caddy and Tailscale route', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'locallink-observability-adopt-'));
  await fs.mkdir(path.join(root, 'edge'), { recursive: true });
  await fs.writeFile(path.join(root, 'edge', 'Caddyfile'), `{
  auto_https off
}
:2016 {
  reverse_proxy host.docker.internal:{\$OPENOBSERVE_PORT}
}
`, 'utf8');
  await fs.writeFile(path.join(root, 'edge', 'serve.json'), '{}\n', 'utf8');
  await fs.writeFile(path.join(root, 'docker-compose.yml'), `services:
  openobserve:
    image: openobserve/openobserve:v0.91.1
  caddy-edge:
    image: caddy:2.10-alpine
    network_mode: service:tailscale-edge
    volumes:
      - ./edge/Caddyfile:/etc/caddy/Caddyfile:ro
  tailscale-edge:
    image: tailscale/tailscale:latest
    environment:
      TS_SERVE_CONFIG: /config/serve.json
    volumes:
      - ./edge/serve.json:/config/serve.json:ro
`, 'utf8');
  const runner: CommandRunner = async (command, args) => {
    if (command === 'docker' && args.includes('ps')) {
      return result({ stdout: JSON.stringify({ State: 'running', Health: 'healthy' }) });
    }
    if (command === 'docker' && args.includes('serve') && args.includes('status')) {
      return result({ stdout: JSON.stringify({
        TCP: { 7451: { HTTPS: true } },
        Web: {
          'telemetry.tailnet.ts.net:7451': {
            Handlers: { '/': { Proxy: 'http://127.0.0.1:2016' } },
          },
        },
      }) });
    }
    return result();
  };
  const runtime: OpenObserveRuntimeDetection = {
    available: true,
    running: true,
    healthy: true,
    manageable: true,
    configured: true,
    credentialsConfigured: true,
    credentialState: 'valid',
    persistent: true,
    loopbackOnly: true,
    source: 'docker-compose',
    detail: 'healthy',
    serviceName: 'openobserve',
    port: '5080',
  };

  const route = await findAdoptableOpenObserveRoute(root, runtime, runner);
  assert.equal(route?.adopted, true);
  assert.equal(route?.proxyPort, '2016');
  assert.equal(route?.httpsPort, '7451');
  assert.equal(route?.url, 'https://telemetry.tailnet.ts.net:7451/');
});
