import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { ConfigRepository } from '../src/config/files';
import { ExtensionPlanner } from '../src/extensions/planner';
import { WorkspaceStateRepository } from '../src/state/workspace-state';
import type { CommandResult, CommandRunner } from '../src/shared/utils';

function result(overrides: Partial<CommandResult> = {}): CommandResult {
  return { ok: true, code: 0, signal: null, stdout: '', stderr: '', timedOut: false, ...overrides };
}

async function createWorkspace(): Promise<string> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'locallink-extension-plan-'));
  await fs.writeFile(
    path.join(root, '.env'),
    '# keep workspace choices\nLOCALLINK_PHASE2_PREFERRED_EDGE=auto\nAPI_PORT=5050\n',
    'utf8',
  );
  await fs.writeFile(
    path.join(root, 'locallink.extensions.yml'),
    '# keep capability notes\nextensions:\n  - id: dashboard\n    name: Dashboard\n    kind: dashboard\n    enabled: true\n',
    'utf8',
  );
  await fs.writeFile(
    path.join(root, 'docker-compose.yml'),
    'services:\n  api:\n    image: example/api\n    ports:\n      - "${API_PORT}:5050"\n',
    'utf8',
  );
  return root;
}

test('Private Edge plan is read-only and separates automatic and manual steps', async () => {
  const root = await createWorkspace();
  const repository = new ConfigRepository(root);
  const missingTailscale: CommandRunner = async () => result({
    ok: false, code: null, error: 'spawn tailscale ENOENT', stderr: 'spawn tailscale ENOENT',
  });
  const planner = new ExtensionPlanner(root, repository, missingTailscale);
  const beforeExtensions = await fs.readFile(path.join(root, 'locallink.extensions.yml'), 'utf8');

  const plan = await planner.plan('private-edge');

  assert.equal(plan.state, 'ready-to-apply');
  assert.equal(plan.canApply, true);
  assert.equal(plan.steps.find((step) => step.id === 'declare-private-edge')?.automatic, true);
  assert.equal(plan.steps.find((step) => step.id === 'install-tailscale')?.owner, 'user');
  assert.equal(await fs.readFile(path.join(root, 'locallink.extensions.yml'), 'utf8'), beforeExtensions);
});

test('Private Edge apply updates only workspace-owned files and is idempotent', async () => {
  const root = await createWorkspace();
  const missingTailscale: CommandRunner = async () => result({
    ok: false, code: null, error: 'spawn tailscale ENOENT', stderr: 'spawn tailscale ENOENT',
  });
  const planner = new ExtensionPlanner(root, new ConfigRepository(root), missingTailscale);

  const applied = await planner.apply('private-edge');

  assert.equal(applied.applied, true);
  assert.deepEqual(applied.changedFiles, ['locallink.extensions.yml', '.env']);
  const extensions = await fs.readFile(path.join(root, 'locallink.extensions.yml'), 'utf8');
  const env = await fs.readFile(path.join(root, '.env'), 'utf8');
  assert.match(extensions, /# keep capability notes/);
  assert.match(extensions, /id: private-edge/);
  assert.match(extensions, /command: tailscale/);
  assert.match(extensions, /adapter: tailscale-serve/);
  assert.match(env, /# keep workspace choices/);
  assert.match(env, /^LOCALLINK_PHASE2_PREFERRED_EDGE=tailscale$/m);
  assert.equal(applied.plan.canApply, false);
  assert.equal(applied.plan.steps.find((step) => step.id === 'install-tailscale')?.status, 'pending');

  const repeated = await planner.apply('private-edge');
  assert.equal(repeated.applied, false);
  assert.deepEqual(repeated.changedFiles, []);
  assert.equal((extensions.match(/id: private-edge/g) || []).length, 1);
});

test('Private Edge apply re-enables an existing provider declaration instead of duplicating it', async () => {
  const root = await createWorkspace();
  await fs.writeFile(
    path.join(root, 'locallink.extensions.yml'),
    'extensions:\n  - id: tailscale\n    name: Existing Edge\n    kind: network-edge\n    enabled: false\n',
    'utf8',
  );
  const planner = new ExtensionPlanner(root, new ConfigRepository(root), async () => result({ ok: false, code: 1 }));

  await planner.apply('private-edge');

  const extensions = await fs.readFile(path.join(root, 'locallink.extensions.yml'), 'utf8');
  assert.equal((extensions.match(/id: tailscale/g) || []).length, 1);
  assert.doesNotMatch(extensions, /id: private-edge/);
  assert.match(extensions, /id: tailscale[\s\S]*enabled: true/);
});

test('Private Edge selection validates and persists only explicitly selected workspace services', async () => {
  const root = await createWorkspace();
  const missingTailscale: CommandRunner = async () => result({
    ok: false, code: null, error: 'spawn tailscale ENOENT', stderr: 'spawn tailscale ENOENT',
  });
  const planner = new ExtensionPlanner(root, new ConfigRepository(root), missingTailscale);

  const plan = await planner.plan('private-edge', ['api']);
  assert.equal(plan.routePlan.adapter, 'tailscale-serve');
  assert.equal(plan.reconciliation.adapter, 'tailscale-serve');
  assert.equal(plan.selection.requested, true);
  assert.deepEqual(plan.selection.selected, [{ id: 'api', name: 'Api', port: '5050' }]);
  assert.equal(plan.steps.find((step) => step.id === 'persist-edge-selection')?.status, 'pending');

  const applied = await planner.apply('private-edge', ['api']);
  assert.equal(applied.applied, true);
  const extensions = await fs.readFile(path.join(root, 'locallink.extensions.yml'), 'utf8');
  assert.match(extensions, /exposedPorts:\n\s+- "?5050"?/);

  await assert.rejects(
    () => planner.plan('private-edge', ['other-workspace-service']),
    /does not have a declared workspace port/i,
  );

  const cleared = await planner.apply('private-edge', []);
  assert.equal(cleared.applied, true);
  assert.match(await fs.readFile(path.join(root, 'locallink.extensions.yml'), 'utf8'), /exposedPorts: \[\]/);
});

test('extension planner rejects capabilities without an installer contract', async () => {
  const root = await createWorkspace();
  const planner = new ExtensionPlanner(root);
  await assert.rejects(() => planner.plan('identity'), /currently supports "private-edge"/i);
});

test('Private Edge planner rejects undeclared route adapters before producing host commands', async () => {
  const root = await createWorkspace();
  await fs.writeFile(
    path.join(root, 'locallink.extensions.yml'),
    'extensions:\n  - id: edge\n    name: Edge\n    kind: network-edge\n    enabled: true\n    adapter: unknown-edge\n',
    'utf8',
  );
  const planner = new ExtensionPlanner(root);
  await assert.rejects(
    () => planner.plan('private-edge', ['api']),
    (error: any) => error?.code === 'UNSUPPORTED_PRIVATE_EDGE_ADAPTER' && /tailscale-caddy/.test(error.message),
  );
});

test('Tailscale+Caddy adapter generates a loopback proxy topology but blocks apply without runtime ownership', async () => {
  const root = await createWorkspace();
  await fs.writeFile(
    path.join(root, 'locallink.extensions.yml'),
    'extensions:\n  - id: edge\n    name: Edge\n    kind: network-edge\n    enabled: true\n    command: tailscale\n    adapter: tailscale-caddy\n',
    'utf8',
  );
  const commandRunner: CommandRunner = async (command, args) => {
    if (command === 'caddy') return result({ ok: false, code: null, error: 'spawn caddy ENOENT', stderr: 'spawn caddy ENOENT' });
    if (args[0] === 'status') return result({ stdout: JSON.stringify({ BackendState: 'Running', Self: { DNSName: 'minipc.tailnet.ts.net.' } }) });
    return result({ stdout: '{}' });
  };
  const planner = new ExtensionPlanner(root, new ConfigRepository(root), commandRunner);

  const plan = await planner.plan('private-edge', ['api']);
  assert.equal(plan.routePlan.adapter, 'tailscale-caddy');
  assert.equal(plan.routePlan.state, 'waiting-adapter');
  assert.equal(plan.routePlan.applySupported, false);
  assert.equal(plan.routePlan.confirmationToken, undefined);
  assert.equal(plan.routePlan.prerequisites.find((item) => item.id === 'caddy')?.status, 'missing');
  assert.equal(plan.routePlan.generatedFiles[0]?.path, '.locallink/generated/private-edge/Caddyfile');
  assert.match(plan.routePlan.generatedFiles[0]?.content || '', /admin 127\.0\.0\.1:\d+/);
  assert.match(plan.routePlan.generatedFiles[0]?.content || '', /bind 127\.0\.0\.1/);
  assert.match(plan.routePlan.generatedFiles[0]?.content || '', /reverse_proxy http:\/\/127\.0\.0\.1:5050/);
  assert.notEqual(plan.routePlan.routes[0]?.proxyPort, plan.routePlan.routes[0]?.targetPort);
  assert.equal(plan.routePlan.routes[0]?.targetPort, '5050');
  assert.match(plan.routePlan.routes[0]?.apply.args.at(-1) || '', new RegExp(`:${plan.routePlan.routes[0]?.proxyPort}$`));

  await planner.apply('private-edge', ['api']);
  await assert.rejects(
    () => planner.applyRoutes('private-edge', 'private-edge:not-issued'),
    (error: any) => error?.code === 'PRIVATE_EDGE_ADAPTER_APPLY_BLOCKED',
  );
});

test('Tailscale+Caddy adapter accepts a Caddy service declared by this workspace Docker Compose project', async () => {
  const root = await createWorkspace();
  await fs.writeFile(
    path.join(root, 'locallink.extensions.yml'),
    'extensions:\n  - id: edge\n    name: Edge\n    kind: network-edge\n    enabled: true\n    command: tailscale\n    adapter: tailscale-caddy\n',
    'utf8',
  );
  await fs.writeFile(path.join(root, 'docker-compose.yml'), `services:
  api:
    image: example/api
    ports:
      - "\${API_PORT}:5050"
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
    if (args[0] === 'status') return result({ stdout: JSON.stringify({ BackendState: 'Running', Self: { DNSName: 'minipc.tailnet.ts.net.' } }) });
    return result({ stdout: '{}' });
  };
  const planner = new ExtensionPlanner(root, new ConfigRepository(root), commandRunner);

  const plan = await planner.plan('private-edge', ['api']);

  assert.equal(plan.routePlan.state, 'blocked-runtime');
  assert.equal(plan.routePlan.prerequisites.find((item) => item.id === 'caddy')?.status, 'available');
  assert.match(plan.routePlan.prerequisites.find((item) => item.id === 'caddy')?.detail || '', /pwa-edge-proxy.*running/i);
  assert.equal(plan.routePlan.generatedFiles[0]?.validate.command, 'docker');
  assert.ok(plan.routePlan.generatedFiles[0]?.validate.args.includes('pwa-edge-proxy'));
  assert.equal(calls.some((call) => call.command === 'caddy'), false);
  assert.equal(calls.find((call) => call.command === 'docker')?.cwd, root);
});

test('Tailscale+Caddy never treats a host-installed Caddy command as an automated runtime', async () => {
  const root = await createWorkspace();
  await fs.writeFile(
    path.join(root, 'locallink.extensions.yml'),
    'extensions:\n  - id: edge\n    name: Edge\n    kind: network-edge\n    enabled: true\n    command: tailscale\n    adapter: tailscale-caddy\n',
    'utf8',
  );
  const commandRunner: CommandRunner = async (command, args) => {
    if (command === 'caddy') return result({ stdout: 'v2.10.0' });
    if (args[0] === 'status') return result({ stdout: JSON.stringify({ BackendState: 'Running', Self: { DNSName: 'minipc.tailnet.ts.net.' } }) });
    return result({ stdout: '{}' });
  };
  const planner = new ExtensionPlanner(root, new ConfigRepository(root), commandRunner);

  const plan = await planner.plan('private-edge', ['api']);
  assert.equal(plan.routePlan.runtime?.source, 'host-cli');
  assert.equal(plan.routePlan.applySupported, false);
  assert.equal(plan.routePlan.state, 'blocked-runtime');
});

test('Tailscale+Caddy applies a validated managed block and reloads the workspace Caddy service', async () => {
  const root = await createWorkspace();
  await fs.writeFile(
    path.join(root, 'locallink.extensions.yml'),
    'extensions:\n  - id: edge\n    name: Edge\n    kind: network-edge\n    enabled: true\n    command: tailscale\n    adapter: tailscale-caddy\n',
    'utf8',
  );
  await fs.mkdir(path.join(root, 'edge'), { recursive: true });
  await fs.writeFile(path.join(root, 'edge', 'Caddyfile'), ':8080 {\n  file_server\n}\n', 'utf8');
  await fs.writeFile(path.join(root, 'docker-compose.yml'), `services:
  api:
    image: example/api
    ports:
      - "\${API_PORT}:5050"
  pwa-edge-proxy:
    image: caddy:2.10-alpine
    profiles: [edge]
    volumes:
      - ./edge/Caddyfile:/etc/caddy/Caddyfile:ro
`, 'utf8');
  const liveRoutes = new Map<string, string>();
  const calls: Array<{ command: string; args: string[]; cwd?: string }> = [];
  const commandRunner: CommandRunner = async (command, args, options) => {
    calls.push({ command, args, cwd: options?.cwd });
    if (command === 'docker') {
      if (args.includes('ps')) return result({ stdout: JSON.stringify({ State: 'running', Status: 'Up 2 days' }) });
      return result();
    }
    if (args[0] === 'status') return result({ stdout: JSON.stringify({ BackendState: 'Running', Self: { DNSName: 'minipc.tailnet.ts.net.' } }) });
    if (args[0] === 'serve' && args[1] === 'status') {
      const tcp: Record<string, { HTTPS: boolean }> = {};
      const web: Record<string, { Handlers: { '/': { Proxy: string } } }> = {};
      for (const [httpsPort, targetPort] of liveRoutes) {
        tcp[httpsPort] = { HTTPS: true };
        web[`minipc.tailnet.ts.net:${httpsPort}`] = { Handlers: { '/': { Proxy: `http://127.0.0.1:${targetPort}` } } };
      }
      return result({ stdout: JSON.stringify({ TCP: tcp, Web: web }) });
    }
    const httpsPort = args.find((arg) => arg.startsWith('--https='))?.split('=')[1];
    if (args.at(-1) === 'off') {
      if (httpsPort) liveRoutes.delete(httpsPort);
      return result();
    }
    const targetPort = args.at(-1)?.match(/:(\d+)$/)?.[1];
    if (httpsPort && targetPort) liveRoutes.set(httpsPort, targetPort);
    return result();
  };
  const planner = new ExtensionPlanner(root, new ConfigRepository(root), commandRunner);

  await planner.apply('private-edge', ['api']);
  const plan = await planner.plan('private-edge');
  assert.equal(plan.routePlan.state, 'ready');
  assert.equal(plan.routePlan.applySupported, true);
  assert.match(plan.routePlan.generatedFiles[0]?.content || '', /host\.docker\.internal:5050/);

  const applied = await planner.applyRoutes('private-edge', plan.routePlan.confirmationToken!);
  assert.equal(applied.applied, true);
  assert.equal(applied.plan.routePlan.state, 'in-sync');
  assert.ok(calls.some((call) => call.args.includes('validate')));
  assert.ok(calls.some((call) => call.args.includes('reload')));
  assert.match(await fs.readFile(path.join(root, 'edge', 'Caddyfile'), 'utf8'), /file_server/);
  assert.match(await fs.readFile(path.join(root, 'edge', 'Caddyfile'), 'utf8'), /BEGIN LOCALLINK MANAGED PRIVATE EDGE ROUTES/);
  const activeState = JSON.parse(await fs.readFile(path.join(root, '.locallink', 'workspace-state.json'), 'utf8'));
  assert.equal(activeState.privateEdgeRoutes[0]?.proxyPort, plan.routePlan.routes[0]?.proxyPort);
  assert.equal(activeState.privateEdgeRuntime?.status, 'active');
  assert.equal(activeState.privateEdgeRuntime?.startedByLocalLink, false);

  await planner.apply('private-edge', []);
  const removalPlan = await planner.plan('private-edge');
  assert.equal(removalPlan.reconciliation.state, 'ready');
  await planner.reconcileRoutes('private-edge', removalPlan.reconciliation.confirmationToken!);
  assert.equal(liveRoutes.size, 0);
  assert.equal(await fs.readFile(path.join(root, 'edge', 'Caddyfile'), 'utf8'), ':8080 {\n  file_server\n}\n');
  const clearedState = JSON.parse(await fs.readFile(path.join(root, '.locallink', 'workspace-state.json'), 'utf8'));
  assert.deepEqual(clearedState.privateEdgeRoutes, []);
  assert.equal(clearedState.privateEdgeRuntime, undefined);
});

test('Tailscale+Caddy starts and later stops a workspace service owned by LocalLink', async () => {
  const root = await createWorkspace();
  await fs.writeFile(
    path.join(root, 'locallink.extensions.yml'),
    'extensions:\n  - id: edge\n    name: Edge\n    kind: network-edge\n    enabled: true\n    command: tailscale\n    adapter: tailscale-caddy\n',
    'utf8',
  );
  await fs.mkdir(path.join(root, 'edge'), { recursive: true });
  await fs.writeFile(path.join(root, 'edge', 'Caddyfile'), ':8080 { respond "before" }\n', 'utf8');
  await fs.writeFile(path.join(root, 'docker-compose.yml'), `services:
  api:
    image: example/api
    ports: ["\${API_PORT}:5050"]
  edge-proxy:
    image: caddy:2.10-alpine
    profiles: [edge]
    volumes: ["./edge/Caddyfile:/etc/caddy/Caddyfile:ro"]
`, 'utf8');
  let dockerRunning = false;
  const liveRoutes = new Map<string, string>();
  const dockerActions: string[] = [];
  const commandRunner: CommandRunner = async (command, args) => {
    if (command === 'docker') {
      if (args.includes('ps')) return result({ stdout: dockerRunning ? JSON.stringify({ State: 'running' }) : '' });
      if (args.includes('up')) {
        dockerRunning = true;
        dockerActions.push('up');
      } else if (args.includes('stop')) {
        dockerRunning = false;
        dockerActions.push('stop');
      }
      return result();
    }
    if (args[0] === 'status') return result({ stdout: JSON.stringify({ BackendState: 'Running', Self: { DNSName: 'minipc.tailnet.ts.net.' } }) });
    if (args[0] === 'serve' && args[1] === 'status') {
      const tcp: Record<string, { HTTPS: boolean }> = {};
      const web: Record<string, { Handlers: { '/': { Proxy: string } } }> = {};
      for (const [httpsPort, targetPort] of liveRoutes) {
        tcp[httpsPort] = { HTTPS: true };
        web[`minipc.tailnet.ts.net:${httpsPort}`] = { Handlers: { '/': { Proxy: `http://127.0.0.1:${targetPort}` } } };
      }
      return result({ stdout: JSON.stringify({ TCP: tcp, Web: web }) });
    }
    const httpsPort = args.find((arg) => arg.startsWith('--https='))?.split('=')[1];
    if (args.at(-1) === 'off') {
      if (httpsPort) liveRoutes.delete(httpsPort);
      return result();
    }
    const targetPort = args.at(-1)?.match(/:(\d+)$/)?.[1];
    if (httpsPort && targetPort) liveRoutes.set(httpsPort, targetPort);
    return result();
  };
  const planner = new ExtensionPlanner(root, new ConfigRepository(root), commandRunner);

  await planner.apply('private-edge', ['api']);
  const plan = await planner.plan('private-edge');
  assert.equal(plan.routePlan.applySupported, true);
  await planner.applyRoutes('private-edge', plan.routePlan.confirmationToken!);
  assert.equal(dockerRunning, true);
  assert.deepEqual(dockerActions, ['up']);
  const activeState = JSON.parse(await fs.readFile(path.join(root, '.locallink', 'workspace-state.json'), 'utf8'));
  assert.equal(activeState.privateEdgeRuntime?.startedByLocalLink, true);

  const resumedPlanner = new ExtensionPlanner(root, new ConfigRepository(root), commandRunner);
  await resumedPlanner.apply('private-edge', []);
  const removalPlan = await resumedPlanner.plan('private-edge');
  await resumedPlanner.reconcileRoutes('private-edge', removalPlan.reconciliation.confirmationToken!);
  assert.equal(dockerRunning, false);
  assert.deepEqual(dockerActions, ['up', 'stop']);
  assert.equal(await fs.readFile(path.join(root, 'edge', 'Caddyfile'), 'utf8'), ':8080 { respond "before" }\n');
});

test('Tailscale+Caddy restores config and clears pending ownership when Compose startup fails', async () => {
  const root = await createWorkspace();
  await fs.writeFile(
    path.join(root, 'locallink.extensions.yml'),
    'extensions:\n  - id: edge\n    name: Edge\n    kind: network-edge\n    enabled: true\n    command: tailscale\n    adapter: tailscale-caddy\n',
    'utf8',
  );
  await fs.mkdir(path.join(root, 'edge'), { recursive: true });
  const original = ':8080 { respond "original" }\n';
  await fs.writeFile(path.join(root, 'edge', 'Caddyfile'), original, 'utf8');
  await fs.writeFile(path.join(root, 'docker-compose.yml'), `services:
  api:
    image: example/api
    ports: ["\${API_PORT}:5050"]
  edge-proxy:
    image: caddy:2.10-alpine
    volumes: ["./edge/Caddyfile:/etc/caddy/Caddyfile:ro"]
`, 'utf8');
  let stopCalls = 0;
  const commandRunner: CommandRunner = async (command, args) => {
    if (command === 'docker') {
      if (args.includes('ps')) return result({ stdout: '' });
      if (args.includes('up')) return result({ ok: false, code: 1, stderr: 'simulated startup failure' });
      if (args.includes('stop')) stopCalls += 1;
      return result();
    }
    if (args[0] === 'status') return result({ stdout: JSON.stringify({ BackendState: 'Running', Self: { DNSName: 'minipc.tailnet.ts.net.' } }) });
    if (args[0] === 'serve' && args[1] === 'status') return result({ stdout: '{}' });
    return result();
  };
  const planner = new ExtensionPlanner(root, new ConfigRepository(root), commandRunner);

  await planner.apply('private-edge', ['api']);
  const plan = await planner.plan('private-edge');
  await assert.rejects(
    () => planner.applyRoutes('private-edge', plan.routePlan.confirmationToken!),
    (error: any) => error?.code === 'PRIVATE_EDGE_ROUTE_APPLY_FAILED' && /rolled back/i.test(error.message),
  );
  assert.equal(await fs.readFile(path.join(root, 'edge', 'Caddyfile'), 'utf8'), original);
  assert.equal(stopCalls, 1);
  const state = JSON.parse(await fs.readFile(path.join(root, '.locallink', 'workspace-state.json'), 'utf8'));
  assert.equal(state.privateEdgeRuntime, undefined);
  assert.deepEqual(state.privateEdgeRoutes, []);
});

test('Private Edge route lifecycle requires fresh tokens and removes deselected owned listeners', async () => {
  const root = await createWorkspace();
  const liveRoutes = new Map<string, string>();
  const commandRunner: CommandRunner = async (_command, args) => {
    if (args[0] === 'status') return result({ stdout: JSON.stringify({ BackendState: 'Running', Self: { DNSName: 'minipc.tailnet.ts.net.' } }) });
    if (args[0] === 'serve' && args[1] === 'status') {
      const tcp: Record<string, { HTTPS: boolean }> = {};
      const web: Record<string, { Handlers: { '/': { Proxy: string } } }> = {};
      for (const [httpsPort, targetPort] of liveRoutes) {
        tcp[httpsPort] = { HTTPS: true };
        web[`minipc.tailnet.ts.net:${httpsPort}`] = { Handlers: { '/': { Proxy: `http://127.0.0.1:${targetPort}` } } };
      }
      return result({ stdout: JSON.stringify({ TCP: tcp, Web: web }) });
    }
    const httpsPort = args.find((arg) => arg.startsWith('--https='))?.split('=')[1];
    if (args.at(-1) === 'off') {
      if (httpsPort) liveRoutes.delete(httpsPort);
      return result();
    }
    const targetPort = args.at(-1)?.match(/:(\d+)$/)?.[1];
    if (httpsPort && targetPort) liveRoutes.set(httpsPort, targetPort);
    return result();
  };
  const planner = new ExtensionPlanner(root, new ConfigRepository(root), commandRunner);
  await planner.apply('private-edge', ['api']);
  const plan = await planner.plan('private-edge');

  await assert.rejects(
    () => planner.applyRoutes('private-edge', 'private-edge:stale'),
    (error: any) => error?.code === 'STALE_PRIVATE_EDGE_CONFIRMATION',
  );
  assert.equal(liveRoutes.size, 0);

  const applied = await planner.applyRoutes('private-edge', plan.routePlan.confirmationToken!);
  assert.equal(applied.applied, true);
  assert.equal(applied.plan.routePlan.state, 'in-sync');
  assert.equal(liveRoutes.size, 1);
  const workspaceState = JSON.parse(await fs.readFile(path.join(root, '.locallink', 'workspace-state.json'), 'utf8'));
  assert.equal(workspaceState.privateEdgeRoutes[0].serviceId, 'api');
  assert.equal(workspaceState.privateEdgeRoutes[0].status, 'active');

  await planner.apply('private-edge', []);
  const removalPlan = await planner.plan('private-edge');
  assert.equal(removalPlan.reconciliation.state, 'ready');
  await assert.rejects(
    () => planner.reconcileRoutes('private-edge', 'private-edge-removal:stale'),
    (error: any) => error?.code === 'STALE_PRIVATE_EDGE_RECONCILIATION',
  );
  assert.equal(liveRoutes.size, 1);

  const reconciled = await planner.reconcileRoutes('private-edge', removalPlan.reconciliation.confirmationToken!);
  assert.equal(reconciled.reconciled, true);
  assert.deepEqual(reconciled.removedRoutes, ['api']);
  assert.equal(liveRoutes.size, 0);
  const reconciledState = JSON.parse(await fs.readFile(path.join(root, '.locallink', 'workspace-state.json'), 'utf8'));
  assert.deepEqual(reconciledState.privateEdgeRoutes, []);
});

test('Private Edge reconciliation forgets changed ownership without removing the replacement listener', async () => {
  const root = await createWorkspace();
  let removalCommands = 0;
  const commandRunner: CommandRunner = async (_command, args) => {
    if (args[0] === 'status') return result({ stdout: JSON.stringify({ BackendState: 'Running', Self: { DNSName: 'minipc.tailnet.ts.net.' } }) });
    if (args[0] === 'serve' && args[1] === 'status') return result({ stdout: JSON.stringify({
      TCP: { 7452: { HTTPS: true } },
      Web: { 'minipc.tailnet.ts.net:7452': { Handlers: { '/': { Proxy: 'http://127.0.0.1:9999' } } } },
    }) });
    if (args.at(-1) === 'off') removalCommands += 1;
    return result();
  };
  const planner = new ExtensionPlanner(root, new ConfigRepository(root), commandRunner);
  await planner.apply('private-edge', []);
  const state = new WorkspaceStateRepository(path.join(root, '.locallink', 'workspace-state.json'));
  await state.load();
  await state.upsertPrivateEdgeRoutes([{
    adapter: 'tailscale-serve',
    serviceId: 'old-api',
    serviceName: 'Old API',
    targetPort: '5050',
    httpsPort: '7452',
    command: 'tailscale',
    applyArgs: ['serve', '--bg', '--yes', '--https=7452', 'http://127.0.0.1:5050'],
    rollbackArgs: ['serve', '--yes', '--https=7452', 'off'],
    appliedAt: '2026-07-21T00:00:00.000Z',
    status: 'active',
  }]);
  const plan = await planner.plan('private-edge');
  assert.equal(plan.reconciliation.removals[0]?.liveStatus, 'changed');

  const reconciled = await planner.reconcileRoutes('private-edge', plan.reconciliation.confirmationToken!);
  assert.deepEqual(reconciled.forgottenRoutes, ['old-api']);
  assert.equal(removalCommands, 0);
  assert.deepEqual((await state.load()).privateEdgeRoutes, []);
});

test('Private Edge reconciliation restores earlier removals when a later owned listener removal fails', async () => {
  const root = await createWorkspace();
  const liveRoutes = new Map([['7451', '5050'], ['7452', '6060']]);
  let restoreCommands = 0;
  const commandRunner: CommandRunner = async (_command, args) => {
    if (args[0] === 'status') return result({ stdout: JSON.stringify({ BackendState: 'Running', Self: { DNSName: 'minipc.tailnet.ts.net.' } }) });
    if (args[0] === 'serve' && args[1] === 'status') {
      const tcp: Record<string, { HTTPS: boolean }> = {};
      const web: Record<string, { Handlers: { '/': { Proxy: string } } }> = {};
      for (const [httpsPort, targetPort] of liveRoutes) {
        tcp[httpsPort] = { HTTPS: true };
        web[`minipc.tailnet.ts.net:${httpsPort}`] = { Handlers: { '/': { Proxy: `http://127.0.0.1:${targetPort}` } } };
      }
      return result({ stdout: JSON.stringify({ TCP: tcp, Web: web }) });
    }
    const httpsPort = args.find((arg) => arg.startsWith('--https='))?.split('=')[1];
    if (args.at(-1) === 'off') {
      if (httpsPort === '7452') return result({ ok: false, code: 1, stderr: 'simulated removal failure' });
      if (httpsPort) liveRoutes.delete(httpsPort);
      return result();
    }
    const targetPort = args.at(-1)?.match(/:(\d+)$/)?.[1];
    if (httpsPort && targetPort) {
      restoreCommands += 1;
      liveRoutes.set(httpsPort, targetPort);
    }
    return result();
  };
  const planner = new ExtensionPlanner(root, new ConfigRepository(root), commandRunner);
  await planner.apply('private-edge', []);
  const state = new WorkspaceStateRepository(path.join(root, '.locallink', 'workspace-state.json'));
  await state.load();
  await state.upsertPrivateEdgeRoutes([
    {
      adapter: 'tailscale-serve',
      serviceId: 'api', serviceName: 'API', targetPort: '5050', httpsPort: '7451', command: 'tailscale',
      applyArgs: ['serve', '--bg', '--yes', '--https=7451', 'http://127.0.0.1:5050'],
      rollbackArgs: ['serve', '--yes', '--https=7451', 'off'], appliedAt: '2026-07-21T00:00:00.000Z', status: 'active',
    },
    {
      adapter: 'tailscale-serve',
      serviceId: 'worker', serviceName: 'Worker', targetPort: '6060', httpsPort: '7452', command: 'tailscale',
      applyArgs: ['serve', '--bg', '--yes', '--https=7452', 'http://127.0.0.1:6060'],
      rollbackArgs: ['serve', '--yes', '--https=7452', 'off'], appliedAt: '2026-07-21T00:00:00.000Z', status: 'active',
    },
  ]);
  const plan = await planner.plan('private-edge');

  await assert.rejects(
    () => planner.reconcileRoutes('private-edge', plan.reconciliation.confirmationToken!),
    (error: any) => error?.code === 'PRIVATE_EDGE_RECONCILIATION_FAILED' && /restored/i.test(error.message),
  );
  assert.equal(restoreCommands, 1);
  assert.deepEqual([...liveRoutes.entries()], [['7452', '6060'], ['7451', '5050']]);
  assert.equal((await state.load()).privateEdgeRoutes.length, 2);
});

test('Private Edge route apply rolls back only routes created before a later command failure', async () => {
  const root = await createWorkspace();
  await fs.writeFile(
    path.join(root, 'docker-compose.yml'),
    'services:\n  api:\n    image: example/api\n    ports:\n      - "${API_PORT}:5050"\n  worker:\n    image: example/worker\n    ports:\n      - "6060:6060"\n',
    'utf8',
  );
  const liveRoutes = new Map<string, string>();
  let rollbackCalls = 0;
  const commandRunner: CommandRunner = async (_command, args) => {
    if (args[0] === 'status') return result({ stdout: JSON.stringify({ BackendState: 'Running', Self: { DNSName: 'minipc.tailnet.ts.net.' } }) });
    if (args[0] === 'serve' && args[1] === 'status') {
      const tcp: Record<string, { HTTPS: boolean }> = {};
      const web: Record<string, { Handlers: { '/': { Proxy: string } } }> = {};
      for (const [httpsPort, targetPort] of liveRoutes) {
        tcp[httpsPort] = { HTTPS: true };
        web[`minipc.tailnet.ts.net:${httpsPort}`] = { Handlers: { '/': { Proxy: `http://127.0.0.1:${targetPort}` } } };
      }
      return result({ stdout: JSON.stringify({ TCP: tcp, Web: web }) });
    }
    const httpsPort = args.find((arg) => arg.startsWith('--https='))?.split('=')[1];
    if (args.at(-1) === 'off') {
      rollbackCalls += 1;
      if (httpsPort) liveRoutes.delete(httpsPort);
      return result();
    }
    const targetPort = args.at(-1)?.match(/:(\d+)$/)?.[1];
    if (targetPort === '6060') return result({ ok: false, code: 1, stderr: 'simulated failure' });
    if (httpsPort && targetPort) liveRoutes.set(httpsPort, targetPort);
    return result();
  };
  const planner = new ExtensionPlanner(root, new ConfigRepository(root), commandRunner);
  await planner.apply('private-edge', ['api', 'worker']);
  const plan = await planner.plan('private-edge');

  await assert.rejects(
    () => planner.applyRoutes('private-edge', plan.routePlan.confirmationToken!),
    (error: any) => error?.code === 'PRIVATE_EDGE_ROUTE_APPLY_FAILED' && /rolled back/i.test(error.message),
  );
  assert.equal(rollbackCalls, 1);
  assert.equal(liveRoutes.size, 0);
  await assert.rejects(() => fs.access(path.join(root, '.locallink', 'workspace-state.json')), { code: 'ENOENT' });
});

test('Private Edge rollback refuses to remove a listener replaced by another actor', async () => {
  const root = await createWorkspace();
  await fs.writeFile(
    path.join(root, 'docker-compose.yml'),
    'services:\n  api:\n    image: example/api\n    ports:\n      - "${API_PORT}:5050"\n  worker:\n    image: example/worker\n    ports:\n      - "6060:6060"\n',
    'utf8',
  );
  const liveRoutes = new Map<string, string>();
  let rollbackCalls = 0;
  const commandRunner: CommandRunner = async (_command, args) => {
    if (args[0] === 'status') return result({ stdout: JSON.stringify({ BackendState: 'Running', Self: { DNSName: 'minipc.tailnet.ts.net.' } }) });
    if (args[0] === 'serve' && args[1] === 'status') {
      const tcp: Record<string, { HTTPS: boolean }> = {};
      const web: Record<string, { Handlers: { '/': { Proxy: string } } }> = {};
      for (const [httpsPort, targetPort] of liveRoutes) {
        tcp[httpsPort] = { HTTPS: true };
        web[`minipc.tailnet.ts.net:${httpsPort}`] = { Handlers: { '/': { Proxy: `http://127.0.0.1:${targetPort}` } } };
      }
      return result({ stdout: JSON.stringify({ TCP: tcp, Web: web }) });
    }
    const httpsPort = args.find((arg) => arg.startsWith('--https='))?.split('=')[1];
    if (args.at(-1) === 'off') {
      rollbackCalls += 1;
      return result();
    }
    const targetPort = args.at(-1)?.match(/:(\d+)$/)?.[1];
    if (targetPort === '6060') {
      const firstListener = [...liveRoutes.keys()][0];
      if (firstListener) liveRoutes.set(firstListener, '9999');
      return result({ ok: false, code: 1, stderr: 'simulated failure after concurrent replacement' });
    }
    if (httpsPort && targetPort) liveRoutes.set(httpsPort, targetPort);
    return result();
  };
  const planner = new ExtensionPlanner(root, new ConfigRepository(root), commandRunner);
  await planner.apply('private-edge', ['api', 'worker']);
  const plan = await planner.plan('private-edge');

  await assert.rejects(
    () => planner.applyRoutes('private-edge', plan.routePlan.confirmationToken!),
    (error: any) => error?.code === 'PRIVATE_EDGE_ROUTE_APPLY_FAILED' && /could not be rolled back/i.test(error.message),
  );
  assert.equal(rollbackCalls, 0);
  assert.equal([...liveRoutes.values()][0], '9999');
  const workspaceState = JSON.parse(await fs.readFile(path.join(root, '.locallink', 'workspace-state.json'), 'utf8'));
  assert.equal(workspaceState.privateEdgeRoutes[0].status, 'rollback-failed');
});
