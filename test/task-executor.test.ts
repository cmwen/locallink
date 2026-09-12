import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { ConfigRepository } from '../src/config/files';
import { LogBroker } from '../src/logs/broker';
import { TaskExecutor } from '../src/tasks/executor';
import type { CommandRunner, CommandResult } from '../src/shared/utils';

async function createTempProject(): Promise<string> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'locallink-task-executor-'));
  await fs.writeFile(path.join(root, '.env'), '', 'utf8');
  await fs.writeFile(
    path.join(root, 'package.json'),
    JSON.stringify({ name: 'task-executor-test', version: '0.0.0' }, null, 2),
    'utf8',
  );
  await fs.writeFile(path.join(root, 'worker.js'), 'setInterval(() => {}, 1000);\n', 'utf8');
  await fs.writeFile(
    path.join(root, 'Dockerfile'),
    'FROM node:24-alpine\nENV PORT=3000\nEXPOSE 3000\nCMD ["node", "./worker.js"]\n',
    'utf8',
  );
  await fs.writeFile(path.join(root, 'docker-compose.yml'), 'services: {}\n', 'utf8');
  await fs.writeFile(
    path.join(root, 'ecosystem.config.js'),
    "module.exports = {\n  apps: [\n    {\n      name: 'Queue Worker',\n      script: './worker.js',\n      locallink: {\n        group: 'pm2',\n        runtime: 'pm2',\n      },\n    },\n  ],\n};\n",
    'utf8',
  );
  return root;
}

function commandResult(overrides: Partial<CommandResult> = {}): CommandResult {
  return {
    ok: true,
    code: 0,
    signal: null,
    stdout: '',
    stderr: '',
    timedOut: false,
    ...overrides,
  };
}

test('TaskExecutor starts PM2 apps through ecosystem.config.js', async () => {
  const root = await createTempProject();
  const calls: Array<{ command: string; args: string[] }> = [];
  const pm2Homes: Array<string | undefined> = [];
  const commandRunner: CommandRunner = async (command, args, options) => {
    calls.push({ command, args });
    if (command === 'pm2') {
      pm2Homes.push(options?.env?.PM2_HOME);
    }
    if (command === 'pm2' && args[0] === '--help') {
      return commandResult({ stdout: '7.0.1' });
    }
    if (command === 'pm2' && args[0] === 'jlist') {
      const started = calls.some((call) => call.command === 'pm2' && call.args[0] === 'start');
      return commandResult({
        stdout: started
          ? JSON.stringify([{ name: 'Queue Worker', pid: 990001, pm2_env: { status: 'online' } }])
          : '[]',
      });
    }
    return commandResult({ stdout: 'started' });
  };

  const executor = new TaskExecutor(root, new ConfigRepository(root), new LogBroker(), commandRunner);
  const result = await executor.execute({
    runtime: 'pm2',
    serviceName: 'Queue Worker',
    action: 'start',
  });

  assert.equal(result.ok, true);
  assert.deepEqual(calls.find((call) => call.args[0] === 'start'), {
    command: 'pm2',
    args: ['start', path.join(root, 'ecosystem.config.js'), '--only', 'Queue Worker', '--update-env'],
  });
  assert.ok(pm2Homes.length >= 3);
  assert.ok(pm2Homes.every((pm2Home) => pm2Home === path.join(root, '.locallink', 'pm2')));
});

test('TaskExecutor derives a PM2 launch from an app-owned Dockerfile.locallink', async () => {
  const root = await createTempProject();
  await fs.writeFile(path.join(root, 'ecosystem.config.js'), 'module.exports = { apps: [] };\n', 'utf8');
  await fs.writeFile(
    path.join(root, 'locallink.services.yml'),
    [
      'services:',
      '  - name: Direct Worker',
      '    group: pm2',
      '    runtime: pm2',
      '    runtimeName: direct-worker',
      '    cwd: .',
      '',
    ].join('\n'),
    'utf8',
  );

  const calls: Array<{ command: string; args: string[] }> = [];
  const commandRunner: CommandRunner = async (command, args) => {
    calls.push({ command, args });
    if (command === 'pm2' && args[0] === '--help') {
      return commandResult({ stdout: '7.0.1' });
    }
    if (command === 'pm2' && args[0] === 'jlist') {
      const started = calls.some((call) => call.command === 'pm2' && call.args[0] === 'start');
      return commandResult({
        stdout: started
          ? JSON.stringify([{ name: 'direct-worker', pid: 990002, pm2_env: { status: 'online' } }])
          : '[]',
      });
    }
    return commandResult({ stdout: 'started' });
  };

  const executor = new TaskExecutor(root, new ConfigRepository(root), new LogBroker(), commandRunner);
  const result = await executor.execute({
    runtime: 'pm2',
    serviceName: 'Direct Worker',
    action: 'start',
  });

  assert.equal(result.ok, true);
  assert.deepEqual(calls.find((call) => call.args[0] === 'start'), {
    command: 'pm2',
    args: ['start', './worker.js', '--name', 'direct-worker', '--update-env', '--cwd', root],
  });
});

test('TaskExecutor deletes the obsolete PM2 process before a restart replacement', async () => {
  const root = await createTempProject();
  const calls: Array<{ command: string; args: string[] }> = [];
  const commandRunner: CommandRunner = async (command, args) => {
    calls.push({ command, args });
    if (command === 'pm2' && args[0] === '--help') {
      return commandResult({ stdout: '7.0.1' });
    }
    if (command === 'pm2' && args[0] === 'jlist') {
      const replaced = calls.some((call) => call.command === 'pm2' && call.args[0] === 'start');
      return commandResult({
        stdout: JSON.stringify([{
          name: 'Queue Worker',
          pid: replaced ? 990004 : 990003,
          pm2_env: { status: 'online' },
        }]),
      });
    }
    return commandResult({ stdout: 'started' });
  };

  const executor = new TaskExecutor(root, new ConfigRepository(root), new LogBroker(), commandRunner);
  const result = await executor.execute({
    runtime: 'pm2',
    serviceName: 'Queue Worker',
    action: 'restart',
  });

  assert.equal(result.ok, true);
  assert.deepEqual(calls.find((call) => call.args[0] === 'delete'), {
    command: 'pm2',
    args: ['delete', 'Queue Worker'],
  });
  assert.deepEqual(calls.find((call) => call.args[0] === 'start'), {
    command: 'pm2',
    args: ['start', path.join(root, 'ecosystem.config.js'), '--only', 'Queue Worker', '--update-env'],
  });
  assert.match(result.command, /ecosystem\.config\.js/);
});

test('TaskExecutor start is idempotent and preserves an online PM2 process', async () => {
  const root = await createTempProject();
  const calls: string[][] = [];
  const commandRunner: CommandRunner = async (command, args) => {
    if (command === 'which') return commandResult({ stdout: '/usr/bin/pm2' });
    if (command === 'pm2') calls.push(args);
    if (command === 'pm2' && args[0] === '--help') return commandResult({ stdout: '7.0.1' });
    if (command === 'pm2' && args[0] === 'jlist') {
      return commandResult({ stdout: JSON.stringify([{ name: 'Queue Worker', pid: 991001, pm2_env: { status: 'online' } }]) });
    }
    return commandResult();
  };
  const result = await new TaskExecutor(root, new ConfigRepository(root), new LogBroker(), commandRunner).execute({
    runtime: 'pm2', serviceName: 'Queue Worker', action: 'start',
  });
  assert.equal(result.ok, true);
  assert.equal(calls.some((args) => args[0] === 'delete'), false);
  assert.equal(calls.some((args) => args[0] === 'start'), false);
  assert.match(result.stdout, /already online/i);
});

test('TaskExecutor up does not delete an online PM2 process when replacement is unnecessary', async () => {
  const root = await createTempProject();
  const calls: string[][] = [];
  const commandRunner: CommandRunner = async (command, args) => {
    if (command === 'which') return commandResult({ stdout: '/usr/bin/pm2' });
    if (command === 'pm2') calls.push(args);
    if (command === 'pm2' && args[0] === '--help') return commandResult({ stdout: '7.0.1' });
    if (command === 'pm2' && args[0] === 'jlist') {
      return commandResult({ stdout: JSON.stringify([{ name: 'Queue Worker', pid: 991002, pm2_env: { status: 'online' } }]) });
    }
    return commandResult({ ok: false, code: 1, stderr: 'replacement failed' });
  };
  const result = await new TaskExecutor(root, new ConfigRepository(root), new LogBroker(), commandRunner).execute({
    runtime: 'pm2', serviceName: 'Queue Worker', action: 'up',
  });
  assert.equal(result.ok, true);
  assert.equal(calls.some((args) => args[0] === 'delete'), false);
});

test('TaskExecutor only warns when a PM2 service blueprint is missing', async () => {
  const root = await createTempProject();
  await fs.rm(path.join(root, 'Dockerfile'));
  await fs.writeFile(
    path.join(root, 'ecosystem.config.js'),
    "module.exports = {\n  apps: [\n    {\n      name: 'Queue Worker',\n      script: './worker.js',\n      locallink: {\n        group: 'pm2',\n        runtime: 'pm2',\n      },\n    },\n  ],\n};\n",
    'utf8',
  );

  const calls: Array<{ command: string; args: string[] }> = [];
  const logs = new LogBroker();
  const commandRunner: CommandRunner = async (command, args) => {
    calls.push({ command, args });
    if (command === 'pm2' && args[0] === '--help') {
      return commandResult({ stdout: '7.0.1' });
    }
    if (command === 'pm2' && args[0] === 'jlist') {
      const started = calls.some((call) => call.command === 'pm2' && call.args[0] === 'start');
      return commandResult({
        stdout: started
          ? JSON.stringify([{ name: 'Queue Worker', pid: 990005, pm2_env: { status: 'online' } }])
          : '[]',
      });
    }
    return commandResult({ stdout: 'started' });
  };

  const executor = new TaskExecutor(root, new ConfigRepository(root), logs, commandRunner);
  const result = await executor.execute({
    runtime: 'pm2',
    serviceName: 'Queue Worker',
    action: 'start',
  });

  assert.equal(result.ok, true);
  assert.deepEqual(calls.find((call) => call.args[0] === 'start'), {
    command: 'pm2',
    args: ['start', path.join(root, 'ecosystem.config.js'), '--only', 'Queue Worker', '--update-env'],
  });
  assert.match(
    logs.list().map((entry) => entry.message).join(' '),
    /Dockerfile blueprint/i,
  );
});

test('TaskExecutor does not report a replacement healthy until PM2 reports it online', async () => {
  const root = await createTempProject();
  let started = false;
  const commandRunner: CommandRunner = async (command, args) => {
    if (command === 'pm2' && args[0] === '--help') {
      return commandResult({ stdout: 'PM2 help' });
    }
    if (command === 'pm2' && args[0] === 'start') {
      started = true;
      return commandResult({ stdout: 'started' });
    }
    if (command === 'pm2' && args[0] === 'jlist') {
      return commandResult({
        stdout: started
          ? JSON.stringify([{ name: 'Queue Worker', pid: 990006, pm2_env: { status: 'stopped' } }])
          : '[]',
      });
    }
    return commandResult();
  };

  const executor = new TaskExecutor(root, new ConfigRepository(root), new LogBroker(), commandRunner);
  const result = await executor.execute({
    runtime: 'pm2',
    serviceName: 'Queue Worker',
    action: 'start',
  });

  assert.equal(result.ok, false);
  assert.match(result.stderr, /did not report.*ready/i);
});

test('TaskExecutor reload uses the same delete-and-replace path as restart', async () => {
  const root = await createTempProject();
  const calls: string[][] = [];
  const commandRunner: CommandRunner = async (command, args) => {
    if (command === 'which') {
      return commandResult({ stdout: '/usr/bin/pm2' });
    }
    calls.push(args);
    if (args[0] === 'jlist') {
      const replaced = calls.some((call) => call[0] === 'start');
      return commandResult({
        stdout: JSON.stringify([{
          name: 'Queue Worker',
          pid: replaced ? 990008 : 990007,
          pm2_env: { status: 'online' },
        }]),
      });
    }
    return commandResult();
  };

  const executor = new TaskExecutor(root, new ConfigRepository(root), new LogBroker(), commandRunner);
  const result = await executor.execute({
    runtime: 'pm2',
    serviceName: 'Queue Worker',
    action: 'reload',
  });

  assert.equal(result.ok, true);
  assert.deepEqual(calls.map((args) => args[0]), ['jlist', 'delete', 'start', 'jlist']);
});

test('TaskExecutor refuses restart when it cannot derive a safe replacement launch', async () => {
  const root = await createTempProject();
  await fs.writeFile(path.join(root, 'ecosystem.config.js'), 'module.exports = { apps: [] };\n', 'utf8');
  await fs.writeFile(
    path.join(root, 'locallink.services.yml'),
    'services:\n  - name: Metadata Only\n    group: pm2\n    runtime: pm2\n    runtimeName: metadata-only\n',
    'utf8',
  );
  await fs.rm(path.join(root, 'Dockerfile'));
  const pm2Calls: string[][] = [];
  const commandRunner: CommandRunner = async (command, args) => {
    if (command === 'pm2') {
      pm2Calls.push(args);
    }
    return commandResult({ stdout: command === 'which' ? '/usr/bin/pm2' : '' });
  };
  const logs = new LogBroker();
  const executor = new TaskExecutor(root, new ConfigRepository(root), logs, commandRunner);

  await assert.rejects(
    () => executor.execute({
      runtime: 'pm2',
      serviceName: 'Metadata Only',
      action: 'restart',
    }),
    (error: unknown) => error instanceof Error && 'code' in error && error.code === 'PM2_LAUNCH_UNAVAILABLE',
  );
  assert.equal(pm2Calls.length, 0);
  assert.ok(logs.list().some((entry) => /safely restart/i.test(entry.message)));
});

test('TaskExecutor starts an already-online metadata-only PM2 service without launch metadata', async () => {
  const root = await createTempProject();
  await fs.writeFile(path.join(root, 'ecosystem.config.js'), 'module.exports = { apps: [] };\n', 'utf8');
  await fs.writeFile(
    path.join(root, 'locallink.services.yml'),
    'services:\n  - name: Metadata Only\n    group: pm2\n    runtime: pm2\n    runtimeName: metadata-only\n',
    'utf8',
  );
  await fs.rm(path.join(root, 'Dockerfile'));
  const calls: string[][] = [];
  const commandRunner: CommandRunner = async (command, args) => {
    if (command === 'which') return commandResult({ stdout: '/usr/bin/pm2' });
    if (command === 'pm2') calls.push(args);
    if (command === 'pm2' && args[0] === 'jlist') {
      return commandResult({ stdout: JSON.stringify([{ name: 'metadata-only', pid: 991003, pm2_env: { status: 'online' } }]) });
    }
    return commandResult({ ok: false, code: 1, stderr: 'must not launch' });
  };
  const result = await new TaskExecutor(root, new ConfigRepository(root), new LogBroker(), commandRunner).execute({
    runtime: 'pm2', serviceName: 'Metadata Only', action: 'start',
  });
  assert.equal(result.ok, true);
  assert.equal(result.command, 'pm2 jlist');
  assert.deepEqual(calls.map((args) => args[0]), ['jlist']);
});

test('TaskExecutor resurrects through the canonical workspace PM2 home', async () => {
  const root = await createTempProject();
  const homes: Array<string | undefined> = [];
  const commandRunner: CommandRunner = async (command, args, options) => {
    if (command === 'which') {
      return commandResult({ stdout: '/usr/bin/pm2' });
    }
    homes.push(options?.env?.PM2_HOME);
    if (args[0] === 'jlist') {
      return commandResult({
        stdout: JSON.stringify([{ name: 'Queue Worker', pid: 990009, pm2_env: { status: 'online' } }]),
      });
    }
    return commandResult({ stdout: 'resurrected' });
  };
  const executor = new TaskExecutor(root, new ConfigRepository(root), new LogBroker(), commandRunner);

  const result = await executor.executePm2WorkspaceAction('resurrect');

  assert.equal(result.ok, true);
  assert.equal(result.pm2Home, path.join(root, '.locallink', 'pm2'));
  assert.ok(homes.every((home) => home === result.pm2Home));
});

test('TaskExecutor save is a no-op when the workspace daemon is absent', async () => {
  const root = await createTempProject();
  let calls = 0;
  const commandRunner: CommandRunner = async () => {
    calls += 1;
    return commandResult();
  };
  const executor = new TaskExecutor(root, new ConfigRepository(root), new LogBroker(), commandRunner);

  const result = await executor.executePm2WorkspaceAction('save');

  assert.equal(result.ok, true);
  assert.match(result.stdout, /no active process list to save/i);
  assert.equal(calls, 0);
});

test('TaskExecutor logs PM2 isolation refusal as an alert', async () => {
  const root = await createTempProject();
  const pm2Home = path.join(root, '.locallink', 'pm2');
  await fs.mkdir(pm2Home, { recursive: true });
  await fs.writeFile(path.join(pm2Home, 'pm2.pid'), '99999999\n', 'utf8');
  const logs = new LogBroker();
  const executor = new TaskExecutor(root, new ConfigRepository(root), logs, async () => commandResult());

  await assert.rejects(
    () => executor.execute({
      runtime: 'pm2',
      serviceName: 'Queue Worker',
      action: 'start',
    }),
    (error: unknown) => error instanceof Error && 'code' in error && error.code === 'PM2_STALE_DAEMON_STATE',
  );
  assert.ok(logs.list().some((entry) => entry.stream === 'Alerts' && /stale daemon state/i.test(entry.message)));
});

test('TaskExecutor waits for the declared service port before reporting PM2 ready', async () => {
  const root = await createTempProject();
  await fs.writeFile(path.join(root, '.env'), 'QUEUE_WORKER_PORT=6012\n', 'utf8');
  await fs.writeFile(
    path.join(root, 'ecosystem.config.js'),
    "module.exports = { apps: [{ name: 'Queue Worker', script: './worker.js', locallink: { group: 'pm2', runtime: 'pm2', portEnv: 'QUEUE_WORKER_PORT' } }] };\n",
    'utf8',
  );
  let started = false;
  let readinessChecks = 0;
  const commandRunner: CommandRunner = async (command, args) => {
    if (command === 'which') {
      return commandResult({ stdout: '/usr/bin/pm2' });
    }
    if (args[0] === 'start') {
      started = true;
      return commandResult();
    }
    if (args[0] === 'jlist') {
      return commandResult({
        stdout: started
          ? JSON.stringify([{ name: 'Queue Worker', pid: 990010, pm2_env: { status: 'online' } }])
          : '[]',
      });
    }
    return commandResult();
  };
  const executor = new TaskExecutor(
    root,
    new ConfigRepository(root),
    new LogBroker(),
    commandRunner,
    async (host, port) => {
      assert.equal(host, '127.0.0.1');
      assert.equal(port, 6012);
      readinessChecks += 1;
      return readinessChecks >= 2;
    },
  );

  const result = await executor.execute({
    runtime: 'pm2',
    serviceName: 'Queue Worker',
    action: 'start',
  });

  assert.equal(result.ok, true);
  assert.equal(readinessChecks, 2);
});
