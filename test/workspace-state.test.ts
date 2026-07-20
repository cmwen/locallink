import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { WorkspaceStateRepository } from '../src/state/workspace-state';

test('workspace state persists preferences, runtime plans, updates, and reservations', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'locallink-state-'));
  const file = path.join(root, '.locallink', 'workspace-state.json');
  const repository = new WorkspaceStateRepository(file);

  const defaults = await repository.load();
  assert.equal(defaults.preferences.proxyEnabled, false);
  assert.equal(defaults.preferences.pocketIdEnabled, false);
  await repository.updatePreferences({ edgeEnabled: true, pocketIdEnabled: false });
  await repository.addTemporaryRuntime({
    id: 'temp-1', name: 'Temp API', type: 'Docker', port: 6080, command: 'docker run api', createdAt: new Date().toISOString(), status: 'planned',
  });
  await repository.addVersionUpdate({ id: 'update-1', from: '1.0.0', to: '1.1.0', status: 'queued', createdAt: new Date().toISOString() });
  await repository.addPortReservation({ id: 'port-1', service: 'Temp API', port: 6080, status: 'reserved', createdAt: new Date().toISOString() });
  await repository.upsertPrivateEdgeRoutes([{
    serviceId: 'api',
    serviceName: 'API',
    targetPort: '6080',
    httpsPort: '7443',
    url: 'https://workspace.tailnet.ts.net:7443',
    command: 'tailscale',
    applyArgs: ['serve', '--bg', '--yes', '--https=7443', 'http://127.0.0.1:6080'],
    rollbackArgs: ['serve', '--yes', '--https=7443', 'off'],
    appliedAt: new Date().toISOString(),
    status: 'active',
  }]);

  const restored = new WorkspaceStateRepository(file);
  const state = await restored.load();
  assert.equal(state.preferences.edgeEnabled, true);
  assert.equal(state.preferences.pocketIdEnabled, false);
  assert.equal(state.temporaryRuntimes[0]?.name, 'Temp API');
  assert.equal(state.versionUpdates[0]?.status, 'queued');
  assert.equal(state.portReservations[0]?.port, 6080);
  assert.equal(state.privateEdgeRoutes[0]?.serviceId, 'api');

  await restored.cancelVersionUpdate('update-1');
  await restored.releasePortReservation('port-1');
  const afterCancel = restored.read();
  assert.equal(afterCancel.versionUpdates[0]?.status, 'cancelled');
  assert.equal(afterCancel.portReservations[0]?.status, 'released');
});
