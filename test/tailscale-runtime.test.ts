import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import {
  detectTailscaleRuntime,
  tailscaleRuntimeCommand,
  tailscaleStartCommand,
  tailscaleStopCommand,
} from '../src/runtime/tailscale-runtime';
import type { CommandResult, CommandRunner } from '../src/shared/utils';

function result(overrides: Partial<CommandResult> = {}): CommandResult {
  return { ok: true, code: 0, signal: null, stdout: '', stderr: '', timedOut: false, ...overrides };
}

test('detectTailscaleRuntime owns a workspace-mounted Docker sidecar config', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'locallink-tailscale-runtime-'));
  await fs.mkdir(path.join(root, 'edge'), { recursive: true });
  await fs.writeFile(path.join(root, 'edge', 'serve.json'), '{}\n', 'utf8');
  await fs.writeFile(path.join(root, 'docker-compose.yml'), `services:
  pocket-id:
    image: ghcr.io/pocket-id/pocket-id:v2
    labels:
      locallink.tags: docker,identity,oidc,tailscale
  edge:
    image: tailscale/tailscale:latest
    environment:
      TS_SERVE_CONFIG: /config/serve.json
    volumes:
      - ./edge:/config:ro
`, 'utf8');
  const runner: CommandRunner = async (command, args, options) => {
    assert.equal(command, 'docker');
    assert.equal(options?.cwd, root);
    assert.ok(args.includes('edge'));
    assert.equal(args.includes('pocket-id'), false);
    return result({ stdout: JSON.stringify({ State: 'running' }) });
  };

  const runtime = await detectTailscaleRuntime(root, runner);

  assert.equal(runtime.source, 'docker-compose');
  assert.equal(runtime.running, true);
  assert.equal(runtime.manageable, true);
  assert.equal(runtime.serviceName, 'edge');
  assert.equal(runtime.serveConfigPath, path.join(root, 'edge', 'serve.json'));
  assert.equal(runtime.serveConfigTarget, '/config/serve.json');
  assert.equal(runtime.serveConfigMount, 'directory');
  assert.deepEqual(tailscaleRuntimeCommand(runtime), {
    command: 'docker',
    argsPrefix: ['compose', '--profile', '*', 'exec', '-T', 'edge', 'tailscale'],
  });
  assert.deepEqual(tailscaleStartCommand(runtime)?.args, ['compose', '--profile', '*', 'up', '-d', 'edge']);
  assert.deepEqual(tailscaleStopCommand(runtime)?.args, ['compose', '--profile', '*', 'stop', 'edge']);
});

test('detectTailscaleRuntime accepts an existing workspace file bind but blocks external config', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'locallink-tailscale-runtime-'));
  await fs.mkdir(path.join(root, 'edge'), { recursive: true });
  await fs.writeFile(path.join(root, 'edge', 'serve.json'), '{}\n', 'utf8');
  const runner: CommandRunner = async () => result({ stdout: '' });

  await fs.writeFile(path.join(root, 'docker-compose.yml'), `services:
  edge:
    image: tailscale/tailscale:latest
    environment:
      TS_SERVE_CONFIG: /config/serve.json
    volumes:
      - ./edge/serve.json:/config/serve.json:ro
`, 'utf8');
  const fileRuntime = await detectTailscaleRuntime(root, runner);
  assert.equal(fileRuntime.manageable, true);
  assert.equal(fileRuntime.serveConfigMount, 'file');

  await fs.writeFile(path.join(root, 'docker-compose.yml'), `services:
  edge:
    image: tailscale/tailscale:latest
    environment:
      TS_SERVE_CONFIG: /config/serve.json
    volumes:
      - /opt/edge/serve.json:/config/serve.json:ro
`, 'utf8');
  const externalRuntime = await detectTailscaleRuntime(root, runner);
  assert.equal(externalRuntime.available, true);
  assert.equal(externalRuntime.manageable, false);
  assert.equal(externalRuntime.serveConfigPath, undefined);
});
