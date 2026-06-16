import assert from 'node:assert/strict';
import test from 'node:test';

import { selectPm2Row } from '../src/runtime/pm2';
import type { ServiceDefinition } from '../src/shared/contracts';

const baseDefinition: ServiceDefinition = {
  id: 'queue-worker',
  name: 'Queue Worker',
  kind: 'PM2',
  group: 'pm2',
  runtime: 'pm2',
  runtimeName: 'queue-worker',
  notes: 'Background task runner.',
  detail: 'Consumes local jobs.',
  tags: 'pm2 · worker',
};

test('selectPm2Row prefers the runtime name over a stale display-name match', () => {
  const row = selectPm2Row(baseDefinition, [
    {
      name: 'Queue Worker',
      pm2_env: {
        status: 'errored',
      },
    },
    {
      name: 'queue-worker',
      pm2_env: {
        status: 'online',
      },
    },
  ]);

  assert.equal(row?.name, 'queue-worker');
  assert.equal(row?.pm2_env?.status, 'online');
});

test('selectPm2Row falls back to the display name when no runtime-name row exists', () => {
  const row = selectPm2Row(baseDefinition, [
    {
      name: 'Queue Worker',
      pm2_env: {
        status: 'online',
      },
    },
  ]);

  assert.equal(row?.name, 'Queue Worker');
});
