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

test('ConfigRepository loads optional service metadata from ecosystem and compose definitions', async () => {
  const root = await createTempProject();
  await fs.writeFile(
    path.join(root, 'docker-compose.yml'),
    'services:\n  postgres:\n    image: postgres:16-alpine\n    labels:\n      locallink.name: Postgres Compose\n      locallink.group: docker\n      locallink.dependsOn: auth\n      locallink.downstream: api;worker\n      locallink.envVars: POSTGRES_PORT\n      locallink.docsUrl: https://example.com/postgres\n',
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
