import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { inspectPm2Workspace, withPm2WorkspaceLock } from '../src/runtime/pm2-workspace';
import { runCommand } from '../src/shared/utils';

test('real PM2 serializes relative and absolute startup into one daemon', { timeout: 30_000 }, async (context) => {
  const available = await runCommand(process.platform === 'win32' ? 'where' : 'which', ['pm2'], {
    timeoutMs: 2_000,
  });
  if (!available.ok) {
    context.skip('PM2 is not installed on PATH.');
    return;
  }

  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'locallink-real-pm2-'));
  const absoluteHome = path.join(root, '.locallink', 'pm2');
  const commandResults: Awaited<ReturnType<typeof runCommand>>[] = [];
  const invoke = (pm2Home: string) => withPm2WorkspaceLock(
    root,
    { PM2_HOME: pm2Home },
    { allowSpawn: true },
    async (processEnv) => {
      const result = await runCommand('pm2', ['jlist'], {
        cwd: root,
        env: processEnv,
        timeoutMs: 10_000,
      });
      commandResults.push(result);
      return result;
    },
  );

  let initialized = false;
  try {
    let relative;
    let absolute;
    try {
      [relative, absolute] = await Promise.all([
        invoke('.locallink/pm2'),
        invoke(absoluteHome),
      ]);
    } catch (error) {
      if (commandResults.some((result) => /EPERM|operation not permitted|EACCES/i.test(`${result.stderr}\n${result.error}`))) {
        context.skip('The test environment does not permit PM2 Unix-domain sockets.');
        return;
      }
      throw error;
    }
    const failure = [relative, absolute].find((result) => result && !result.ok);
    if (failure && /EPERM|operation not permitted|EACCES/i.test(`${failure.stderr}\n${failure.error}`)) {
      context.skip('The test environment does not permit PM2 Unix-domain sockets.');
      return;
    }
    assert.equal(relative?.ok, true, relative?.stderr);
    assert.equal(absolute?.ok, true, absolute?.stderr);
    initialized = true;

    const inspection = await inspectPm2Workspace(root, { PM2_HOME: absoluteHome });
    assert.equal(inspection.pm2Home, absoluteHome);
    assert.equal(inspection.daemonPids.length, 1);
    assert.equal(inspection.socketAvailable, true);

    const processEnv = { ...process.env, PM2_HOME: absoluteHome };
    await fs.writeFile(path.join(root, 'worker.js'), 'setInterval(() => {}, 1000);\n', 'utf8');
    const started = await runCommand('pm2', ['start', 'worker.js', '--name', 'real-pm2-worker'], {
      cwd: root,
      env: processEnv,
      timeoutMs: 10_000,
    });
    assert.equal(started.ok, true, started.stderr);
    const saved = await runCommand('pm2', ['save'], {
      cwd: root,
      env: processEnv,
      timeoutMs: 10_000,
    });
    assert.equal(saved.ok, true, saved.stderr);
    const killed = await runCommand('pm2', ['kill'], {
      cwd: root,
      env: processEnv,
      timeoutMs: 10_000,
    });
    assert.equal(killed.ok, true, killed.stderr);

    const resurrected = await withPm2WorkspaceLock(
      root,
      { PM2_HOME: absoluteHome },
      { allowSpawn: true },
      (env) => runCommand('pm2', ['resurrect'], {
        cwd: root,
        env,
        timeoutMs: 10_000,
      }),
    );
    assert.equal(resurrected?.ok, true, resurrected?.stderr);
    const list = await runCommand('pm2', ['jlist'], {
      cwd: root,
      env: processEnv,
      timeoutMs: 10_000,
    });
    assert.equal(list.ok, true, list.stderr);
    const rows = JSON.parse(list.stdout) as Array<{ name?: string; pm2_env?: { status?: string } }>;
    assert.equal(rows.some((row) => row.name === 'real-pm2-worker' && row.pm2_env?.status === 'online'), true);
  } finally {
    if (initialized) {
      await runCommand('pm2', ['kill'], {
        cwd: root,
        env: { ...process.env, PM2_HOME: absoluteHome },
        timeoutMs: 10_000,
      });
    }
  }
});
