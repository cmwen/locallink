import assert from 'node:assert/strict';
import test from 'node:test';

import type { ServiceRecord } from '../frontend/src/types';
import {
  filterServices,
  matchesWorkspaceQuery,
  selectVisibleService,
  serviceMatchReason,
  serviceNeedsAttention,
} from '../frontend/src/view-model';

function service(overrides: Partial<ServiceRecord> = {}): ServiceRecord {
  return {
    id: 'queue-worker',
    name: 'Queue Worker',
    kind: 'Worker',
    group: 'pm2',
    runtime: 'pm2',
    port: '6012',
    notes: 'Consumes local jobs.',
    detail: 'Consumes local jobs and emits terminal logs.',
    tags: 'pm2 / worker',
    dependsOn: ['Postgres Compose'],
    downstream: ['LocalLink Dashboard UI'],
    envVars: ['QUEUE_WORKER_PORT'],
    docsUrl: 'https://pm2.keymetrics.io',
    status: 'stopped',
    statusLabel: 'Down',
    statusTone: 'off',
    cpu: '0%',
    memory: '0 MB',
    uptime: '-',
    reviewReasons: [],
    ...overrides,
  };
}

test('stopped services are not automatically attention items', () => {
  assert.equal(serviceNeedsAttention(service()), false);
  assert.equal(serviceNeedsAttention(service({ status: 'unknown', statusLabel: 'Unknown', statusTone: 'warn' })), true);
  assert.equal(serviceNeedsAttention(service({ compliance: { status: 'warn', summary: 'Blueprint missing', issues: [] } })), true);
});

test('documentation-only reasons do not turn operational health into attention', () => {
  assert.equal(serviceNeedsAttention(service({ reviewReasons: ['No service documentation link'] })), false);
});

test('service search explains hidden matches', () => {
  assert.equal(serviceMatchReason(service(), 'Queue Worker'), 'name');
  assert.equal(serviceMatchReason(service(), 'Postgres'), 'relationship');
  assert.equal(serviceMatchReason(service(), '6012'), 'port');
  assert.equal(serviceMatchReason(service(), 'missing'), null);
});

test('filtered selection always resolves to a visible service', () => {
  const queue = service();
  const postgres = service({ id: 'postgres', name: 'Postgres Compose', port: '5432', dependsOn: [] });
  const visible = filterServices([queue, postgres], 'all', 'Postgres Compose');

  assert.equal(visible.length, 2, 'relationship matches remain visible and can be explained');
  assert.equal(selectVisibleService(visible, 'hidden-service')?.id, 'queue-worker');
  assert.equal(selectVisibleService([postgres], 'queue-worker')?.id, 'postgres');
});

test('workspace query matching can scope extension and port content', () => {
  assert.equal(matchesWorkspaceQuery('proxy', 'Dashboard', 'Stable proxy URLs'), true);
  assert.equal(matchesWorkspaceQuery('6012', 'Queue Worker', '6012'), true);
  assert.equal(matchesWorkspaceQuery('no match', 'Dashboard', 'Stable proxy URLs'), false);
});
