import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { resolvePaths, resolveProjectRoot } from '../src/shared/paths';

test('resolveProjectRoot uses the launch directory even when LOCALLINK_ROOT is set', async () => {
  const originalCwd = process.cwd();
  const originalRootEnv = process.env.LOCALLINK_ROOT;
  const workspaceRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'locallink-paths-workspace-'));
  const overriddenRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'locallink-paths-override-'));

  try {
    process.env.LOCALLINK_ROOT = overriddenRoot;
    process.chdir(workspaceRoot);

    assert.equal(resolveProjectRoot(), workspaceRoot);
    assert.equal(resolvePaths().root, workspaceRoot);
  } finally {
    process.chdir(originalCwd);
    if (originalRootEnv === undefined) {
      delete process.env.LOCALLINK_ROOT;
    } else {
      process.env.LOCALLINK_ROOT = originalRootEnv;
    }

    await fs.rm(workspaceRoot, { recursive: true, force: true });
    await fs.rm(overriddenRoot, { recursive: true, force: true });
  }
});
