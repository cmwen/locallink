import assert from 'node:assert/strict';
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

  selectedEdge.exposedPorts = ['6012'];
  const unrelated = (await buildExtensionLifecycles([selectedEdge], healthyRunner))[0];
  assert.equal(unrelated.state, 'waiting-configuration');
  assert.match(unrelated.checks.find((check) => check.id === 'tailscale-routes')?.detail || '', /none target a service declared by this workspace/i);
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
