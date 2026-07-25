import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { installBundledAgentSkill } from '../src/agents/skill-installer';

async function fixture(): Promise<{ appRoot: string; workspaceRoot: string; source: string }> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'locallink-skill-install-'));
  const appRoot = path.join(root, 'app');
  const workspaceRoot = path.join(root, 'workspace');
  const source = path.join(appRoot, 'skills', 'locallink-workspace');
  await fs.mkdir(path.join(source, 'agents'), { recursive: true });
  await fs.mkdir(workspaceRoot, { recursive: true });
  await fs.writeFile(path.join(appRoot, 'package.json'), '{"version":"1.2.3"}\n', 'utf8');
  await fs.writeFile(path.join(source, 'SKILL.md'), '---\nname: locallink-workspace\ndescription: test\n---\n', 'utf8');
  await fs.writeFile(path.join(source, 'agents', 'openai.yaml'), 'interface:\n  display_name: "LocalLink"\n', 'utf8');
  return { appRoot, workspaceRoot, source };
}

test('agent skill installer installs, detects unchanged content, and updates managed copies', async () => {
  const { appRoot, workspaceRoot, source } = await fixture();
  const options = { appRoot, workspaceRoot, target: 'workspace' as const };

  const installed = await installBundledAgentSkill(options);
  assert.equal(installed.status, 'installed');
  assert.equal(installed.sourceVersion, '1.2.3');
  assert.equal(installed.path, path.join(workspaceRoot, '.agents', 'skills', 'locallink-workspace'));
  assert.match(await fs.readFile(path.join(installed.path, 'SKILL.md'), 'utf8'), /locallink-workspace/);
  const manifest = JSON.parse(
    await fs.readFile(path.join(installed.path, '.locallink-install.json'), 'utf8'),
  );
  assert.equal(manifest.managedBy, 'locallink');
  assert.equal(manifest.contentDigest, installed.contentDigest);

  const unchanged = await installBundledAgentSkill(options);
  assert.equal(unchanged.status, 'unchanged');
  assert.equal(unchanged.contentDigest, installed.contentDigest);

  await fs.appendFile(path.join(source, 'SKILL.md'), '\nUpdated instructions.\n', 'utf8');
  const updated = await installBundledAgentSkill(options);
  assert.equal(updated.status, 'updated');
  assert.notEqual(updated.contentDigest, installed.contentDigest);
  assert.match(await fs.readFile(path.join(updated.path, 'SKILL.md'), 'utf8'), /Updated instructions/);
});

test('agent skill installer preserves an unowned target unless force creates a backup', async () => {
  const { appRoot, workspaceRoot } = await fixture();
  const targetPath = path.join(workspaceRoot, '.agents', 'skills', 'locallink-workspace');
  await fs.mkdir(targetPath, { recursive: true });
  await fs.writeFile(path.join(targetPath, 'SKILL.md'), 'user-owned\n', 'utf8');

  await assert.rejects(
    () => installBundledAgentSkill({ appRoot, workspaceRoot, target: 'workspace' }),
    (error: any) => error?.code === 'AGENT_SKILL_CONFLICT',
  );
  assert.equal(await fs.readFile(path.join(targetPath, 'SKILL.md'), 'utf8'), 'user-owned\n');

  const forced = await installBundledAgentSkill({
    appRoot,
    workspaceRoot,
    target: 'workspace',
    force: true,
  });
  assert.equal(forced.status, 'updated');
  assert.ok(forced.backupPath);
  assert.equal(await fs.readFile(path.join(forced.backupPath!, 'SKILL.md'), 'utf8'), 'user-owned\n');
  assert.match(await fs.readFile(path.join(targetPath, 'SKILL.md'), 'utf8'), /locallink-workspace/);
});

test('agent skill installer resolves Codex and generic agent homes explicitly', async () => {
  const { appRoot, workspaceRoot } = await fixture();
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'locallink-skill-homes-'));
  const codex = await installBundledAgentSkill({
    appRoot,
    workspaceRoot,
    target: 'codex',
    codexHome: path.join(root, 'codex-home'),
  });
  const agents = await installBundledAgentSkill({
    appRoot,
    workspaceRoot,
    target: 'agents',
    agentsHome: path.join(root, 'agents-home'),
  });

  assert.equal(codex.path, path.join(root, 'codex-home', 'skills', 'locallink-workspace'));
  assert.equal(agents.path, path.join(root, 'agents-home', 'skills', 'locallink-workspace'));
});
