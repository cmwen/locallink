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

test('parseCliOptions rejects unsupported log levels', () => {
  assert.throws(
    () => parseCliOptions(['web', '--log-level', 'verbose']),
    /Unsupported log level/i,
  );
});
