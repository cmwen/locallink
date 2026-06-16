import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { ConfigRepository } from '../src/config/files';
import { LogBroker } from '../src/logs/broker';
import { PortAllocator } from '../src/ports/allocator';
import { RuntimeResolver } from '../src/runtime/snapshot';
import type { StartupDiagnostics } from '../src/shared/contracts';
import type { CommandRunner, CommandResult } from '../src/shared/utils';

const DIAGNOSTICS: StartupDiagnostics = {
  status: 'ok',
  summary: 'All startup checks passed.',
  checks: [],
};

async function createTempProject(): Promise<string> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'locallink-runtime-snapshot-'));
  await fs.mkdir(path.join(root, 'public'), { recursive: true });
  await fs.writeFile(path.join(root, 'public', 'manifest.webmanifest'), '{}', 'utf8');
  await fs.writeFile(path.join(root, 'public', 'sw.js'), '// sw', 'utf8');
  await fs.writeFile(
    path.join(root, '.env'),
    'LOCALLINK_BIND_HOST=127.0.0.1\nLOCALLINK_WEB_PORT=4010\nLOCALLINK_DEFAULT_PORT_START=5000\nPOSTGRES_PORT=5432\nQUEUE_WORKER_PORT=6012\n',
    'utf8',
  );
  await fs.writeFile(
    path.join(root, 'docker-compose.yml'),
    [
      'services:',
      '  postgres:',
      '    image: postgres:16-alpine',
      '    ports:',
      '      - "${POSTGRES_PORT}:5432"',
      '    labels:',
      '      locallink.name: Postgres Compose',
      '      locallink.group: docker',
      '      locallink.runtime: docker',
      '      locallink.portEnv: POSTGRES_PORT',
      '',
    ].join('\n'),
    'utf8',
  );
  await fs.writeFile(
    path.join(root, 'ecosystem.config.js'),
    [
      'module.exports = {',
      '  apps: [',
      '    {',
      "      name: 'queue-worker',",
      "      script: './worker.js',",
      "      env: { PORT: process.env.QUEUE_WORKER_PORT || '6012' },",
      '      locallink: {',
      "        name: 'Queue Worker',",
      "        group: 'pm2',",
      "        runtime: 'pm2',",
      "        dockerfile: './Dockerfile',",
      "        portEnv: 'QUEUE_WORKER_PORT',",
      '      },',
      '    },',
      '    {',
      "      name: 'Windows File Indexer',",
      "      script: 'task',",
      "      args: 'windows-file-indexer:start',",
      '      locallink: {',
      "        group: 'windows',",
      "        runtime: 'taskfile',",
      "        windowsProcessName: 'SearchIndexer.exe',",
      '      },',
      '    },',
      '  ],',
      '};',
      '',
    ].join('\n'),
    'utf8',
  );
  await fs.writeFile(path.join(root, 'package.json'), JSON.stringify({ name: 'runtime-snapshot-test', version: '0.0.0' }, null, 2), 'utf8');
  await fs.writeFile(path.join(root, 'worker.js'), 'setInterval(() => {}, 1000);\n', 'utf8');
  await fs.writeFile(
    path.join(root, 'Dockerfile'),
    'FROM node:24-alpine\nENV PORT=6012\nEXPOSE 6012\nCMD ["node", "./worker.js"]\n',
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

async function buildState(root: string, commandRunner: CommandRunner) {
  const resolver = new RuntimeResolver(
    root,
    path.join(root, 'public'),
    new ConfigRepository(root),
    new PortAllocator(),
    new LogBroker(),
    commandRunner,
  );

  return resolver.buildDashboardState(DIAGNOSTICS);
}

test('RuntimeResolver marks unverifiable services as unknown', async () => {
  const root = await createTempProject();
  const commandRunner: CommandRunner = async (command) => {
    if (command === 'ps') {
      return commandResult();
    }

    return commandResult({
      ok: false,
      code: null,
      stderr: `spawn ${command} ENOENT`,
      error: `spawn ${command} ENOENT`,
    });
  };

  const state = await buildState(root, commandRunner);
  const services = new Map(state.services.map((service) => [service.name, service]));

  assert.equal(services.get('Postgres Compose')?.status, 'unknown');
  assert.equal(services.get('Queue Worker')?.status, 'unknown');
  assert.equal(services.get('Windows File Indexer')?.status, 'unknown');
  assert.match(state.snapshot.detail, /rehydrated/i);
});

test('RuntimeResolver marks declared Docker and PM2 services down when managers report no matching runtime', async () => {
  const root = await createTempProject();
  const commandRunner: CommandRunner = async (command, args) => {
    if (command === 'ps') {
      return commandResult();
    }
    if (command === 'docker' && args[0] === 'compose') {
      return commandResult({ stdout: '' });
    }
    if (command === 'docker' && args[0] === 'stats') {
      return commandResult({ stdout: '' });
    }
    if (command === 'pm2') {
      return commandResult({ stdout: '[]' });
    }
    return commandResult();
  };

  const state = await buildState(root, commandRunner);
  const services = new Map(state.services.map((service) => [service.name, service]));

  assert.equal(services.get('Postgres Compose')?.status, 'stopped');
  assert.equal(services.get('Postgres Compose')?.statusLabel, 'Down');
  assert.equal(services.get('Queue Worker')?.status, 'stopped');
  assert.equal(services.get('Queue Worker')?.statusLabel, 'Down');
});

test('RuntimeResolver keeps building state when port scanning is unavailable', async () => {
  const root = await createTempProject();
  const commandRunner: CommandRunner = async (command, args) => {
    if (command === 'ps') {
      return commandResult();
    }
    if (command === 'docker' && args[0] === 'compose') {
      return commandResult({ stdout: '' });
    }
    if (command === 'docker' && args[0] === 'stats') {
      return commandResult({ stdout: '' });
    }
    if (command === 'pm2') {
      return commandResult({ stdout: '[]' });
    }
    return commandResult();
  };
  class UnavailablePortAllocator extends PortAllocator {
    override async findNextAvailablePort() {
      throw new Error('listen EPERM: operation not permitted 127.0.0.1:5000');
    }
  }
  const logs = new LogBroker();
  const resolver = new RuntimeResolver(
    root,
    path.join(root, 'public'),
    new ConfigRepository(root),
    new UnavailablePortAllocator(),
    logs,
    commandRunner,
  );

  const state = await resolver.buildDashboardState(DIAGNOSTICS);

  assert.equal(state.ports.busyText, 'Unavailable');
  assert.match(state.ports.rule, /Port scan unavailable/i);
  assert.equal(state.stats.find((stat) => stat.label === 'Next free port')?.value, 'Unavailable');
  assert.ok(logs.list().some((entry) => /Port scan unavailable/i.test(entry.message)));
});
