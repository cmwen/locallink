import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { initializeWorkspace } from '../src/init/scaffold';

test('initializeWorkspace scaffolds starter files without overwriting an existing README', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'locallink-init-'));
  await fs.writeFile(path.join(root, 'README.md'), '# Existing\n', 'utf8');

  const result = await initializeWorkspace(root);

  assert.ok(result.created.includes(path.join(root, '.env')));
  assert.ok(result.created.includes(path.join(root, '.env.example')));
  assert.ok(result.created.includes(path.join(root, '.gitignore')));
  assert.ok(result.created.includes(path.join(root, 'Taskfile.yml')));
  assert.ok(result.created.includes(path.join(root, 'docker-compose.yml')));
  assert.ok(result.created.includes(path.join(root, 'locallink.extensions.yml')));
  assert.ok(result.created.includes(path.join(root, 'ecosystem.config.js')));
  assert.ok(result.created.includes(path.join(root, 'mcp-registry.json')));
  assert.ok(result.created.includes(path.join(root, 'AGENTS.md')));
  assert.equal(result.readmePath, path.join(root, 'README.locallink.md'));

  const generatedReadme = await fs.readFile(result.readmePath, 'utf8');
  assert.match(generatedReadme, /locallink init/i);
  assert.match(generatedReadme, /AGENTS\.md/i);
  assert.match(generatedReadme, /dependsOn/i);
  assert.match(generatedReadme, /multiple LocalLink dashboards/i);
  assert.match(generatedReadme, /Optional Private Edge/i);

  const generatedCompose = await fs.readFile(path.join(root, 'docker-compose.yml'), 'utf8');
  assert.match(generatedCompose, /services: \{\}/);
  assert.doesNotMatch(generatedCompose, /pocket-id:/);

  const generatedEnv = await fs.readFile(path.join(root, '.env.example'), 'utf8');
  assert.match(generatedEnv, /LOCALLINK_WORKSPACE_ID=locallink-init-[a-z0-9-]+/);
  assert.match(generatedEnv, /COMPOSE_PROJECT_NAME=locallink_/);
  assert.match(generatedEnv, /PM2_HOME=\.locallink\/pm2/);
  assert.match(generatedEnv, /LOCALLINK_WEB_PORT=auto/);
  assert.doesNotMatch(generatedEnv, /POCKET_ID/);

  const generatedExtensions = await fs.readFile(path.join(root, 'locallink.extensions.yml'), 'utf8');
  assert.match(generatedExtensions, /kind: dashboard/);
  assert.doesNotMatch(generatedExtensions, /kind: identity-provider/);
  assert.doesNotMatch(generatedExtensions, /kind: network-edge/);
});

test('initializeWorkspace assigns unique namespaces to same-named workspaces', async () => {
  const parentA = await fs.mkdtemp(path.join(os.tmpdir(), 'locallink-parent-a-'));
  const parentB = await fs.mkdtemp(path.join(os.tmpdir(), 'locallink-parent-b-'));
  const rootA = path.join(parentA, 'project');
  const rootB = path.join(parentB, 'project');

  await initializeWorkspace(rootA);
  await initializeWorkspace(rootB);

  const envA = await fs.readFile(path.join(rootA, '.env'), 'utf8');
  const envB = await fs.readFile(path.join(rootB, '.env'), 'utf8');
  const idA = envA.match(/^LOCALLINK_WORKSPACE_ID=(.+)$/m)?.[1];
  const idB = envB.match(/^LOCALLINK_WORKSPACE_ID=(.+)$/m)?.[1];
  const composeA = envA.match(/^COMPOSE_PROJECT_NAME=(.+)$/m)?.[1];
  const composeB = envB.match(/^COMPOSE_PROJECT_NAME=(.+)$/m)?.[1];

  assert.ok(idA);
  assert.ok(idB);
  assert.notEqual(idA, idB);
  assert.notEqual(composeA, composeB);
});
