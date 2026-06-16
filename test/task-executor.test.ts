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
  const commandRunner: CommandRunner = async (command, args) => {
    calls.push({ command, args });
    if (command === 'pm2' && args[0] === '--version') {
      return commandResult({ stdout: '7.0.1' });
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
  assert.deepEqual(calls[1], {
    command: 'pm2',
    args: ['start', path.join(root, 'ecosystem.config.js'), '--only', 'Queue Worker', '--update-env'],
  });
});

test('TaskExecutor falls back to ecosystem startup when PM2 restart target is missing', async () => {
  const root = await createTempProject();
  const calls: Array<{ command: string; args: string[] }> = [];
  const commandRunner: CommandRunner = async (command, args) => {
    calls.push({ command, args });
    if (command === 'pm2' && args[0] === '--version') {
      return commandResult({ stdout: '7.0.1' });
    }
    if (command === 'pm2' && args[0] === 'restart') {
      return commandResult({
        ok: false,
        code: 1,
        stderr: 'Process or Namespace Queue Worker not found',
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
  assert.deepEqual(calls[1], {
    command: 'pm2',
    args: ['restart', 'Queue Worker', '--update-env'],
  });
  assert.deepEqual(calls[2], {
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
    if (command === 'pm2' && args[0] === '--version') {
      return commandResult({ stdout: '7.0.1' });
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
  assert.deepEqual(calls[1], {
    command: 'pm2',
    args: ['start', path.join(root, 'ecosystem.config.js'), '--only', 'Queue Worker', '--update-env'],
  });
  assert.match(
    logs.list().map((entry) => entry.message).join(' '),
    /Dockerfile blueprint/i,
  );
});
