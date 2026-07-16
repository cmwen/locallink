import assert from 'node:assert/strict';
import test from 'node:test';

import { buildResourceDashboard, inspectProcess, parseProcessTable, reviewProcessTermination, terminateProcess } from '../src/runtime/resources';
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
  const processes = parseProcessTable('101 1 48.2 900000 3600 node /srv/api.js --port 4010\n102 1 3.4 120000 120 bash /bin/bash\n');

  assert.equal(processes[0].pid, 101);
  assert.equal(processes[0].command, '/srv/api.js --port 4010');
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
  assert.equal(dashboard.scope, 'host');
  assert.equal(dashboard.processes.length, 2);
  assert.equal(dashboard.system.processCount, 2);
  assert.equal(dashboard.topCpu[0]?.pid, 101);
  assert.equal(dashboard.topMemory[0]?.pid, 101);
  assert.equal(dashboard.history.length > 0, true);
  assert.equal(dashboard.system.cpuPercent >= 0 && dashboard.system.cpuPercent <= 100, true);
  assert.equal(dashboard.system.memoryPercent >= 0 && dashboard.system.memoryPercent <= 100, true);

  const inspection = await inspectProcess(101, commandRunner);
  assert.equal(inspection.pid, 101);
  assert.match(inspection.command, /api\.js/);
});

test('terminateProcess protects the LocalLink process itself', async () => {
  await assert.rejects(() => terminateProcess(process.pid, 'SIGTERM'));
});

test('resource dashboard attributes PM2 processes to workspace services', async () => {
  const commandRunner: CommandRunner = async (command, args) => {
    if (command === 'ps') {
      return commandResult({ stdout: '101 1 12.0 120000 3600 node /workspace/worker.js\n102 1 8.0 100000 2000 node /opt/other.js\n' });
    }
    if (command === 'pm2') {
      return commandResult({ stdout: JSON.stringify([{ name: 'Queue Worker', pid: 101 }]) });
    }
    return commandResult({ ok: false, code: null });
  };

  const dashboard = await buildResourceDashboard(commandRunner, [{
    id: 'queue-worker',
    name: 'Queue Worker',
    kind: 'Worker',
    group: 'pm2',
    runtime: 'pm2',
    notes: 'Worker',
    detail: 'Worker',
    tags: 'pm2',
  }]);

  assert.equal(dashboard.workspaceProcesses.length, 1);
  assert.equal(dashboard.workspaceProcesses[0]?.serviceId, 'queue-worker');
  assert.equal(dashboard.workspaceProcesses[0]?.attributionConfidence, 'exact');
  assert.equal(dashboard.hostProcesses.length, 2);
});

test('termination review reports identity, children, and open ports', async () => {
  const commandRunner: CommandRunner = async (_command, args) => {
    if (args[0] === '-p') return commandResult({ stdout: '101 1 2.0 50000 60 node /workspace/worker.js\n' });
    if (args[0] === '-eo') return commandResult({ stdout: '101 1 2.0 50000 60 node /workspace/worker.js\n103 101 1.0 10000 10 node /workspace/child.js\n' });
    return commandResult({ stdout: 'node 101u IPv4 0x0 TCP 127.0.0.1:4010->127.0.0.1:5000 (LISTEN)\n' });
  };

  const review = await reviewProcessTermination(101, commandRunner);
  assert.equal(review.pid, 101);
  assert.equal(review.canTerminate, true);
  assert.equal(review.dependents.length, 1);
  assert.deepEqual(review.ports, [':4010']);
  assert.match(review.identityToken, /^101:/);
});
