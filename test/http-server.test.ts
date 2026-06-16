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
  assert.equal(payload.pwa.manifest, 'Valid');
  assert.ok(Array.isArray(payload.diagnostics.checks));

  await server.close();
});
