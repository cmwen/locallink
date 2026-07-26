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
  assert.ok(pm2Homes.length >= 4);
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
  assert.match(result.stderr, /did not report.*online/i);
});
