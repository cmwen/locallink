import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { ConfigRepository } from '../src/config/files';
import { ToolManager } from '../src/tools/manager';
import type { CommandRunner, CommandResult } from '../src/shared/utils';

async function createTempProject(): Promise<string> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'locallink-tool-manager-'));
  await fs.writeFile(path.join(root, '.env'), '', 'utf8');
  await fs.writeFile(path.join(root, 'docker-compose.yml'), 'services: {}\n', 'utf8');
  await fs.writeFile(path.join(root, 'ecosystem.config.js'), 'module.exports = { apps: [] };\n', 'utf8');
  await fs.writeFile(
    path.join(root, 'locallink.services.yml'),
    [
      'services:',
      '  - name: Example MCP Tool',
      '    group: pm2',
      '    runtime: pm2',
      '    runtimeName: example-mcp-tool',
      '    source:',
      '      type: npm',
      '      ref: example-mcp-server',
      '    version:',
      '      desired: 1.0.0',
      '      policy: manual',
      '',
    ].join('\n'),
    'utf8',
  );
  await fs.writeFile(
    path.join(root, 'locallink.lock.json'),
    JSON.stringify({
      services: {
        'Example MCP Tool': {
          source: { type: 'npm', ref: 'example-mcp-server' },
          resolvedVersion: '1.0.0',
        },
      },
    }, null, 2),
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

test('ToolManager checks latest npm version and records drift in the lock file', async () => {
  const root = await createTempProject();
  const commandRunner: CommandRunner = async (command, args) => {
    assert.equal(command, 'npm');
    assert.deepEqual(args, ['view', 'example-mcp-server', 'version', '--json']);
    return commandResult({ stdout: '"1.2.0"\n' });
  };

  const manager = new ToolManager(root, new ConfigRepository(root), commandRunner);
  const status = await manager.checkLatestVersion('Example MCP Tool');

  assert.equal(status.latestVersion, '1.2.0');
  assert.equal(status.status, 'update_available');
  const lock = JSON.parse(await fs.readFile(path.join(root, 'locallink.lock.json'), 'utf8'));
  assert.equal(lock.services['Example MCP Tool'].latestVersion, '1.2.0');
});

test('ToolManager updates desired and locked versions when dryRun is false', async () => {
  const root = await createTempProject();
  const manager = new ToolManager(root, new ConfigRepository(root));

  const plan = await manager.updateVersion('Example MCP Tool', '1.2.0', true);
  assert.equal(plan.dryRun, true);
  assert.equal(plan.previousVersion, '1.0.0');

  const applied = await manager.updateVersion('Example MCP Tool', '1.2.0', false);
  assert.equal(applied.dryRun, false);
  const services = await fs.readFile(path.join(root, 'locallink.services.yml'), 'utf8');
  const lock = JSON.parse(await fs.readFile(path.join(root, 'locallink.lock.json'), 'utf8'));
  assert.match(services, /desired: 1\.2\.0/);
  assert.equal(lock.services['Example MCP Tool'].resolvedVersion, '1.2.0');
});

test('ToolManager provisions and promotes a temporary trial', async () => {
  const root = await createTempProject();
  const manager = new ToolManager(root, new ConfigRepository(root));

  const plan = manager.planTrial({
    serviceName: 'Scratch Tool',
    toolSource: { type: 'npm', ref: 'scratch-tool' },
    version: '0.3.0',
    runtime: 'pm2',
  });
  const provisioned = await manager.provisionTrial(plan.planId);
  assert.equal(provisioned.trial.serviceName, 'Scratch Tool');
  assert.ok(await fs.stat(provisioned.manifestPath));

  const promoted = await manager.promoteTrial(provisioned.trial.trialId);
  assert.equal(promoted.serviceName, 'Scratch Tool');
  const services = await fs.readFile(path.join(root, 'locallink.services.yml'), 'utf8');
  assert.match(services, /name: Scratch Tool/);
  const trialExists = await fs.stat(path.join(root, '.locallink', 'trials', provisioned.trial.trialId)).then(() => true, () => false);
  assert.equal(trialExists, false);
});
