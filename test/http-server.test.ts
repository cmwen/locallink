import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { AppContext } from '../src/app-context';

async function createTempProject(): Promise<string> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'locallink-http-'));
  await fs.mkdir(path.join(root, 'public'), { recursive: true });
  await fs.writeFile(path.join(root, 'public', 'index.html'), '<!doctype html><title>ok</title>', 'utf8');
  await fs.writeFile(path.join(root, 'public', 'dashboard.html'), '<!doctype html><title>ok</title>', 'utf8');
  await fs.writeFile(path.join(root, 'public', 'template.html'), '<!doctype html><title>ok</title>', 'utf8');
  await fs.writeFile(path.join(root, 'public', 'manifest.webmanifest'), '{}', 'utf8');
  await fs.writeFile(path.join(root, 'public', 'sw.js'), '// sw', 'utf8');
  await fs.writeFile(
    path.join(root, '.env'),
    'LOCALLINK_BIND_HOST=127.0.0.1\nLOCALLINK_WEB_PORT=4010\nLOCALLINK_DEFAULT_PORT_START=5000\nPOSTGRES_PORT=5432\n',
    'utf8',
  );
  await fs.writeFile(
    path.join(root, 'docker-compose.yml'),
    'services:\n  postgres:\n    image: postgres:16-alpine\n    ports:\n      - "${POSTGRES_PORT}:5432"\n',
    'utf8',
  );
  await fs.writeFile(
    path.join(root, 'ecosystem.config.js'),
    "module.exports = {\n  apps: [\n    {\n      name: 'Queue Worker',\n      script: './worker.js',\n      locallink: {\n        group: 'pm2',\n        runtime: 'pm2',\n        notes: 'Worker service.',\n        detail: 'Processes local jobs.',\n        tags: ['pm2', 'worker'],\n      },\n    },\n  ],\n};\n",
    'utf8',
  );

  return root;
}

test('HTTP server exposes the dashboard state endpoint', async () => {
  const root = await createTempProject();
  const context = new AppContext(root);
  await context.initialize();
  const server = context.createServer();

  const response = await server.inject({
    method: 'GET',
    url: '/api/state',
  });

  assert.equal(response.statusCode, 200);
  const payload = response.json();
  assert.equal(payload.app.name, 'LocalLink');
  assert.ok(Array.isArray(payload.services));
  assert.ok(Array.isArray(payload.extensions));
  assert.equal(payload.pwa.manifest, 'Valid');
  assert.ok(Array.isArray(payload.diagnostics.checks));
  assert.ok(payload.resources.system.cpuPercent >= 0);
  assert.ok(payload.resources.system.memoryPercent >= 0);
  assert.ok(Array.isArray(payload.resources.history));
  assert.ok(Array.isArray(payload.resources.topCpu));
  assert.ok(Array.isArray(payload.resources.topMemory));

  await server.close();
});

test('HTTP health identifies the current workspace', async () => {
  const root = await createTempProject();
  const context = new AppContext(root);
  await context.initialize();
  const server = context.createServer();

  const response = await server.inject({ method: 'GET', url: '/health' });

  assert.equal(response.statusCode, 200);
  assert.equal(response.json().ok, true);
  assert.match(response.json().workspace.id, /^locallink-http-/);
  assert.equal(response.json().workspace.name, path.basename(root));
  await server.close();
});

test('AppContext records and clears the workspace runtime URL', async () => {
  const root = await createTempProject();
  const context = new AppContext(root);
  await context.initialize();

  const descriptor = await context.recordRuntimeBinding({
    host: '127.0.0.1',
    port: 4567,
    automatic: true,
  });
  const persisted = JSON.parse(await fs.readFile(context.paths.runtimeStateFile, 'utf8'));

  assert.equal(persisted.id, descriptor.id);
  assert.equal(persisted.url, 'http://127.0.0.1:4567');
  assert.equal(persisted.pid, process.pid);

  await context.clearRuntimeBinding();
  await assert.rejects(() => fs.readFile(context.paths.runtimeStateFile, 'utf8'), { code: 'ENOENT' });
});

test('HTTP server exposes static project docs', async () => {
  const root = await createTempProject();
  const context = new AppContext(root);
  await context.initialize();
  const server = context.createServer();

  const response = await server.inject({
    method: 'GET',
    url: '/docs/',
  });

  assert.equal(response.statusCode, 200);
  assert.match(response.body, /LocalLink Documentation/);

  const pocketIdGuide = await server.inject({
    method: 'GET',
    url: '/docs/pocket-id-tailscale.html',
  });
  assert.equal(pocketIdGuide.statusCode, 200);
  assert.match(pocketIdGuide.body, /Private application SSO with Pocket ID and Tailscale/);

  const extensionGuide = await server.inject({ method: 'GET', url: '/docs/extensions.html' });
  assert.equal(extensionGuide.statusCode, 200);
  assert.match(extensionGuide.body, /How LocalLink out-of-box extensions work/);

  await server.close();
});

test('HTTP server exposes direct workspace shell routes', async () => {
  const root = await createTempProject();
  const context = new AppContext(root);
  await context.initialize();
  const server = context.createServer();

  for (const url of ['/dashboard', '/current', '/extensions', '/external', '/resources']) {
    const response = await server.inject({
      method: 'GET',
      url,
    });

    assert.equal(response.statusCode, 200);
    assert.match(response.body, /<title>LocalLink - Dashboard<\/title>|<title>ok<\/title>/);
  }

  await server.close();
});

test('HTTP server persists workspace workflows', async () => {
  const root = await createTempProject();
  const context = new AppContext(root);
  await context.initialize();
  const server = context.createServer();

  const preferences = await server.inject({
    method: 'PATCH',
    url: '/api/workspace/settings',
    payload: { edgeEnabled: true, pocketIdEnabled: false },
  });
  assert.equal(preferences.statusCode, 200);
  assert.equal(preferences.json().edgeEnabled, true);
  assert.equal(preferences.json().pocketIdEnabled, false);

  const runtime = await server.inject({
    method: 'POST',
    url: '/api/workspace/runtimes',
    payload: { name: 'Temp API', type: 'Docker', port: 6080, command: 'docker run api' },
  });
  assert.equal(runtime.statusCode, 200);
  assert.equal(runtime.json().temporaryRuntimes[0].status, 'planned');

  const update = await server.inject({
    method: 'POST',
    url: '/api/workspace/updates',
    payload: { from: '0.12.4', to: '0.13.0' },
  });
  assert.equal(update.statusCode, 200);
  assert.equal(update.json().versionUpdates[0].status, 'queued');

  const missingIdentity = await server.inject({
    method: 'POST',
    url: '/api/processes/999999/terminate',
    payload: { signal: 'SIGTERM' },
  });
  assert.equal(missingIdentity.statusCode, 400);

  await server.close();
});
