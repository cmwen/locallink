import assert from 'node:assert/strict';
import test from 'node:test';
import vm from 'node:vm';

import { formatFatalError } from '../src/shared/errors';

test('formatFatalError preserves messages from VM realm errors', () => {
  const error = vm.runInNewContext('new ReferenceError("require is not defined")') as unknown;

  assert.equal(formatFatalError(error), 'ReferenceError: require is not defined');
});

test('formatFatalError includes non-error thrown values', () => {
  assert.equal(formatFatalError(null), 'Unexpected fatal error: null');
});
