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
  assert.match(generatedReadme, /Pocket ID/i);
  assert.match(generatedReadme, /Tailscale Serve/i);

  const generatedCompose = await fs.readFile(path.join(root, 'docker-compose.yml'), 'utf8');
  assert.match(generatedCompose, /pocket-id:/);
  assert.match(generatedCompose, /profiles: \[identity\]/);

  const generatedEnv = await fs.readFile(path.join(root, '.env.example'), 'utf8');
  assert.match(generatedEnv, /POCKET_ID_APP_URL/);
  assert.match(generatedEnv, /POCKET_ID_ENCRYPTION_KEY/);

  const generatedExtensions = await fs.readFile(path.join(root, 'locallink.extensions.yml'), 'utf8');
  assert.match(generatedExtensions, /kind: identity-provider/);
  assert.match(generatedExtensions, /kind: network-edge/);
});
