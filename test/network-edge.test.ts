import assert from 'node:assert/strict';
import test from 'node:test';

import { discoverServiceEdgeUrls, parseTailscaleServeRoutes, planPrivateEdgeRouteRemovals, planPrivateEdgeRoutes } from '../src/runtime/network-edge';
import type { PrivateEdgeRouteOwnership, ServiceDefinition, WorkspaceExtension } from '../src/shared/contracts';
import type { CommandRunner } from '../src/shared/utils';

const SERVE_STATUS = JSON.stringify({
  TCP: {
    443: { HTTPS: true },
    80: { HTTP: true },
  },
  Web: {
    'workstation.example-tailnet.ts.net:443': {
      Handlers: {
        '/': { Proxy: 'http://127.0.0.1:4010' },
        '/queue': { Proxy: 'http://localhost:6012' },
      },
    },
    'workstation.example-tailnet.ts.net:80': {
      Handlers: {
        '/health': { Proxy: 'http://127.0.0.1:9090' },
      },
    },
  },
  Services: {
    'svc:pocket-id': {
      TCP: { 8443: { HTTPS: true } },
      Web: {
        'pocket-id.example-tailnet.ts.net:8443': {
          Handlers: {
            '/': { Proxy: 'https+insecure://localhost:1411' },
          },
        },
      },
    },
  },
});

function service(id: string, port: string): ServiceDefinition {
  return {
    id,
    name: id,
    kind: 'PWA',
    group: 'pwa',
    port,
    notes: 'Test service.',
    detail: 'Test service.',
    tags: 'test',
  };
}

function extension(enabled = true): WorkspaceExtension {
  return {
    id: 'tailscale',
    name: 'Network Edge',
    kind: 'network-edge',
    enabled,
    status: enabled ? 'ready' : 'disabled',
    command: 'tailscale',
    detail: 'Private edge.',
    exposedPorts: ['4010', '6012'],
    requiredEnv: [],
    missingEnv: [],
    dependsOn: [],
  };
}

test('parseTailscaleServeRoutes resolves HTTPS, HTTP, paths, and Tailscale Services', () => {
  assert.deepEqual(parseTailscaleServeRoutes(SERVE_STATUS), [
    { url: 'https://workstation.example-tailnet.ts.net/', targetPort: '4010' },
    { url: 'https://workstation.example-tailnet.ts.net/queue', targetPort: '6012' },
    { url: 'http://workstation.example-tailnet.ts.net/health', targetPort: '9090' },
    { url: 'https://pocket-id.example-tailnet.ts.net:8443/', targetPort: '1411' },
  ]);
});

test('discoverServiceEdgeUrls associates active routes with declared service ports', async () => {
  const commandRunner: CommandRunner = async (command, args) => {
    assert.equal(command, 'tailscale');
    assert.deepEqual(args, ['serve', 'status', '--json']);
    return { ok: true, code: 0, signal: null, stdout: SERVE_STATUS, stderr: '', timedOut: false };
  };

  const routes = await discoverServiceEdgeUrls(
    [extension()],
    [service('dashboard', '4010'), service('queue', '6012'), service('local-only', '7777')],
    commandRunner,
  );

  assert.deepEqual(routes.get('dashboard'), ['https://workstation.example-tailnet.ts.net/']);
  assert.deepEqual(routes.get('queue'), ['https://workstation.example-tailnet.ts.net/queue']);
  assert.equal(routes.has('local-only'), false);
});

test('discoverServiceEdgeUrls skips probing when Network Edge is disabled', async () => {
  let probed = false;
  const commandRunner: CommandRunner = async () => {
    probed = true;
    throw new Error('should not run');
  };

  const routes = await discoverServiceEdgeUrls([extension(false)], [service('dashboard', '4010')], commandRunner);
  assert.equal(probed, false);
  assert.equal(routes.size, 0);
});

test('discoverServiceEdgeUrls does not infer exposure without an explicit workspace selection', async () => {
  let probed = false;
  const commandRunner: CommandRunner = async () => {
    probed = true;
    return { ok: true, code: 0, signal: null, stdout: SERVE_STATUS, stderr: '', timedOut: false };
  };
  const unselected = extension();
  unselected.exposedPorts = [];

  const routes = await discoverServiceEdgeUrls([unselected], [service('dashboard', '4010')], commandRunner);

  assert.equal(probed, false);
  assert.equal(routes.size, 0);
});

test('discoverServiceEdgeUrls includes the configured Pocket ID issuer owned by the edge sidecar', async () => {
  const commandRunner: CommandRunner = async () => ({
    ok: false,
    code: 1,
    signal: null,
    stdout: '',
    stderr: 'host daemon does not own the sidecar route',
    timedOut: false,
  });
  const pocketIdExtension: WorkspaceExtension = {
    ...extension(),
    id: 'pocket-id',
    name: 'Pocket ID',
    kind: 'identity-provider',
  };
  const selectedEdge = extension();
  selectedEdge.exposedPorts = ['1411'];

  const routes = await discoverServiceEdgeUrls(
    [selectedEdge, pocketIdExtension],
    [service('pocket-id', '1411')],
    commandRunner,
    { POCKET_ID_APP_URL: 'https://pocket-id.example.ts.net:7452' },
  );

  assert.deepEqual(routes.get('pocket-id'), ['https://pocket-id.example.ts.net:7452']);
});

test('discoverServiceEdgeUrls ignores placeholder Pocket ID issuers', async () => {
  const commandRunner: CommandRunner = async () => ({ ok: false, code: 1, signal: null, stdout: '', stderr: '', timedOut: false });
  const pocketIdExtension: WorkspaceExtension = { ...extension(), id: 'pocket-id', kind: 'identity-provider' };
  const selectedEdge = extension();
  selectedEdge.exposedPorts = ['1411'];
  const routes = await discoverServiceEdgeUrls(
    [selectedEdge, pocketIdExtension],
    [service('pocket-id', '1411')],
    commandRunner,
    { POCKET_ID_APP_URL: 'https://pocket-id.example-tailnet.ts.net' },
  );

  assert.equal(routes.has('pocket-id'), false);
});

test('parseTailscaleServeRoutes tolerates unavailable or malformed status output', () => {
  assert.deepEqual(parseTailscaleServeRoutes(''), []);
  assert.deepEqual(parseTailscaleServeRoutes('{not json'), []);
});

test('planPrivateEdgeRoutes generates exact reversible commands without mutating Tailscale', async () => {
  const calls: string[][] = [];
  const commandRunner: CommandRunner = async (_command, args) => {
    calls.push(args);
    if (args[0] === 'status') {
      return { ok: true, code: 0, signal: null, stdout: JSON.stringify({ BackendState: 'Running', Self: { DNSName: 'minipc.tailnet.ts.net.' } }), stderr: '', timedOut: false };
    }
    return { ok: true, code: 0, signal: null, stdout: '{}', stderr: '', timedOut: false };
  };

  const plan = await planPrivateEdgeRoutes(
    'workspace-a',
    [{ id: 'pocket-id', name: 'Pocket ID', port: '1411' }],
    'tailscale',
    commandRunner,
    '7451',
  );

  assert.equal(plan.state, 'ready');
  assert.equal(plan.mutatesHost, false);
  assert.deepEqual(calls, [['status', '--json'], ['serve', 'status', '--json']]);
  assert.deepEqual(plan.routes[0], {
    serviceId: 'pocket-id',
    serviceName: 'Pocket ID',
    targetPort: '1411',
    httpsPort: '7451',
    url: 'https://minipc.tailnet.ts.net:7451',
    status: 'missing',
    detail: 'This listener can be added without replacing an observed root Serve route.',
    apply: { command: 'tailscale', args: ['serve', '--bg', '--yes', '--https=7451', 'http://127.0.0.1:1411'] },
    rollback: { command: 'tailscale', args: ['serve', '--yes', '--https=7451', 'off'] },
  });
  assert.match(plan.confirmationToken || '', /^private-edge:[a-f0-9]{64}$/);
});

test('planPrivateEdgeRoutes detects active listeners and conflicts instead of replacing them', async () => {
  const status = JSON.stringify({ BackendState: 'Running', Self: { DNSName: 'minipc.tailnet.ts.net.' } });
  const runnerWithTarget = (targetPort: string): CommandRunner => async (_command, args) => ({
    ok: true,
    code: 0,
    signal: null,
    stdout: args[0] === 'status' ? status : JSON.stringify({
      TCP: { 7451: { HTTPS: true } },
      Web: { 'minipc.tailnet.ts.net:7451': { Handlers: { '/': { Proxy: `http://127.0.0.1:${targetPort}` } } } },
    }),
    stderr: '',
    timedOut: false,
  });

  const selected = [{ id: 'pocket-id', name: 'Pocket ID', port: '1411' }];
  const active = await planPrivateEdgeRoutes('workspace-a', selected, 'tailscale', runnerWithTarget('1411'), '7451');
  assert.equal(active.state, 'in-sync');
  assert.equal(active.routes[0]?.status, 'active');

  const conflict = await planPrivateEdgeRoutes('workspace-a', selected, 'tailscale', runnerWithTarget('4010'), '7451');
  assert.equal(conflict.state, 'conflict');
  assert.equal(conflict.routes[0]?.status, 'conflict');
  assert.match(conflict.routes[0]?.detail || '', /already owned/i);
});

test('planPrivateEdgeRoutes does not treat a Tailscale Service virtual IP listener as a node listener conflict', async () => {
  const commandRunner: CommandRunner = async (_command, args) => ({
    ok: true,
    code: 0,
    signal: null,
    stdout: args[0] === 'status'
      ? JSON.stringify({ BackendState: 'Running', Self: { DNSName: 'minipc.tailnet.ts.net.' } })
      : JSON.stringify({
          Services: {
            'svc:other-workspace': {
              TCP: { 7451: { HTTPS: true } },
              Web: { 'other.tailnet.ts.net:7451': { Handlers: { '/': { Proxy: 'http://127.0.0.1:4010' } } } },
            },
          },
        }),
    stderr: '',
    timedOut: false,
  });

  const plan = await planPrivateEdgeRoutes(
    'workspace-a',
    [{ id: 'pocket-id', name: 'Pocket ID', port: '1411' }],
    'tailscale',
    commandRunner,
    '7451',
  );

  assert.equal(plan.state, 'ready');
  assert.equal(plan.routes[0]?.status, 'missing');
});

test('default generated listener stays stable when another service is selected later', async () => {
  const commandRunner: CommandRunner = async (_command, args) => ({
    ok: true,
    code: 0,
    signal: null,
    stdout: args[0] === 'status'
      ? JSON.stringify({ BackendState: 'Running', Self: { DNSName: 'minipc.tailnet.ts.net.' } })
      : '{}',
    stderr: '',
    timedOut: false,
  });
  const pocketId = { id: 'pocket-id', name: 'Pocket ID', port: '1411' };
  const first = await planPrivateEdgeRoutes('workspace-a', [pocketId], 'tailscale', commandRunner);
  const expanded = await planPrivateEdgeRoutes(
    'workspace-a',
    [{ id: 'dashboard', name: 'Dashboard', port: '4010' }, pocketId],
    'tailscale',
    commandRunner,
  );

  assert.equal(
    first.routes.find((route) => route.serviceId === 'pocket-id')?.httpsPort,
    expanded.routes.find((route) => route.serviceId === 'pocket-id')?.httpsPort,
  );
});

test('planPrivateEdgeRouteRemovals removes only matching owned listeners and forgets stale ownership safely', async () => {
  const owned = (serviceId: string, targetPort: string, httpsPort: string): PrivateEdgeRouteOwnership => ({
    adapter: 'tailscale-serve',
    serviceId,
    serviceName: serviceId,
    targetPort,
    httpsPort,
    command: 'tailscale',
    applyArgs: ['serve', '--bg', '--yes', `--https=${httpsPort}`, `http://127.0.0.1:${targetPort}`],
    rollbackArgs: ['serve', '--yes', `--https=${httpsPort}`, 'off'],
    appliedAt: '2026-07-21T00:00:00.000Z',
    status: 'active',
  });
  const commandRunner: CommandRunner = async (_command, args) => ({
    ok: true,
    code: 0,
    signal: null,
    stdout: args[0] === 'status'
      ? JSON.stringify({ BackendState: 'Running' })
      : JSON.stringify({
          TCP: { 7451: { HTTPS: true }, 7452: { HTTPS: true } },
          Web: {
            'minipc.tailnet.ts.net:7451': { Handlers: { '/': { Proxy: 'http://127.0.0.1:1411' } } },
            'minipc.tailnet.ts.net:7452': { Handlers: { '/': { Proxy: 'http://127.0.0.1:9999' } } },
          },
        }),
    stderr: '',
    timedOut: false,
  });

  const plan = await planPrivateEdgeRouteRemovals(
    'workspace-a',
    [owned('pocket-id', '1411', '7451'), owned('dashboard', '4010', '7452'), owned('missing', '6060', '7453')],
    [{
      serviceId: 'dashboard',
      serviceName: 'dashboard',
      targetPort: '4010',
      httpsPort: '7452',
      url: 'https://minipc.tailnet.ts.net:7452',
      status: 'conflict',
      detail: 'Listener changed.',
      apply: { command: 'tailscale', args: ['serve', '--bg', '--yes', '--https=7452', 'http://127.0.0.1:4010'] },
      rollback: { command: 'tailscale', args: ['serve', '--yes', '--https=7452', 'off'] },
    }],
    'tailscale',
    commandRunner,
  );

  assert.equal(plan.state, 'ready');
  assert.match(plan.confirmationToken || '', /^private-edge-removal:[a-f0-9]{64}$/);
  assert.deepEqual(plan.removals.map(({ serviceId, liveStatus, action }) => ({ serviceId, liveStatus, action })), [
    { serviceId: 'pocket-id', liveStatus: 'active', action: 'remove' },
    { serviceId: 'dashboard', liveStatus: 'changed', action: 'forget' },
    { serviceId: 'missing', liveStatus: 'absent', action: 'forget' },
  ]);
});
