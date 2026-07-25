import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { ConfigRepository } from '../src/config/files';

async function createTempProject(): Promise<string> {
  return fs.mkdtemp(path.join(os.tmpdir(), 'locallink-config-'));
}

test('ConfigRepository patches .env without dropping inline comments', async () => {
  const root = await createTempProject();
  const envPath = path.join(root, '.env');
  await fs.writeFile(envPath, 'FOO=1 # keep me\nBAR=2\n', 'utf8');

  const repository = new ConfigRepository(root);
  await repository.writeInfraConfig({
    targetFile: '.env',
    patch: {
      kind: 'env',
      set: {
        FOO: '9',
        BAZ: '3',
      },
      unset: ['BAR'],
    },
  });

  const nextContent = await fs.readFile(envPath, 'utf8');
  assert.match(nextContent, /FOO=9 # keep me/);
  assert.doesNotMatch(nextContent, /^BAR=/m);
  assert.match(nextContent, /^BAZ=3$/m);
});

test('ConfigRepository patches docker-compose.yml while preserving leading comments', async () => {
  const root = await createTempProject();
  const composePath = path.join(root, 'docker-compose.yml');
  await fs.writeFile(
    composePath,
    '# compose comment\nservices:\n  api:\n    image: node:20\n',
    'utf8',
  );

  const repository = new ConfigRepository(root);
  await repository.writeInfraConfig({
    targetFile: 'docker-compose.yml',
    patch: {
      kind: 'compose',
      serviceName: 'api',
      updates: {
        ports: ['5000:3000'],
        labels: {
          'locallink.name': 'API Service',
        },
      },
    },
  });

  const nextContent = await fs.readFile(composePath, 'utf8');
  assert.match(nextContent, /# compose comment/);
  assert.match(nextContent, /locallink\.name: API Service/);
  assert.match(nextContent, /5000:3000/);
});

test('ConfigRepository merges Compose environments, mounts, dependencies, healthchecks, and named volumes', async () => {
  const root = await createTempProject();
  const composePath = path.join(root, 'docker-compose.yml');
  await fs.writeFile(composePath, `services:
  identity:
    image: old
    environment:
      KEEP_ME: "yes"
    volumes:
      - existing-data:/existing
    depends_on:
      - database
volumes:
  existing-data: {}
`, 'utf8');
  const repository = new ConfigRepository(root);

  await repository.writeInfraConfig({
    targetFile: 'docker-compose.yml',
    patch: {
      kind: 'compose',
      serviceName: 'identity',
      updates: {
        environment: { ADD_ME: 'also' },
        volumes: ['identity-data:/app/data'],
        dependsOn: ['edge'],
        profiles: ['identity'],
        healthcheck: {
          test: ['CMD', '/app/identity', 'healthcheck'],
          interval: '10s',
          retries: 3,
        },
      },
      topLevelVolumes: {
        'identity-data': {},
      },
    },
  });

  const parsed = (await import('yaml')).parseDocument(await fs.readFile(composePath, 'utf8')).toJS() as any;
  assert.deepEqual(parsed.services.identity.environment, { KEEP_ME: 'yes', ADD_ME: 'also' });
  assert.deepEqual(parsed.services.identity.volumes, ['existing-data:/existing', 'identity-data:/app/data']);
  assert.deepEqual(parsed.services.identity.depends_on, ['database', 'edge']);
  assert.deepEqual(parsed.services.identity.profiles, ['identity']);
  assert.deepEqual(parsed.services.identity.healthcheck.test, ['CMD', '/app/identity', 'healthcheck']);
  assert.ok(parsed.volumes['existing-data']);
  assert.ok(parsed.volumes['identity-data']);
});

test('ConfigRepository patches ecosystem.config.js with process.env references', async () => {
  const root = await createTempProject();
  const ecosystemPath = path.join(root, 'ecosystem.config.js');
  await fs.writeFile(
    ecosystemPath,
    "// ecosystem comment\nmodule.exports = {\n  apps: [\n    {\n      name: 'api',\n      script: './api.js',\n    },\n  ],\n};\n",
    'utf8',
  );

  const repository = new ConfigRepository(root);
  await repository.writeInfraConfig({
    targetFile: 'ecosystem.config.js',
    patch: {
      kind: 'ecosystem',
      appName: 'api',
      updates: {
        env: {
          PORT: { sourceEnv: 'API_PORT' },
        },
        locallink: {
          group: 'pm2',
          tags: ['api', 'local'],
        },
      },
    },
  });

  const nextContent = await fs.readFile(ecosystemPath, 'utf8');
  assert.match(nextContent, /\/\/ ecosystem comment/);
  assert.match(nextContent, /PORT: process\.env\.API_PORT/);
  assert.match(nextContent, /group: "pm2"/);
  assert.match(nextContent, /tags: \["api", "local"\]/);
});

test('ConfigRepository upserts extension declarations without dropping comments', async () => {
  const root = await createTempProject();
  const extensionsPath = path.join(root, 'locallink.extensions.yml');
  await fs.writeFile(
    extensionsPath,
    '# workspace capabilities\nextensions:\n  - id: dashboard\n    name: Dashboard\n    kind: dashboard\n    enabled: true\n',
    'utf8',
  );

  const repository = new ConfigRepository(root);
  await repository.writeInfraConfig({
    targetFile: 'locallink.extensions.yml',
    patch: {
      kind: 'extension',
      extensionId: 'private-edge',
      updates: {
        name: 'Private Edge',
        kind: 'network-edge',
        enabled: true,
        command: 'tailscale',
        adapter: 'tailscale-serve',
        docsUrl: 'https://tailscale.com/docs/features/tailscale-serve',
      },
    },
  });

  const nextContent = await fs.readFile(extensionsPath, 'utf8');
  assert.match(nextContent, /# workspace capabilities/);
  assert.match(nextContent, /id: dashboard/);
  assert.match(nextContent, /id: private-edge/);
  assert.match(nextContent, /kind: network-edge/);
  assert.match(nextContent, /adapter: tailscale-serve/);

  await repository.writeInfraConfig({
    targetFile: 'locallink.extensions.yml',
    patch: {
      kind: 'extension',
      extensionId: 'private-edge',
      updates: { enabled: false },
    },
  });
  const updatedContent = await fs.readFile(extensionsPath, 'utf8');
  assert.equal((updatedContent.match(/id: private-edge/g) || []).length, 1);
  assert.match(updatedContent, /id: private-edge[\s\S]*enabled: false/);
});

test('ConfigRepository loads optional service metadata from ecosystem and compose definitions', async () => {
  const root = await createTempProject();
  await fs.writeFile(
    path.join(root, 'docker-compose.yml'),
    'services:\n  postgres:\n    image: postgres:16-alpine\n    labels:\n      locallink.name: Postgres Compose\n      locallink.group: docker\n      locallink.dependsOn: auth\n      locallink.downstream: api;worker\n      locallink.envVars: POSTGRES_PORT\n      locallink.docsUrl: https://example.com/postgres\n      locallink.oidcCallbackPath: /auth/oidc/callback\n      locallink.oidcScopes: openid;profile;email\n      locallink.oidcEnvPrefix: POSTGRES_UI\n      locallink.otelServiceName: workspace.postgres\n',
    'utf8',
  );
  await fs.writeFile(
    path.join(root, 'ecosystem.config.js'),
    "module.exports = {\n  apps: [\n    {\n      name: 'api-runtime',\n      script: './api.js',\n      locallink: {\n        name: 'API Service',\n        group: 'pm2',\n        runtime: 'pm2',\n        dependsOn: ['Postgres Compose'],\n        downstream: ['Web UI'],\n        envVars: ['API_PORT'],\n        docsUrl: 'https://example.com/api',\n      },\n    },\n  ],\n};\n",
    'utf8',
  );

  const repository = new ConfigRepository(root);
  const model = await repository.loadProjectModel();

  const apiService = model.definitions.find((definition) => definition.name === 'API Service');
  assert.ok(apiService);
  assert.deepEqual(Array.from(apiService.dependsOn || []), ['Postgres Compose']);
  assert.deepEqual(Array.from(apiService.downstream || []), ['Web UI']);
  assert.deepEqual(Array.from(apiService.envVars || []), ['API_PORT']);
  assert.equal(apiService.docsUrl, 'https://example.com/api');

  const postgres = model.definitions.find((definition) => definition.name === 'Postgres Compose');
  assert.ok(postgres);
  assert.deepEqual(postgres.dependsOn, ['auth']);
  assert.deepEqual(postgres.downstream, ['api', 'worker']);
  assert.deepEqual(postgres.envVars, ['POSTGRES_PORT']);
  assert.equal(postgres.docsUrl, 'https://example.com/postgres');
  assert.deepEqual(postgres.integrations?.identity, {
    callbackPath: '/auth/oidc/callback',
    postLogoutPath: '/',
    scopes: ['openid', 'profile', 'email'],
    envPrefix: 'POSTGRES_UI',
  });
  assert.deepEqual(postgres.integrations?.observability, {
    serviceName: 'workspace.postgres',
  });
});

test('ConfigRepository resolves loopback Compose bindings and environment fallbacks to the published port', async () => {
  const root = await createTempProject();
  await fs.writeFile(path.join(root, '.env'), 'API_PORT=5050\n', 'utf8');
  await fs.writeFile(
    path.join(root, 'docker-compose.yml'),
    [
      'services:',
      '  api:',
      '    image: example/api',
      '    ports:',
      '      - "127.0.0.1:${API_PORT}:3000"',
      '  identity:',
      '    image: example/identity',
      '    ports:',
      '      - "127.0.0.1:${IDENTITY_PORT:-1411}:1411"',
      '',
    ].join('\n'),
    'utf8',
  );

  const model = await new ConfigRepository(root).loadProjectModel();

  assert.equal(model.definitions.find((service) => service.runtimeName === 'api')?.port, '5050');
  assert.equal(model.definitions.find((service) => service.runtimeName === 'identity')?.port, '1411');
});

test('ConfigRepository loads extension declarations and reports missing setup values', async () => {
  const root = await createTempProject();
  await fs.writeFile(path.join(root, '.env'), 'POCKET_ID_PORT=1411\nPOCKET_ID_APP_URL=https://pocket-id.example-tailnet.ts.net\n', 'utf8');
  await fs.writeFile(
    path.join(root, 'locallink.extensions.yml'),
    [
      'extensions:',
      '  - id: pocket-id',
      '    name: Pocket ID',
      '    kind: identity-provider',
      '    enabled: true',
      '    exposedPorts:',
      '      - "${POCKET_ID_PORT:-1411}"',
      '    requiredEnv:',
      '      - POCKET_ID_APP_URL',
      '      - POCKET_ID_ENCRYPTION_KEY',
      '    dependsOn:',
      '      - tailscale',
      '',
    ].join('\n'),
    'utf8',
  );

  const model = await new ConfigRepository(root).loadProjectModel();
  const pocketId = model.extensions[0];
  assert.equal(pocketId?.name, 'Pocket ID');
  assert.equal(pocketId?.status, 'setup');
  assert.deepEqual(pocketId?.missingEnv, ['POCKET_ID_APP_URL', 'POCKET_ID_ENCRYPTION_KEY']);
  assert.deepEqual(pocketId?.exposedPorts, ['1411']);
  assert.deepEqual(pocketId?.dependsOn, ['tailscale']);
});

test('ConfigRepository loads locallink.services.yml and resolves app-owned Dockerfile.locallink', async () => {
  const root = await createTempProject();
  const appRoot = path.join(root, 'apps', 'api');
  await fs.mkdir(appRoot, { recursive: true });
  await fs.writeFile(path.join(root, 'docker-compose.yml'), 'services: {}\n', 'utf8');
  await fs.writeFile(
    path.join(appRoot, 'Dockerfile.locallink'),
    'FROM node:24-alpine\nEXPOSE 7123\nCMD ["node", "server.js"]\n',
    'utf8',
  );
  await fs.writeFile(
    path.join(root, 'locallink.services.yml'),
    [
      'services:',
      '  - name: API Service',
      '    group: pm2',
      '    runtime: pm2',
      '    runtimeName: api-service',
      '    cwd: ./apps/api',
      '    portEnv: API_PORT',
      '',
    ].join('\n'),
    'utf8',
  );
  await fs.writeFile(path.join(root, '.env'), 'API_PORT=7123\n', 'utf8');

  const model = await new ConfigRepository(root).loadProjectModel();
  const apiService = model.definitions.find((definition) => definition.name === 'API Service');

  assert.ok(apiService);
  assert.equal(apiService.definitionSource, 'services');
  assert.equal(apiService.cwd, appRoot);
  assert.equal(apiService.port, '7123');
  assert.equal(apiService.dockerfilePath, path.join(appRoot, 'Dockerfile.locallink'));
});

test('ConfigRepository loads CommonJS ecosystem configs that use require', async () => {
  const root = await createTempProject();
  await fs.writeFile(path.join(root, '.env'), 'API_PORT=7123\n', 'utf8');
  await fs.writeFile(
    path.join(root, 'ecosystem.config.js'),
    [
      "const fs = require('fs');",
      "const path = require('path');",
      'const envPath = path.join(__dirname, \'.env\');',
      "const envContent = fs.existsSync(envPath) ? fs.readFileSync(envPath, 'utf8') : '';",
      "const apiPort = /API_PORT=(\\d+)/.exec(envContent)?.[1] || '7000';",
      'module.exports = {',
      '  apps: [',
      '    {',
      "      name: 'api-runtime',",
      "      script: './api.js',",
      '      env: { PORT: apiPort },',
      '      locallink: {',
      "        name: 'API Service',",
      "        group: 'pm2',",
      "        runtime: 'pm2',",
      "        portEnv: 'API_PORT',",
      '      },',
      '    },',
      '  ],',
      '};',
      '',
    ].join('\n'),
    'utf8',
  );

  const repository = new ConfigRepository(root);
  const model = await repository.loadProjectModel();

  assert.equal(model.definitions.find((definition) => definition.name === 'API Service')?.port, '7123');
});

test('ConfigRepository reports ecosystem config load errors with file context', async () => {
  const root = await createTempProject();
  const ecosystemPath = path.join(root, 'ecosystem.config.js');
  await fs.writeFile(ecosystemPath, 'throw new Error("bad workspace config");\n', 'utf8');

  const repository = new ConfigRepository(root);

  await assert.rejects(
    () => repository.loadProjectModel(),
    (error) => {
      assert.ok(error instanceof Error);
      assert.match(error.message, /could not load/i);
      assert.match(error.message, new RegExp(ecosystemPath.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
      assert.match(error.message, /bad workspace config/);
      return true;
    },
  );
});

test('ConfigRepository prefers explicit process env over .env defaults', async () => {
  const root = await createTempProject();
  await fs.writeFile(
    path.join(root, '.env'),
    'LOCALLINK_WEB_PORT=4011\nAPI_PORT=7000\n',
    'utf8',
  );
  await fs.writeFile(
    path.join(root, 'ecosystem.config.js'),
    "module.exports = {\n  apps: [\n    {\n      name: 'api-runtime',\n      script: 'pnpm',\n      env: { PORT: process.env.API_PORT || '7000' },\n      locallink: {\n        name: 'API Service',\n        group: 'pm2',\n        runtime: 'pm2',\n        portEnv: 'API_PORT'\n      },\n    },\n  ],\n};\n",
    'utf8',
  );

  const previousWebPort = process.env.LOCALLINK_WEB_PORT;
  const previousApiPort = process.env.API_PORT;
  process.env.LOCALLINK_WEB_PORT = '4310';
  process.env.API_PORT = '7100';

  try {
    const repository = new ConfigRepository(root);
    const model = await repository.loadProjectModel();
    assert.equal(model.env.LOCALLINK_WEB_PORT, '4310');
    assert.equal(model.env.API_PORT, '7100');
    assert.equal(model.definitions.find((definition) => definition.name === 'API Service')?.port, '7100');
  } finally {
    if (previousWebPort === undefined) {
      delete process.env.LOCALLINK_WEB_PORT;
    } else {
      process.env.LOCALLINK_WEB_PORT = previousWebPort;
    }

    if (previousApiPort === undefined) {
      delete process.env.API_PORT;
    } else {
      process.env.API_PORT = previousApiPort;
    }
  }
});

test('ConfigRepository can make one workspace file-authoritative for long-lived control-plane processes', async () => {
  const root = await createTempProject();
  await fs.writeFile(
    path.join(root, '.env'),
    'OPENOBSERVE_PASSWORD=current-workspace-secret\nOPENOBSERVE_PORT=5510\n',
    'utf8',
  );
  const previousPassword = process.env.OPENOBSERVE_PASSWORD;
  const previousPort = process.env.OPENOBSERVE_PORT;
  process.env.OPENOBSERVE_PASSWORD = 'stale-pm2-secret';
  process.env.OPENOBSERVE_PORT = '5080';

  try {
    const repository = new ConfigRepository(root, false);
    await repository.hydrateProcessEnv();
    const model = await repository.loadProjectModel();
    assert.equal(model.env.OPENOBSERVE_PASSWORD, 'current-workspace-secret');
    assert.equal(model.env.OPENOBSERVE_PORT, '5510');
    assert.equal(process.env.OPENOBSERVE_PASSWORD, 'current-workspace-secret');
    assert.equal(process.env.OPENOBSERVE_PORT, '5510');
  } finally {
    if (previousPassword === undefined) delete process.env.OPENOBSERVE_PASSWORD;
    else process.env.OPENOBSERVE_PASSWORD = previousPassword;
    if (previousPort === undefined) delete process.env.OPENOBSERVE_PORT;
    else process.env.OPENOBSERVE_PORT = previousPort;
  }
});
