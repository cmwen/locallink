import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { main } from '../src/cli';

test('skill inject installs the bundled skill in the current workspace', async () => {
  const workspaceRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'locallink-skill-inject-'));
  const originalCwd = process.cwd();
  const originalStdoutWrite = process.stdout.write;
  let stdout = '';

  process.chdir(workspaceRoot);
  process.stdout.write = ((chunk: string | Uint8Array) => {
    stdout += chunk.toString();
    return true;
  }) as typeof process.stdout.write;

  try {
    await main(['--log-level=silent', 'skill', 'inject']);
  } finally {
    process.stdout.write = originalStdoutWrite;
    process.chdir(originalCwd);
  }

  const result = JSON.parse(stdout) as {
    target: string;
    status: string;
    path: string;
  };
  const expectedPath = path.join(
    workspaceRoot,
    '.agents',
    'skills',
    'locallink-workspace',
  );

  assert.equal(result.target, 'workspace');
  assert.equal(result.status, 'installed');
  assert.equal(result.path, expectedPath);
  assert.match(await fs.readFile(path.join(expectedPath, 'SKILL.md'), 'utf8'), /LocalLink Workspace/);
});

test('skill inject rejects non-workspace targets', async () => {
  await assert.rejects(
    () => main(['--log-level=silent', 'skill', 'inject', '--target=agents']),
    (error: any) => error?.code === 'INVALID_SKILL_TARGET'
      && /always targets the current workspace/i.test(error.message),
  );
});
