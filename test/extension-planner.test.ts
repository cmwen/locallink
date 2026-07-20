import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { ConfigRepository } from '../src/config/files';
import { ExtensionPlanner } from '../src/extensions/planner';
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

test('extension planner rejects capabilities without an installer contract', async () => {
  const root = await createWorkspace();
  const planner = new ExtensionPlanner(root);
  await assert.rejects(() => planner.plan('identity'), /currently supports "private-edge"/i);
});
