import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { buildPhase2Advisor } from '../src/runtime/phase2';
import type { CommandRunner, CommandResult } from '../src/shared/utils';

function result(overrides: Partial<CommandResult> = {}): CommandResult {
  return {
    ok: true,
    code: 0,
    signal: null,
    stdout: '',
    stderr: '',
    timedOut: false,
    ...overrides,
  };
}

test('buildPhase2Advisor respects opt-out configuration', async () => {
  const advisor = await buildPhase2Advisor({
    LOCALLINK_ENABLE_PHASE2_ADVISOR: 'false',
  });

  assert.equal(advisor.enabled, false);
  assert.match(advisor.summary, /disabled/i);
});

test('buildPhase2Advisor surfaces detected tailscale, reverse proxy, and private application SSO options', async () => {
  const commandRunner: CommandRunner = async (command, args) => {
    if (command === 'tailscale') {
      return result({
        stdout: JSON.stringify({
          CurrentTailnet: { Name: 'example.ts.net' },
          Self: { TailscaleIPs: ['100.101.102.103'] },
        }),
      });
    }
    if (command === 'caddy' && args[0] === 'version') {
      return result({ stdout: 'v2.9.0' });
    }
    return result({ ok: false, code: null, stderr: `spawn ${command} ENOENT`, error: `spawn ${command} ENOENT` });
  };

  const advisor = await buildPhase2Advisor(
    {
      LOCALLINK_ENABLE_PHASE2_ADVISOR: 'true',
      LOCALLINK_PHASE2_PREFERRED_EDGE: 'tailscale',
      POCKET_ID_APP_URL: 'https://id.example.org',
    },
    commandRunner,
  );

  assert.equal(advisor.enabled, true);
  assert.match(advisor.summary, /Phase 2 edge option/i);
  assert.equal(advisor.options[0].status, 'available');
  assert.equal(advisor.options[0].recommended, true);
  assert.equal(advisor.options[1].status, 'available');
  const pocketId = advisor.options.find((option) => option.id === 'pocket-id');
  assert.equal(pocketId?.status, 'available');
  assert.equal(pocketId?.detectedValue, 'https://id.example.org');
});

test('buildPhase2Advisor keeps placeholder Pocket ID issuers in setup state', async () => {
  const commandRunner: CommandRunner = async (command) => result({
    ok: false,
    code: null,
    stderr: `spawn ${command} ENOENT`,
    error: `spawn ${command} ENOENT`,
  });
  const advisor = await buildPhase2Advisor({ POCKET_ID_APP_URL: 'https://id.example.com' }, commandRunner);
  assert.equal(advisor.options.find((option) => option.id === 'pocket-id')?.status, 'optional');
});

test('buildPhase2Advisor detects Caddy from the current workspace Docker Compose project', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'locallink-caddy-advisor-'));
  await fs.writeFile(path.join(root, 'docker-compose.yml'), 'services:\n  edge-proxy:\n    image: caddy:2-alpine\n', 'utf8');
  const commandRunner: CommandRunner = async (command) => {
    if (command === 'docker') return result({ stdout: JSON.stringify({ State: 'running' }) });
    return result({ ok: false, code: null, stderr: `spawn ${command} ENOENT`, error: `spawn ${command} ENOENT` });
  };

  const advisor = await buildPhase2Advisor({}, commandRunner, root);
  const reverseProxyOption = advisor.options.find((option) => option.id === 'reverse-proxy');
  assert.equal(reverseProxyOption?.status, 'available');
  assert.match(reverseProxyOption?.detectedValue || '', /Caddy \(Docker Compose\)/);
});
