import assert from 'node:assert/strict';
import test from 'node:test';

import { buildResourceDashboard, inspectProcess, parseProcessTable, terminateProcess } from '../src/runtime/resources';
import type { CommandRunner, CommandResult } from '../src/shared/utils';

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

test('parseProcessTable marks high CPU and RAM processes as flagged', () => {
  const processes = parseProcessTable('101 1 48.2 900000 3600 node /srv/api.js\n102 1 3.4 120000 120 bash /bin/bash\n');

  assert.equal(processes[0].pid, 101);
  assert.equal(processes[0].tone, 'warn');
  assert.match(processes[0].reason, /High CPU/);
  assert.match(processes[0].reason, /High RAM/);
  assert.equal(processes[1].tone, 'healthy');
});

test('buildResourceDashboard and inspectProcess parse ps output', async () => {
  const commandRunner: CommandRunner = async (_command, args) => {
    if (args[0] === '-eo') {
      return commandResult({
        stdout: '101 1 48.2 900000 3600 node /srv/api.js\n102 1 3.4 120000 120 bash /bin/bash\n',
      });
    }

    return commandResult({
      stdout: '101 1 48.2 900000 3600 node /srv/api.js\n',
    });
  };

  const dashboard = await buildResourceDashboard(commandRunner);
  assert.equal(dashboard.processes.length, 2);
  assert.equal(dashboard.summary[0].value, '2');

  const inspection = await inspectProcess(101, commandRunner);
  assert.equal(inspection.pid, 101);
  assert.match(inspection.command, /api\.js/);
});

test('terminateProcess protects the LocalLink process itself', async () => {
  await assert.rejects(() => terminateProcess(process.pid, 'SIGTERM'));
});
