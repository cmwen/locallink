import assert from 'node:assert/strict';
import test from 'node:test';

import { discoverServiceEdgeUrls, parseTailscaleServeRoutes } from '../src/runtime/network-edge';
import type { ServiceDefinition, WorkspaceExtension } from '../src/shared/contracts';
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
    exposedPorts: [],
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

test('parseTailscaleServeRoutes tolerates unavailable or malformed status output', () => {
  assert.deepEqual(parseTailscaleServeRoutes(''), []);
  assert.deepEqual(parseTailscaleServeRoutes('{not json'), []);
});
