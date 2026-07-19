import assert from 'node:assert/strict';
import path from 'node:path';
import test from 'node:test';

import { PortAllocator } from '../src/ports/allocator';
import {
  buildWorkspaceProcessEnv,
  composeProjectName,
  deriveWorkspaceIdentity,
  resolveWorkspaceBinding,
} from '../src/workspace/identity';

test('workspace identity is stable and separates same-named roots', () => {
  const first = deriveWorkspaceIdentity('/tmp/one/project');
  const repeated = deriveWorkspaceIdentity('/tmp/one/project');
  const second = deriveWorkspaceIdentity('/tmp/two/project');

  assert.equal(first.id, repeated.id);
  assert.notEqual(first.id, second.id);
  assert.match(composeProjectName(first.id), /^locallink_project_/);
});

test('workspace process environment owns PM2 and Compose namespaces', () => {
  const root = path.resolve('/tmp/one/project');
  const env = buildWorkspaceProcessEnv(root, {});

  assert.equal(env.PM2_HOME, path.join(root, '.locallink', 'pm2'));
  assert.match(env.LOCALLINK_WORKSPACE_ID || '', /^project-/);
  assert.equal(env.COMPOSE_PROJECT_NAME, composeProjectName(env.LOCALLINK_WORKSPACE_ID || ''));
});

test('automatic bindings allocate a free port while numeric bindings stay pinned', async () => {
  class StubPortAllocator extends PortAllocator {
    override async findNextAvailablePort(startFrom = 5000) {
      return { startFrom, nextFree: startFrom + 2, busy: [startFrom, startFrom + 1] };
    }
  }
  const allocator = new StubPortAllocator();

  assert.deepEqual(
    await resolveWorkspaceBinding({ LOCALLINK_WEB_PORT: 'auto', LOCALLINK_WEB_PORT_START: '4010' }, '127.0.0.1', allocator),
    { host: '127.0.0.1', port: 4012, automatic: true },
  );
  assert.deepEqual(
    await resolveWorkspaceBinding({ LOCALLINK_WEB_PORT: '4400' }, '127.0.0.1', allocator),
    { host: '127.0.0.1', port: 4400, automatic: false },
  );
});
