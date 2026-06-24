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
  assert.ok(result.created.includes(path.join(root, 'locallink.services.yml')));
  assert.ok(result.created.includes(path.join(root, 'locallink.lock.json')));
  assert.ok(result.created.includes(path.join(root, 'ecosystem.config.js')));
  assert.ok(result.created.includes(path.join(root, 'mcp-registry.json')));
  assert.ok(result.created.includes(path.join(root, 'AGENTS.md')));
  assert.equal(result.readmePath, path.join(root, 'README.locallink.md'));

  const generatedReadme = await fs.readFile(result.readmePath, 'utf8');
  assert.match(generatedReadme, /locallink init/i);
  assert.match(generatedReadme, /AGENTS\.md/i);
  assert.match(generatedReadme, /locallink\.services\.yml/i);
  assert.match(generatedReadme, /dependsOn/i);
});
