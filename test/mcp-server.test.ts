import assert from 'node:assert/strict';
import test from 'node:test';

import { privateEdgeApplyConfirmationTokenSchema } from '../src/mcp/server';

test('MCP Private Edge apply accepts planner tokens for both supported adapters', () => {
  assert.equal(
    privateEdgeApplyConfirmationTokenSchema.safeParse(`private-edge:${'a'.repeat(64)}`).success,
    true,
  );
  assert.equal(
    privateEdgeApplyConfirmationTokenSchema.safeParse(`private-edge-caddy:${'b'.repeat(64)}`).success,
    true,
  );
  assert.equal(privateEdgeApplyConfirmationTokenSchema.safeParse('private-edge-caddy:planner-validates-this').success, true);
  assert.equal(privateEdgeApplyConfirmationTokenSchema.safeParse('private-edge-removal:token').success, false);
  assert.equal(privateEdgeApplyConfirmationTokenSchema.safeParse('unrelated:token').success, false);
});
