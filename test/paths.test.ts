import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { resolvePaths, resolveProjectRoot } from '../src/shared/paths';

test('resolveProjectRoot uses explicit or LOCALLINK_WORKSPACE system workspace paths', async () => {
  const originalCwd = process.cwd();
  const originalWorkspaceEnv = process.env.LOCALLINK_WORKSPACE;
  const workspaceRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'locallink-paths-workspace-'));
  const overriddenRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'locallink-paths-override-'));

  try {
    process.env.LOCALLINK_WORKSPACE = overriddenRoot;
    process.chdir(workspaceRoot);

    assert.equal(resolveProjectRoot(), overriddenRoot);
    assert.equal(resolveProjectRoot(workspaceRoot), workspaceRoot);
    assert.equal(resolvePaths(workspaceRoot).root, workspaceRoot);
  } finally {
    process.chdir(originalCwd);
    if (originalWorkspaceEnv === undefined) {
      delete process.env.LOCALLINK_WORKSPACE;
    } else {
      process.env.LOCALLINK_WORKSPACE = originalWorkspaceEnv;
    }

    await fs.rm(workspaceRoot, { recursive: true, force: true });
    await fs.rm(overriddenRoot, { recursive: true, force: true });
  }
});
