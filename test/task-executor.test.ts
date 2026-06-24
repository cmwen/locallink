import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { ConfigRepository } from '../src/config/files';
import { LogBroker } from '../src/logs/broker';
import { PortAllocator, type PortScanResult } from '../src/ports/allocator';
import { TaskExecutor } from '../src/tasks/executor';
import type { CommandOptions, CommandRunner, CommandResult } from '../src/shared/utils';

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

test('TaskExecutor starts registry PM2 services from Dockerfile blueprint CMD', async () => {
  const root = await createTempProject();
  await fs.writeFile(
    path.join(root, 'locallink.services.yml'),
    [
      'services:',
      '  - name: Queue Worker',
      '    group: pm2',
      '    runtime: pm2',
      '    runtimeName: queue-worker',
      '    cwd: .',
      '    blueprint: ./Dockerfile',
      '',
    ].join('\n'),
    'utf8',
  );
  await fs.writeFile(
    path.join(root, 'ecosystem.config.js'),
    "module.exports = {\n  apps: [],\n};\n",
    'utf8',
  );
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
    args: ['start', './worker.js', '--name', 'queue-worker', '--update-env', '--cwd', root],
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

test('TaskExecutor brings a workspace up and down including enabled dashboard extension', async () => {
  const root = await createTempProject();
  await fs.writeFile(
    path.join(root, '.env'),
    [
      'LOCALLINK_SYSTEM_ID=test-system',
      'LOCALLINK_API_PORT=4210',
      'LOCALLINK_DASHBOARD_PORT=4211',
      'LOCALLINK_DEFAULT_PORT_START=5200',
      'LOCALLINK_DASHBOARD_ENABLED=true',
      '',
    ].join('\n'),
    'utf8',
  );
  await fs.writeFile(
    path.join(root, 'locallink.services.yml'),
    [
      'services:',
      '  - name: Queue Worker',
      '    group: pm2',
      '    runtime: pm2',
      '    runtimeName: queue-worker',
      '    cwd: .',
      '    blueprint: ./Dockerfile',
      '  - name: Helper Task',
      '    group: pm2',
      '    runtime: taskfile',
      '    taskName: helper',
      '',
    ].join('\n'),
    'utf8',
  );
  await fs.writeFile(
    path.join(root, 'locallink.extensions.yml'),
    [
      'extensions:',
      '  - id: dashboard',
      '    enabled: true',
      '',
    ].join('\n'),
    'utf8',
  );
  const calls: Array<{ command: string; args: string[]; options?: CommandOptions }> = [];
  const commandRunner: CommandRunner = async (command, args, options) => {
    calls.push({ command, args, options });
    if (command === 'pm2' && args[0] === '--version') {
      return commandResult({ stdout: '7.0.1' });
    }
    if (command === 'pm2' && args[0] === 'jlist') {
      return commandResult({ stdout: '[]' });
    }
    if (command === 'task' && args[0] === '--version') {
      return commandResult({ stdout: '3.0.0' });
    }
    return commandResult({ stdout: 'ok' });
  };
  class TestPortAllocator extends PortAllocator {
    override async isPortAvailable(port: number): Promise<boolean> {
      return port === 5200 || port === 5201;
    }

    override async findNextAvailablePort(startFrom = 5000): Promise<PortScanResult> {
      return {
        startFrom,
        nextFree: startFrom <= 5200 ? 5200 : 5201,
        busy: [],
      };
    }
  }

  const executor = new TaskExecutor(root, new ConfigRepository(root), new LogBroker(), commandRunner, '/app', new TestPortAllocator());
  const up = await executor.executeWorkspaceLifecycle('up');
  const down = await executor.executeWorkspaceLifecycle('down');

  assert.equal(up.ok, true);
  assert.equal(down.ok, true);
  assert.ok(calls.some((call) => call.command === 'pm2' && call.args.includes('locallink-test-system-api')));
  assert.ok(calls.some((call) => call.command === 'pm2' && call.args.includes('locallink-test-system-dashboard')));
  assert.ok(calls.some((call) => call.command === 'pm2' && call.args.includes('queue-worker')));
  assert.ok(calls.some((call) => call.command === 'task' && call.args[0] === 'helper:up'));
  assert.ok(calls.some((call) => call.command === 'task' && call.args[0] === 'helper:stop'));
  assert.ok(calls.some((call) => call.command === 'pm2' && call.args[0] === 'delete' && call.args[1] === 'locallink-test-system-api'));
  const apiStart = calls.find((call) => call.command === 'pm2' && call.args.includes('locallink-test-system-api') && call.args[0] === 'start');
  const dashboardStart = calls.find((call) => call.command === 'pm2' && call.args.includes('locallink-test-system-dashboard') && call.args[0] === 'start');
  assert.equal(apiStart?.options?.env?.LOCALLINK_API_PORT, '5200');
  assert.equal(dashboardStart?.options?.env?.LOCALLINK_DASHBOARD_PORT, '5201');
});
