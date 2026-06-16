import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { enrichServiceDefinition, readDockerfileBlueprint, verifyBlueprintCompliance } from '../src/runtime/lego';
import type { ServiceDefinition } from '../src/shared/contracts';

async function createTempServiceRoot(): Promise<string> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'locallink-lego-'));
  await fs.writeFile(
    path.join(root, 'package.json'),
    JSON.stringify({ name: 'lego-test', version: '0.0.0' }, null, 2),
    'utf8',
  );
  await fs.writeFile(
    path.join(root, 'Dockerfile'),
    'FROM node:24-alpine\nENV PORT=3000 API_URL=http://service\nEXPOSE 3000\nCMD ["node", "./server.js"]\n',
    'utf8',
  );
  await fs.writeFile(path.join(root, 'server.js'), 'const port = process.env.PORT;\nserver.listen(port);\n', 'utf8');
  return root;
}

function createDefinition(root: string): ServiceDefinition {
  return {
    id: 'api-service',
    name: 'API Service',
    kind: 'PM2',
    group: 'pm2',
    runtime: 'pm2',
    runtimeName: 'api-service',
    cwd: root,
    script: './server.js',
    dockerfilePath: path.join(root, 'Dockerfile'),
    notes: 'API',
    detail: 'API service',
    tags: 'pm2 · api',
  };
}

test('readDockerfileBlueprint parses EXPOSE, ENV, and CMD', async () => {
  const root = await createTempServiceRoot();
  const blueprint = await readDockerfileBlueprint(path.join(root, 'Dockerfile'));

  assert.ok(blueprint);
  assert.deepEqual(blueprint.expose, ['3000']);
  assert.deepEqual(blueprint.envVars, ['PORT', 'API_URL']);
  assert.match(blueprint.command, /server\.js/);
});

test('verifyBlueprintCompliance passes when a Dockerfile blueprint exists', async () => {
  const root = await createTempServiceRoot();
  const goodDefinition = createDefinition(root);
  const passResult = await verifyBlueprintCompliance(goodDefinition);
  assert.equal(passResult.status, 'pass');
  assert.equal(passResult.issues.length, 0);
});

test('enrichServiceDefinition merges Dockerfile env vars into service metadata', async () => {
  const root = await createTempServiceRoot();
  const definition = createDefinition(root);
  const enriched = await enrichServiceDefinition(definition);

  assert.deepEqual(enriched.envVars, ['PORT', 'API_URL']);
  assert.equal(enriched.port, '3000');
  assert.equal(enriched.compliance?.status, 'pass');
});

test('verifyBlueprintCompliance warns when no Dockerfile blueprint is declared', async () => {
  const root = await createTempServiceRoot();
  const definition: ServiceDefinition = {
    ...createDefinition(root),
    name: 'OpenCode',
    script: 'bash',
    dockerfilePath: undefined,
  };

  const result = await verifyBlueprintCompliance(definition);
  assert.equal(result.status, 'warn');
  assert.match(result.summary, /dockerfile blueprint/i);
  assert.match(result.issues.join(' '), /Declare locallink\.dockerfile/i);
});

test('verifyBlueprintCompliance warns when the declared Dockerfile blueprint path is missing', async () => {
  const root = await createTempServiceRoot();
  const definition: ServiceDefinition = {
    ...createDefinition(root),
    dockerfilePath: path.join(root, 'Missing.Dockerfile'),
  };

  const result = await verifyBlueprintCompliance(definition);
  assert.equal(result.status, 'warn');
  assert.match(result.summary, /could not be found/i);
  assert.match(result.issues.join(' '), /Expected Dockerfile blueprint/i);
});
