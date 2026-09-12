import assert from 'node:assert/strict';
import { spawn, type ChildProcess } from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import {
  captureObsoletePm2ProcessTree,
  stopObsoletePm2ProcessTree,
} from '../src/runtime/pm2';
import { withPm2WorkspaceLock } from '../src/runtime/pm2-workspace';
import { resolveCanonicalPm2Home } from '../src/workspace/identity';

async function createWorkspace(): Promise<string> {
  return fs.mkdtemp(path.join(os.tmpdir(), 'locallink-pm2-isolation-'));
}

test('relative and absolute PM2 homes serialize simultaneous daemon initialization', async () => {
  const root = await createWorkspace();
  const absoluteHome = path.join(root, '.locallink', 'pm2');
  let activeInitializers = 0;
  let maximumInitializers = 0;
  const observedHomes: string[] = [];

  const initialize = (pm2Home: string) => withPm2WorkspaceLock(
    root,
    { PM2_HOME: pm2Home },
    { allowSpawn: true },
    async (processEnv) => {
      activeInitializers += 1;
      maximumInitializers = Math.max(maximumInitializers, activeInitializers);
      observedHomes.push(String(processEnv.PM2_HOME));
      await new Promise((resolve) => setTimeout(resolve, 100));
      activeInitializers -= 1;
      return processEnv.PM2_HOME;
    },
  );

  const [relativeResult, absoluteResult] = await Promise.all([
    initialize('.locallink/pm2'),
    initialize(absoluteHome),
  ]);

  assert.equal(maximumInitializers, 1);
  assert.equal(relativeResult, absoluteHome);
  assert.equal(absoluteResult, absoluteHome);
  assert.deepEqual(observedHomes, [absoluteHome, absoluteHome]);
});

test('canonical PM2 home resolves symlinked and normalized workspace paths identically', async () => {
  const parent = await createWorkspace();
  const realRoot = path.join(parent, 'real-workspace');
  const linkedRoot = path.join(parent, 'linked-workspace');
  await fs.mkdir(realRoot);
  await fs.symlink(realRoot, linkedRoot);

  assert.equal(
    resolveCanonicalPm2Home(path.join(linkedRoot, 'nested', '..'), './.locallink/../.locallink/pm2'),
    path.join(realRoot, '.locallink', 'pm2'),
  );
});

test('stale PM2 daemon state refuses daemon creation', async () => {
  const root = await createWorkspace();
  const pm2Home = path.join(root, '.locallink', 'pm2');
  await fs.mkdir(pm2Home, { recursive: true });
  await fs.writeFile(path.join(pm2Home, 'pm2.pid'), '99999999\n', 'utf8');

  await assert.rejects(
    () => withPm2WorkspaceLock(
      root,
      { PM2_HOME: '.locallink/pm2' },
      { allowSpawn: true },
      async () => undefined,
    ),
    (error: unknown) => (
      error instanceof Error
      && 'code' in error
      && error.code === 'PM2_STALE_DAEMON_STATE'
    ),
  );
});

test('read-only PM2 access does not spawn a daemon when none exists', async () => {
  const root = await createWorkspace();
  let invoked = false;
  const result = await withPm2WorkspaceLock(
    root,
    { PM2_HOME: '.locallink/pm2' },
    { allowSpawn: false },
    async () => {
      invoked = true;
      return 'unexpected';
    },
  );

  assert.equal(result, undefined);
  assert.equal(invoked, false);
});

test('multiple daemon processes resolving to the same home are rejected', async (context) => {
  if (process.platform !== 'linux') {
    context.skip('PM2 daemon reconciliation uses Linux /proc metadata.');
    return;
  }

  const root = await createWorkspace();
  const absoluteHome = path.join(root, '.locallink', 'pm2');
  const children: ChildProcess[] = [];
  const launchDaemon = (pm2Home: string) => {
    const child = spawn(
      process.execPath,
      ['-e', "process.title='PM2 v6: God Daemon'; setInterval(() => {}, 1000)"],
      {
        cwd: root,
        env: { ...process.env, PM2_HOME: pm2Home },
        stdio: 'ignore',
      },
    );
    children.push(child);
    return child;
  };

  launchDaemon('.locallink/pm2');
  launchDaemon(absoluteHome);
  await new Promise((resolve) => setTimeout(resolve, 150));

  try {
    await assert.rejects(
      () => withPm2WorkspaceLock(
        root,
        { PM2_HOME: absoluteHome },
        { allowSpawn: true },
        async () => undefined,
      ),
      (error: unknown) => (
        error instanceof Error
        && 'code' in error
        && error.code === 'PM2_DUPLICATE_DAEMONS'
      ),
    );
  } finally {
    for (const child of children) {
      child.kill('SIGTERM');
    }
  }
});

test('a live daemon with an inaccessible socket refuses replacement startup', async (context) => {
  if (process.platform !== 'linux') {
    context.skip('PM2 daemon reconciliation uses Linux /proc metadata.');
    return;
  }

  const root = await createWorkspace();
  const pm2Home = path.join(root, '.locallink', 'pm2');
  await fs.mkdir(pm2Home, { recursive: true });
  const daemon = spawn(
    process.execPath,
    ['-e', "process.title='PM2 v6: God Daemon'; setInterval(() => {}, 1000)"],
    {
      cwd: root,
      env: { ...process.env, PM2_HOME: '.locallink/pm2' },
      stdio: 'ignore',
    },
  );
  await fs.writeFile(path.join(pm2Home, 'pm2.pid'), `${daemon.pid}\n`, 'utf8');
  await new Promise((resolve) => setTimeout(resolve, 100));

  try {
    await assert.rejects(
      () => withPm2WorkspaceLock(
        root,
        { PM2_HOME: pm2Home },
        { allowSpawn: true },
        async () => undefined,
      ),
      (error: unknown) => (
        error instanceof Error
        && 'code' in error
        && error.code === 'PM2_DAEMON_UNREACHABLE'
      ),
    );
  } finally {
    daemon.kill('SIGTERM');
  }
});

test('a lock left by a dead initializer is recovered', async () => {
  const root = await createWorkspace();
  const pm2Home = path.join(root, '.locallink', 'pm2');
  const lockPath = `${pm2Home}.locallink-init.lock`;
  await fs.mkdir(lockPath, { recursive: true });
  await fs.writeFile(
    path.join(lockPath, 'owner.json'),
    JSON.stringify({ pid: 99_999_999, createdAt: new Date().toISOString() }),
    'utf8',
  );
  let invoked = false;

  await withPm2WorkspaceLock(
    root,
    { PM2_HOME: pm2Home },
    { allowSpawn: true },
    async () => {
      invoked = true;
    },
  );

  assert.equal(invoked, true);
  await assert.rejects(() => fs.access(lockPath));
});

test('descendants captured before PM2 deletion are stopped and verified afterward', async (context) => {
  if (process.platform !== 'linux') {
    context.skip('Process-tree identity verification uses Linux /proc metadata.');
    return;
  }

  const root = await createWorkspace();
  const childPidFile = path.join(root, 'child.pid');
  const parent = spawn(
    process.execPath,
    [
      '-e',
      [
        "const fs=require('node:fs')",
        "const {spawn}=require('node:child_process')",
        "const child=spawn(process.execPath,['-e','setInterval(()=>{},1000)'],{stdio:'ignore'})",
        `fs.writeFileSync(${JSON.stringify(childPidFile)},String(child.pid))`,
        'setInterval(()=>{},1000)',
      ].join(';'),
    ],
    { stdio: 'ignore' },
  );

  let childPid = 0;
  try {
    for (let attempt = 0; attempt < 40; attempt += 1) {
      childPid = Number(await fs.readFile(childPidFile, 'utf8').catch(() => '0'));
      if (childPid > 0) {
        break;
      }
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    assert.ok(parent.pid);
    assert.ok(childPid > 0, 'child PID was not recorded');
    const captured = await captureObsoletePm2ProcessTree([parent.pid!]);
    assert.ok(captured.some((identity) => identity.pid === childPid));

    parent.kill('SIGTERM');
    const cleanup = await stopObsoletePm2ProcessTree(captured);

    assert.deepEqual(cleanup.remainingPids, []);
    assert.equal(await processIsRunning(childPid), false);
  } finally {
    parent.kill('SIGKILL');
    if (childPid > 0) {
      try {
        process.kill(childPid, 'SIGKILL');
      } catch {
        // The verified cleanup path already stopped it.
      }
    }
  }
});

async function processIsRunning(pid: number): Promise<boolean> {
  try {
    const raw = await fs.readFile(`/proc/${pid}/stat`, 'utf8');
    const fields = raw.slice(raw.lastIndexOf(')') + 2).split(/\s+/);
    return fields[0] !== 'Z';
  } catch {
    return false;
  }
}
