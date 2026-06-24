import assert from 'node:assert/strict';
import test from 'node:test';

import { parseCliOptions } from '../src/shared/cli-options';

test('parseCliOptions accepts --log-level before and after the command', () => {
  const before = parseCliOptions(['--log-level', 'debug', 'snapshot']);
  assert.deepEqual(before.positionals, ['snapshot']);
  assert.equal(before.logLevel, 'debug');

  const after = parseCliOptions(['web', '--log-level=warn']);
  assert.deepEqual(after.positionals, ['web']);
  assert.equal(after.logLevel, 'warn');
});

test('parseCliOptions accepts --workspace before and after the command', () => {
  const before = parseCliOptions(['--workspace', 'examples/systems/local-dev', 'api']);
  assert.deepEqual(before.positionals, ['api']);
  assert.equal(before.workspaceRoot, 'examples/systems/local-dev');

  const after = parseCliOptions(['dashboard', '--workspace=../other-system']);
  assert.deepEqual(after.positionals, ['dashboard']);
  assert.equal(after.workspaceRoot, '../other-system');
});

test('parseCliOptions accepts --json for machine-readable output', () => {
  const parsed = parseCliOptions(['status', '--json']);
  assert.deepEqual(parsed.positionals, ['status']);
  assert.equal(parsed.json, true);
});

test('parseCliOptions rejects unsupported log levels', () => {
  assert.throws(
    () => parseCliOptions(['web', '--log-level', 'verbose']),
    /Unsupported log level/i,
  );
});

test('parseCliOptions rejects missing workspace paths', () => {
  assert.throws(
    () => parseCliOptions(['api', '--workspace']),
    /workspace requires a path/i,
  );
});
