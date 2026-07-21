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
    'extensions:\n  - id: edge\n    name: Edge\n    kind: network-edge\n    enabled: true\n    adapter: caddy\n',
    'utf8',
  );
  const planner = new ExtensionPlanner(root);
  await assert.rejects(
    () => planner.plan('private-edge', ['api']),
    (error: any) => error?.code === 'UNSUPPORTED_PRIVATE_EDGE_ADAPTER' && /tailscale-serve/.test(error.message),
  );
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
