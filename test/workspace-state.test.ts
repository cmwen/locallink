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
  assert.equal(defaults.preferences.pocketIdEnabled, true);
  await repository.updatePreferences({ edgeEnabled: true, pocketIdEnabled: false });
  await repository.addTemporaryRuntime({
    id: 'temp-1', name: 'Temp API', type: 'Docker', port: 6080, command: 'docker run api', createdAt: new Date().toISOString(), status: 'planned',
  });
  await repository.addVersionUpdate({ id: 'update-1', from: '1.0.0', to: '1.1.0', status: 'queued', createdAt: new Date().toISOString() });
  await repository.addPortReservation({ id: 'port-1', service: 'Temp API', port: 6080, status: 'reserved', createdAt: new Date().toISOString() });

  const restored = new WorkspaceStateRepository(file);
  const state = await restored.load();
  assert.equal(state.preferences.edgeEnabled, true);
  assert.equal(state.preferences.pocketIdEnabled, false);
  assert.equal(state.temporaryRuntimes[0]?.name, 'Temp API');
  assert.equal(state.versionUpdates[0]?.status, 'queued');
  assert.equal(state.portReservations[0]?.port, 6080);

  await restored.cancelVersionUpdate('update-1');
  await restored.releasePortReservation('port-1');
  const afterCancel = restored.read();
  assert.equal(afterCancel.versionUpdates[0]?.status, 'cancelled');
  assert.equal(afterCancel.portReservations[0]?.status, 'released');
});
