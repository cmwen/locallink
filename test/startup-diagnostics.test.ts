import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { StartupDiagnosticsService } from '../src/startup/diagnostics';
import type { CommandRunner, CommandResult } from '../src/shared/utils';

async function createTempAppRoot(): Promise<string> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'locallink-diagnostics-'));
  await fs.mkdir(path.join(root, 'public'), { recursive: true });
  await fs.writeFile(
    path.join(root, 'package.json'),
    JSON.stringify(
      {
        name: 'locallink-test',
        version: '0.0.0',
        dependencies: {
          fastify: '^5.0.0',
          zod: '^4.0.0',
        },
      },
      null,
      2,
    ),
    'utf8',
  );
  await fs.writeFile(path.join(root, 'public', 'manifest.webmanifest'), '{}', 'utf8');
  await fs.writeFile(path.join(root, 'public', 'sw.js'), '// sw', 'utf8');
  return root;
}

function successResult(stdout = 'ok'): CommandResult {
  return {
    ok: true,
    code: 0,
    signal: null,
    stdout,
    stderr: '',
    timedOut: false,
  };
}

test('StartupDiagnosticsService reports install guidance for missing dependencies and tools', async () => {
  const appRoot = await createTempAppRoot();
  let pm2Invocations = 0;
  const commandRunner: CommandRunner = async (command, args) => {
    if (command === 'docker' && args[0] === '--version') {
      return successResult('Docker version 29.0.0');
    }
    if (command === 'docker' && args[0] === 'info') {
      return successResult('"29.0.0"');
    }
    if (command === 'which' && args[0] === 'pm2') {
      return {
        ok: false,
        code: null,
        signal: null,
        stdout: '',
        stderr: 'spawn pm2 ENOENT',
        timedOut: false,
        error: 'spawn pm2 ENOENT',
      };
    }
    if (command === 'pm2') {
      pm2Invocations += 1;
    }
    if (command === 'task') {
      return {
        ok: false,
        code: null,
        signal: null,
        stdout: '',
        stderr: 'spawn task ENOENT',
        timedOut: false,
        error: 'spawn task ENOENT',
      };
    }
    return successResult();
  };

  const diagnostics = await new StartupDiagnosticsService({
    workspaceRoot: appRoot,
    appRoot,
    publicDir: path.join(appRoot, 'public'),
    commandRunner,
    moduleResolver: (specifier) => {
      if (specifier === 'fastify') {
        return '/virtual/fastify/index.js';
      }
      throw new Error('missing');
    },
  }).inspect();

  assert.equal(diagnostics.status, 'error');
  assert.match(diagnostics.summary, /blocking issue/i);

  const dependencyCheck = diagnostics.checks.find((check) => check.id === 'node-dependencies');
  assert.ok(dependencyCheck);
  assert.equal(dependencyCheck.status, 'error');
  assert.match(dependencyCheck.detail, /pnpm install/i);
  assert.match(dependencyCheck.detail, /zod/i);

  const pm2Check = diagnostics.checks.find((check) => check.id === 'pm2');
  assert.ok(pm2Check);
  assert.equal(pm2Check.status, 'warn');
  assert.match(pm2Check.detail, /pnpm add -g pm2/i);
  assert.equal(pm2Invocations, 0, 'PM2 diagnostics must not initialize or connect to a daemon');
});

test('StartupDiagnosticsService flags missing PM2 package scripts without guessing a replacement', async () => {
  const appRoot = await createTempAppRoot();
  const manifest = JSON.parse(await fs.readFile(path.join(appRoot, 'package.json'), 'utf8'));
  manifest.scripts = { 'dev:lan': 'vite --host 0.0.0.0' };
  await fs.writeFile(path.join(appRoot, 'package.json'), JSON.stringify(manifest, null, 2), 'utf8');
  await fs.writeFile(
    path.join(appRoot, 'ecosystem.config.js'),
    "module.exports = { apps: [{ name: 'web', script: 'pnpm', args: 'dev:web', locallink: { runtime: 'pm2', group: 'pm2' } }] };\n",
    'utf8',
  );
  const diagnostics = await new StartupDiagnosticsService({
    workspaceRoot: appRoot,
    appRoot,
    publicDir: path.join(appRoot, 'public'),
    commandRunner: async (command, args) => {
      if (command === 'docker' && args[0] === 'info') {
        return successResult('"29.0.0"');
      }
      return successResult(command === 'which' ? '/usr/bin/pm2' : 'ok');
    },
    moduleResolver: (specifier) => `/virtual/${specifier}/index.js`,
  }).inspect();

  const drift = diagnostics.checks.find((check) => check.id === 'workspace-script-drift');
  assert.equal(drift?.status, 'warn');
  assert.match(drift?.detail || '', /dev:web/);
  assert.match(drift?.detail || '', /will not guess or substitute/i);
  assert.doesNotMatch(drift?.detail || '', /dev:lan/);
});
