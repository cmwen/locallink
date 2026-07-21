import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { buildExtensionLifecycles } from '../src/extensions/lifecycle';
import type { WorkspaceExtension } from '../src/shared/contracts';
import type { CommandResult, CommandRunner } from '../src/shared/utils';

function result(overrides: Partial<CommandResult> = {}): CommandResult {
  return { ok: true, code: 0, signal: null, stdout: '', stderr: '', timedOut: false, ...overrides };
}

function privateEdge(): WorkspaceExtension {
  return {
    id: 'tailscale', name: 'Tailscale Private Edge', kind: 'network-edge', enabled: true,
    detail: 'Private edge.', status: 'ready', command: 'tailscale', exposedPorts: [],
    requiredEnv: [], missingEnv: [], dependsOn: [],
  };
}

function reverseProxy(): WorkspaceExtension {
  return {
    ...privateEdge(), id: 'proxy', name: 'Reverse Proxy', kind: 'reverse-proxy', command: undefined,
  };
}

test('capability catalog stays available without pretending extensions are installed', async () => {
  let calls = 0;
  const records = await buildExtensionLifecycles([], async () => {
    calls += 1;
    return result();
  });

  assert.equal(calls, 0);
  assert.deepEqual(records.map((record) => record.id), ['private-edge', 'reverse-proxy', 'identity', 'observability']);
  assert.ok(records.every((record) => record.state === 'available'));
  assert.ok(records.every((record) => record.declared === false));
});

test('Private Edge reports host installation and tailnet authentication as manual steps', async () => {
  const missingRunner: CommandRunner = async () => result({
    ok: false, code: null, error: 'spawn tailscale ENOENT', stderr: 'spawn tailscale ENOENT',
  });
  const missing = (await buildExtensionLifecycles([privateEdge()], missingRunner))[0];
  assert.equal(missing.state, 'waiting-external');
  assert.equal(missing.automation, 'manual');

  const disconnectedRunner: CommandRunner = async () => result({ ok: false, code: 1, stderr: 'Logged out.' });
  const disconnected = (await buildExtensionLifecycles([privateEdge()], disconnectedRunner))[0];
  assert.equal(disconnected.state, 'waiting-user');
  assert.match(disconnected.nextStep || '', /Authenticate/i);
});

test('Private Edge distinguishes connected setup from healthy Serve routes', async () => {
  const connectedRunner: CommandRunner = async (_command, args) => args[0] === 'status'
    ? result({ stdout: JSON.stringify({ BackendState: 'Running' }) })
    : result({ stdout: '{}' });
  const waiting = (await buildExtensionLifecycles([privateEdge()], connectedRunner))[0];
  assert.equal(waiting.state, 'waiting-configuration');
  assert.match(waiting.nextStep || '', /Select the workspace services/i);

  const healthyRunner: CommandRunner = async (_command, args) => args[0] === 'status'
    ? result({ stdout: JSON.stringify({ BackendState: 'Running' }) })
    : result({ stdout: JSON.stringify({
        TCP: { 443: { HTTPS: true } },
        Web: {
          'workspace.example.ts.net:443': {
            Handlers: { '/': { Proxy: 'http://127.0.0.1:4010' } },
          },
        },
      }) });
  const selectedEdge = privateEdge();
  selectedEdge.exposedPorts = ['4010'];
  const healthy = (await buildExtensionLifecycles([selectedEdge], healthyRunner))[0];
  assert.equal(healthy.state, 'healthy');
  assert.match(healthy.summary, /1 active workspace Tailscale Serve route/);
  assert.equal(healthy.checks.find((check) => check.id === 'tailscale-routes')?.status, 'ok');

  selectedEdge.exposedPorts = ['4010', '6012'];
  const partial = (await buildExtensionLifecycles([selectedEdge], healthyRunner))[0];
  assert.equal(partial.state, 'waiting-configuration');
  assert.match(partial.checks.find((check) => check.id === 'tailscale-routes')?.detail || '', /missing routes.*6012/i);

  selectedEdge.exposedPorts = ['6012'];
  const unrelated = (await buildExtensionLifecycles([selectedEdge], healthyRunner))[0];
  assert.equal(unrelated.state, 'waiting-configuration');
  assert.match(unrelated.checks.find((check) => check.id === 'tailscale-routes')?.detail || '', /none target a service declared by this workspace/i);
});

test('Reverse Proxy detects a workspace-scoped Docker Compose Caddy service without a host CLI', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'locallink-caddy-lifecycle-'));
  await fs.writeFile(path.join(root, 'docker-compose.yml'), `services:
  pwa-edge-proxy:
    image: caddy:2.10-alpine
    profiles: [edge]
    labels:
      locallink.tags: docker,edge,reverse-proxy
`, 'utf8');
  const calls: Array<{ command: string; args: string[]; cwd?: string }> = [];
  const commandRunner: CommandRunner = async (command, args, options) => {
    calls.push({ command, args, cwd: options?.cwd });
    if (command === 'docker') return result({ stdout: JSON.stringify({ State: 'running', Status: 'Up 2 days' }) });
    return result({ ok: false, code: null, error: `spawn ${command} ENOENT`, stderr: `spawn ${command} ENOENT` });
  };

  const record = (await buildExtensionLifecycles([reverseProxy()], commandRunner, root))
    .find((candidate) => candidate.kind === 'reverse-proxy');

  assert.equal(record?.state, 'installed');
  assert.match(record?.summary || '', /Docker Compose.*running/i);
  assert.match(record?.checks.find((check) => check.id === 'reverse-proxy-runtime')?.detail || '', /pwa-edge-proxy.*caddy:2\.10-alpine/i);
  assert.equal(calls.some((call) => call.command === 'caddy'), false);
  assert.deepEqual(calls.find((call) => call.command === 'docker')?.args, [
    'compose', '--profile', '*', 'ps', '--all', '--format', 'json', 'pwa-edge-proxy',
  ]);
  assert.equal(calls.find((call) => call.command === 'docker')?.cwd, root);
});

test('required identity configuration is separated from provider runtime health', async () => {
  const identity: WorkspaceExtension = {
    ...privateEdge(), id: 'pocket-id', name: 'Pocket ID', kind: 'identity-provider',
    requiredEnv: ['OIDC_ISSUER_URL', 'OIDC_CLIENT_SECRET'], missingEnv: ['OIDC_CLIENT_SECRET'],
  };
  const record = (await buildExtensionLifecycles([identity])).find((candidate) => candidate.kind === 'identity-provider');

  assert.equal(record?.state, 'waiting-configuration');
  assert.match(record?.nextStep || '', /OIDC_CLIENT_SECRET/);
});
