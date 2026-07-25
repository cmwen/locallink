import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { parseDocument } from 'yaml';

import { ConfigRepository } from '../src/config/files';
import { IdentityPlanner } from '../src/extensions/identity-planner';
import { ExtensionPlanner } from '../src/extensions/planner';
import type { CommandResult, CommandRunner } from '../src/shared/utils';
import { WorkspaceStateRepository } from '../src/state/workspace-state';

function result(overrides: Partial<CommandResult> = {}): CommandResult {
  return { ok: true, code: 0, signal: null, stdout: '', stderr: '', timedOut: false, ...overrides };
}

async function createWorkspace(): Promise<string> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'locallink-identity-plan-'));
  await fs.writeFile(path.join(root, '.env'), [
    'LOCALLINK_WORKSPACE_ID=identity-test',
    'LOCALLINK_PRIVATE_EDGE_PORT_START=27451',
    'API_PORT=5000',
    '',
  ].join('\n'), 'utf8');
  await fs.writeFile(path.join(root, '.env.example'), 'API_PORT=5000\n', 'utf8');
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

test('Identity plan is read-only and separates automatic installation from manual security choices', async () => {
  const root = await createWorkspace();
  const beforeCompose = await fs.readFile(path.join(root, 'docker-compose.yml'), 'utf8');
  const runner: CommandRunner = async (command, args) => {
    if (command === 'tailscale' && args[0] === 'status') {
      return result({ stdout: JSON.stringify({ BackendState: 'Running', Self: { DNSName: 'identity.tailnet.ts.net.' } }) });
    }
    if (command === 'tailscale' && args[0] === 'serve') return result({ stdout: '{}' });
    if (command === 'docker') return result({ stdout: '' });
    return result({ ok: false, code: null });
  };
  const repository = new ConfigRepository(root);
  const state = new WorkspaceStateRepository(path.join(root, '.locallink', 'workspace-state.json'));
  const edge = new ExtensionPlanner(root, repository, runner, state);
  const planner = new IdentityPlanner(root, repository, runner, state, edge);

  const plan = await planner.plan('identity');

  assert.equal(plan.state, 'ready-to-apply');
  assert.equal(plan.canApply, true);
  assert.equal(plan.service.installed, false);
  assert.ok(plan.steps.some((step) => step.id === 'create-pocket-id-admin' && step.owner === 'user'));
  assert.ok(plan.steps.some((step) => step.id === 'register-oidc-clients' && step.owner === 'user'));
  assert.equal(await fs.readFile(path.join(root, 'docker-compose.yml'), 'utf8'), beforeCompose);
  await assert.rejects(fs.access(path.join(root, '.locallink', 'secrets', 'pocket-id', 'encryption-key')));
});

test('Identity apply installs Pocket ID, preserves edge selections, derives its issuer, and starts it', async () => {
  const root = await createWorkspace();
  let pocketRunning = false;
  const actions: string[] = [];
  const runner: CommandRunner = async (command, args) => {
    if (command === 'tailscale' && args[0] === 'status') {
      return result({ stdout: JSON.stringify({ BackendState: 'Running', Self: { DNSName: 'identity.tailnet.ts.net.' } }) });
    }
    if (command === 'tailscale' && args[0] === 'serve') return result({ stdout: '{}' });
    if (command === 'docker' && args.includes('ps')) {
      return result({
        stdout: args.at(-1) === 'pocket-id' && pocketRunning
          ? JSON.stringify({ State: 'running', Health: 'healthy' })
          : '',
      });
    }
    if (command === 'docker' && args.includes('up')) {
      pocketRunning = true;
      actions.push(`up:${args.at(-1)}`);
      return result();
    }
    if (command === 'docker' && args.includes('healthcheck')) return result();
    if (command === 'caddy') return result({ ok: false, code: null });
    return result();
  };
  const repository = new ConfigRepository(root);
  const state = new WorkspaceStateRepository(path.join(root, '.locallink', 'workspace-state.json'));
  await state.load();
  const edge = new ExtensionPlanner(root, repository, runner, state);
  const planner = new IdentityPlanner(root, repository, runner, state, edge);

  const applied = await planner.apply('identity');

  assert.equal(applied.applied, true);
  assert.equal(applied.started, true);
  assert.deepEqual(actions, ['up:pocket-id']);
  assert.equal(applied.plan.service.healthy, true);
  assert.equal(applied.plan.state, 'ready-to-route');
  assert.match(applied.plan.privateEdge.url || '', /^https:\/\/identity\.tailnet\.ts\.net:2745\d\/?$/);
  assert.match(applied.plan.privateEdge.confirmationToken || '', /^private-edge:[a-f0-9]{64}$/);

  const secret = await fs.readFile(path.join(root, '.locallink', 'secrets', 'pocket-id', 'encryption-key'), 'utf8');
  assert.ok(secret.length >= 32);
  assert.equal(secret.endsWith('\n'), false);
  const mode = (await fs.stat(path.join(root, '.locallink', 'secrets', 'pocket-id', 'encryption-key'))).mode & 0o777;
  assert.equal(mode, 0o600);

  const composeRaw = await fs.readFile(path.join(root, 'docker-compose.yml'), 'utf8');
  const compose = parseDocument(composeRaw).toJS() as any;
  assert.equal(compose.services['pocket-id'].image, 'ghcr.io/pocket-id/pocket-id:v2');
  assert.equal(compose.services['pocket-id'].ports[0], '127.0.0.1:${POCKET_ID_PORT:-1411}:${POCKET_ID_INTERNAL_PORT:-1411}');
  assert.equal(compose.services['pocket-id'].environment.ENCRYPTION_KEY_FILE, '/run/secrets/pocket-id-encryption-key');
  assert.ok(compose.services['pocket-id'].volumes.includes('pocket-id-data:/app/data'));
  assert.ok(compose.volumes['pocket-id-data']);

  const env = await fs.readFile(path.join(root, '.env'), 'utf8');
  assert.match(env, /^POCKET_ID_APP_URL=https:\/\/identity\.tailnet\.ts\.net:2745\d\/?$/m);
  assert.doesNotMatch(env, /^POCKET_ID_ENCRYPTION_KEY=/m);
  const example = await fs.readFile(path.join(root, '.env.example'), 'utf8');
  assert.match(example, /^POCKET_ID_APP_URL=$/m);
  assert.doesNotMatch(example, /ENCRYPTION_KEY/);

  const extensions = parseDocument(await fs.readFile(path.join(root, 'locallink.extensions.yml'), 'utf8')).toJS() as any;
  const edgeDeclaration = extensions.extensions.find((extension: any) => extension.kind === 'network-edge');
  assert.deepEqual(new Set(edgeDeclaration.exposedPorts), new Set(['5000', '1411']));
  const identity = extensions.extensions.find((extension: any) => extension.kind === 'identity-provider');
  assert.deepEqual(identity.requiredEnv, ['POCKET_ID_APP_URL']);
  assert.equal((await state.load()).preferences.pocketIdEnabled, true);
});

test('Identity apply preserves an existing environment encryption key', async () => {
  const root = await createWorkspace();
  await fs.appendFile(path.join(root, '.env'), [
    'POCKET_ID_APP_URL=https://identity.tailnet.ts.net:27452/',
    'POCKET_ID_ENCRYPTION_KEY=existing-key-material-that-must-not-change',
    'POCKET_ID_PORT=1411',
    'POCKET_ID_INTERNAL_PORT=1411',
    'POCKET_ID_TRUST_PROXY=false',
    '',
  ].join('\n'));
  await fs.appendFile(path.join(root, 'docker-compose.yml'), `  pocket-id:
    image: ghcr.io/pocket-id/pocket-id:v2
    environment:
      APP_URL: \${POCKET_ID_APP_URL}
      ENCRYPTION_KEY: \${POCKET_ID_ENCRYPTION_KEY}
    ports:
      - "127.0.0.1:\${POCKET_ID_PORT}:1411"
    volumes:
      - pocket-id-data:/app/data
volumes:
  pocket-id-data: {}
`);
  const runner: CommandRunner = async (command, args) => {
    if (command === 'tailscale' && args[0] === 'status') {
      return result({ stdout: JSON.stringify({ BackendState: 'Running', Self: { DNSName: 'identity.tailnet.ts.net.' } }) });
    }
    if (command === 'tailscale' && args[0] === 'serve') return result({ stdout: '{}' });
    if (command === 'docker' && args.includes('ps')) return result({ stdout: JSON.stringify({ State: 'running', Health: 'healthy' }) });
    return result();
  };
  const repository = new ConfigRepository(root);
  const state = new WorkspaceStateRepository(path.join(root, '.locallink', 'workspace-state.json'));
  await state.load();
  const edge = new ExtensionPlanner(root, repository, runner, state);
  const planner = new IdentityPlanner(root, repository, runner, state, edge);

  const plan = await planner.plan('identity');

  assert.equal(plan.steps.find((step) => step.id === 'configure-pocket-id-secret')?.status, 'complete');
  assert.equal((await fs.readFile(path.join(root, '.env'), 'utf8')).includes('existing-key-material-that-must-not-change'), true);
  await assert.rejects(fs.access(path.join(root, '.locallink', 'secrets', 'pocket-id', 'encryption-key')));
});

test('Identity apply adopts a matching live Caddy and Tailscale route without changing the issuer', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'locallink-identity-adopt-'));
  await fs.mkdir(path.join(root, 'edge'), { recursive: true });
  await fs.writeFile(path.join(root, '.env'), [
    'LOCALLINK_WORKSPACE_ID=identity-adopt',
    'POCKET_ID_APP_URL=https://identity.tailnet.ts.net:7452',
    'POCKET_ID_ENCRYPTION_KEY=existing-key-material-that-must-not-change',
    'POCKET_ID_PORT=1411',
    'POCKET_ID_INTERNAL_PORT=1411',
    'POCKET_ID_TRUST_PROXY=false',
    '',
  ].join('\n'), 'utf8');
  await fs.writeFile(path.join(root, '.env.example'), '', 'utf8');
  await fs.writeFile(path.join(root, 'edge', 'Caddyfile'), `{
  auto_https off
}
:2019 {
  reverse_proxy pocket-id:\${POCKET_ID_INTERNAL_PORT}
}
`, 'utf8');
  await fs.writeFile(path.join(root, 'edge', 'serve.json'), '{}\n', 'utf8');
  await fs.writeFile(path.join(root, 'docker-compose.yml'), `services:
  pocket-id:
    image: ghcr.io/pocket-id/pocket-id:v2
    environment:
      APP_URL: \${POCKET_ID_APP_URL}
      ENCRYPTION_KEY: \${POCKET_ID_ENCRYPTION_KEY}
    ports:
      - "127.0.0.1:\${POCKET_ID_PORT}:1411"
    volumes:
      - pocket-id-data:/app/data
    labels:
      locallink.name: Pocket ID
      locallink.portEnv: POCKET_ID_PORT
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
volumes:
  pocket-id-data: {}
`, 'utf8');
  await fs.writeFile(path.join(root, 'locallink.extensions.yml'), `extensions:
  - id: edge
    name: Private Edge
    kind: network-edge
    enabled: true
  - id: identity
    name: Pocket ID
    kind: identity-provider
    enabled: true
    requiredEnv:
      - POCKET_ID_APP_URL
`, 'utf8');
  const calls: string[][] = [];
  const runner: CommandRunner = async (command, args) => {
    calls.push(args);
    if (command === 'docker' && args.includes('ps')) {
      return result({ stdout: JSON.stringify({ State: 'running', Health: 'healthy' }) });
    }
    if (command === 'docker' && args.includes('serve') && args.includes('status')) {
      return result({ stdout: JSON.stringify({
        TCP: { 7452: { HTTPS: true } },
        Web: {
          'identity.tailnet.ts.net:7452': {
            Handlers: { '/': { Proxy: 'http://127.0.0.1:2019' } },
          },
        },
      }) });
    }
    if (command === 'docker' && args.includes('status') && args.includes('--json')) {
      return result({ stdout: JSON.stringify({ BackendState: 'Running', Self: { DNSName: 'identity.tailnet.ts.net.' } }) });
    }
    if (command === 'docker' && args.includes('healthcheck')) return result();
    return result();
  };
  const repository = new ConfigRepository(root);
  const state = new WorkspaceStateRepository(path.join(root, '.locallink', 'workspace-state.json'));
  await state.load();
  const edge = new ExtensionPlanner(root, repository, runner, state);
  const planner = new IdentityPlanner(root, repository, runner, state, edge);
  const caddyBefore = await fs.readFile(path.join(root, 'edge', 'Caddyfile'), 'utf8');

  const preview = await planner.plan('identity');
  assert.equal(preview.steps.find((step) => step.id === 'adopt-pocket-id-route')?.status, 'pending');
  const applied = await planner.apply('identity');

  const ownership = (await state.load()).privateEdgeRoutes.find((route) => route.serviceId === 'pocket-id');
  assert.equal(ownership?.adopted, true);
  assert.equal(ownership?.httpsPort, '7452');
  assert.equal(ownership?.proxyPort, '2019');
  assert.equal(ownership?.url, 'https://identity.tailnet.ts.net:7452');
  assert.equal(applied.started, false);
  assert.equal(applied.plan.state, 'waiting-user');
  assert.equal(applied.plan.privateEdge.url, 'https://identity.tailnet.ts.net:7452');
  assert.equal(await fs.readFile(path.join(root, 'edge', 'Caddyfile'), 'utf8'), caddyBefore);
  assert.equal(calls.some((args) => args.includes('--bg')), false);
  assert.match(await fs.readFile(path.join(root, '.env'), 'utf8'), /^POCKET_ID_APP_URL=https:\/\/identity\.tailnet\.ts\.net:7452$/m);
});
