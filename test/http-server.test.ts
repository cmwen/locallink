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
  await fs.writeFile(
    path.join(root, 'locallink.services.yml'),
    [
      'services:',
      '  - name: Managed Tool',
      '    group: pm2',
      '    runtime: pm2',
      '    source:',
      '      type: manual',
      '      ref: ./worker.js',
      '    version:',
      '      desired: 0.1.0',
      '',
    ].join('\n'),
    'utf8',
  );
  await fs.writeFile(path.join(root, 'locallink.lock.json'), '{\n  "services": {}\n}\n', 'utf8');

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

test('HTTP server keeps dashboard routes disabled in headless API mode', async () => {
  const root = await createTempProject();
  const context = new AppContext(root);
  await context.initialize();
  const server = context.createServer();

  const rootResponse = await server.inject({
    method: 'GET',
    url: '/',
  });
  assert.equal(rootResponse.statusCode, 200);
  assert.equal(rootResponse.json().dashboard, 'disabled');

  const dashboardResponse = await server.inject({
    method: 'GET',
    url: '/dashboard',
  });
  assert.equal(dashboardResponse.statusCode, 404);
  assert.equal(dashboardResponse.json().code, 'DASHBOARD_DISABLED');

  await server.close();
});

test('HTTP server serves dashboard routes when dashboard mode is enabled', async () => {
  const root = await createTempProject();
  const context = new AppContext(root);
  await context.initialize();
  const server = context.createServer({ dashboardEnabled: true });

  const response = await server.inject({
    method: 'GET',
    url: '/dashboard',
  });

  assert.equal(response.statusCode, 200);
  assert.match(response.body, /doctype html/i);

  await server.close();
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

  await server.close();
});

test('HTTP server exposes tool workspace and trial planning endpoints', async () => {
  const root = await createTempProject();
  const context = new AppContext(root);
  await context.initialize();
  const server = context.createServer();

  const toolsResponse = await server.inject({
    method: 'GET',
    url: '/api/tools',
  });
  assert.equal(toolsResponse.statusCode, 200);
  assert.ok(Array.isArray(toolsResponse.json().versions));

  const planResponse = await server.inject({
    method: 'POST',
    url: '/api/tools/trials/plan',
    payload: {
      serviceName: 'Trial Tool',
      toolSource: { type: 'npm', ref: 'trial-tool' },
      runtime: 'pm2',
      version: 'latest',
    },
  });
  assert.equal(planResponse.statusCode, 200);
  assert.match(planResponse.json().planId, /^plan-/);

  await server.close();
});

test('HTTP server exposes optional extension status', async () => {
  const root = await createTempProject();
  await fs.writeFile(
    path.join(root, 'locallink.extensions.yml'),
    [
      'extensions:',
      '  - id: dashboard',
      '    enabled: true',
      '  - id: openobserve',
      '    enabled: true',
      '    requiredEnv:',
      '      - LOCALLINK_TEST_OPENOBSERVE_TOKEN_MISSING',
      '',
    ].join('\n'),
    'utf8',
  );
  const context = new AppContext(root);
  await context.initialize();
  const server = context.createServer();

  const response = await server.inject({
    method: 'GET',
    url: '/api/extensions',
  });
  assert.equal(response.statusCode, 200);
  const payload = response.json();
  assert.ok(Array.isArray(payload.extensions));
  assert.ok(payload.extensions.some((extension: { id: string }) => extension.id === 'dashboard'));
  assert.ok(payload.extensions.some((extension: { status: string }) => extension.status === 'needs_config'));

  await server.close();
});
