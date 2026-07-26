import assert from 'node:assert/strict';
import test from 'node:test';

import type { IdentityInstallPlan } from '../src/extensions/identity-planner';
import type { ExtensionInstallPlan } from '../src/extensions/planner';
import {
  buildWorkspaceOnboardingReport,
  formatWorkspaceOnboardingReport,
} from '../src/onboarding/report';
import type {
  ExtensionLifecycleRecord,
  StartupDiagnostics,
} from '../src/shared/contracts';

const diagnostics: StartupDiagnostics = {
  status: 'ok',
  summary: 'All startup checks passed.',
  checks: [],
};

function lifecycle(
  id: ExtensionLifecycleRecord['id'],
  declared: boolean,
): ExtensionLifecycleRecord {
  return {
    id,
    name: id,
    kind: id === 'private-edge' ? 'network-edge' : id === 'identity' ? 'identity-provider' : 'observability',
    declared,
    enabled: declared,
    state: declared ? 'installed' : 'available',
    automation: 'guided',
    summary: declared ? 'Installed.' : 'Optional.',
    checks: [],
  };
}

test('onboarding report separates automatic, manual, blocked, and optional capability work', () => {
  const edgePlan = {
    capability: 'private-edge',
    state: 'ready-to-apply',
    summary: 'Private Edge needs setup.',
    canApply: true,
    steps: [
      {
        id: 'declare',
        label: 'Write declaration',
        owner: 'locallink',
        status: 'pending',
        automatic: true,
        detail: 'Write the workspace declaration.',
        targetFile: 'locallink.extensions.yml',
      },
      {
        id: 'tailnet',
        label: 'Join the tailnet',
        owner: 'user',
        status: 'blocked',
        automatic: false,
        detail: 'Approve the device in Tailscale.',
      },
    ],
    routePlan: {
      state: 'waiting-tailscale',
    },
    reconciliation: {
      state: 'clean',
    },
  } as unknown as ExtensionInstallPlan;
  const identityPlan = {
    capability: 'identity',
    state: 'waiting-user',
    summary: 'Pocket ID is healthy; finish administrator and client setup.',
    canApply: false,
    steps: [{
      id: 'create-admin',
      label: 'Create first administrator',
      owner: 'user',
      status: 'pending',
      automatic: false,
      detail: 'Create a passkey.',
    }],
    privateEdge: {
      state: 'in-sync',
    },
  } as unknown as IdentityInstallPlan;

  const report = buildWorkspaceOnboardingReport({
    workspace: {
      id: 'workspace-one',
      name: 'Workspace One',
      root: '/tmp/workspace-one',
    },
    diagnostics,
    lifecycles: [
      lifecycle('private-edge', true),
      lifecycle('identity', true),
      lifecycle('observability', false),
    ],
    plans: {
      'private-edge': { plan: edgePlan },
      identity: { plan: identityPlan },
      observability: { error: 'No receiver port is available.' },
    },
  });

  assert.equal(report.capabilities[0].state, 'action-required');
  assert.equal(report.capabilities[0].automaticSteps[0]?.label, 'Write declaration');
  assert.equal(report.capabilities[0].manualSteps[0]?.label, 'Join the tailnet');
  assert.equal(report.capabilities[0].blockedSteps[0]?.label, 'Join the tailnet');
  assert.deepEqual(report.capabilities[0].commands, ['locallink extension apply private-edge']);
  assert.equal(report.capabilities[1].state, 'action-required');
  assert.equal(report.capabilities[2].state, 'optional');
  assert.deepEqual(report.capabilities[2].commands, ['locallink extension plan observability']);

  const formatted = formatWorkspaceOnboardingReport(report);
  assert.match(formatted, /Automatic \[pending\]: Write declaration/);
  assert.match(formatted, /Manual \[blocked\]: Join the tailnet/);
  assert.match(formatted, /Next command: locallink extension apply private-edge/);
  assert.match(formatted, /\[OPTIONAL\] Observability/);
});

test('onboarding report keeps an extension-free workspace healthy and optional', () => {
  const report = buildWorkspaceOnboardingReport({
    workspace: {
      id: 'workspace-empty',
      name: 'Empty',
      root: '/tmp/workspace-empty',
    },
    diagnostics,
    lifecycles: [
      lifecycle('private-edge', false),
      lifecycle('identity', false),
      lifecycle('observability', false),
    ],
    plans: {
      'private-edge': {},
      identity: {},
      observability: {},
    },
  });

  assert.match(report.summary, /core is ready/i);
  assert.ok(report.capabilities.every((capability) => capability.state === 'optional'));
});

test('onboarding report does not treat an explicitly disabled capability as pending work', () => {
  const disabled = lifecycle('identity', true);
  disabled.enabled = false;
  disabled.state = 'disabled';
  const report = buildWorkspaceOnboardingReport({
    workspace: {
      id: 'workspace-disabled',
      name: 'Disabled',
      root: '/tmp/workspace-disabled',
    },
    diagnostics,
    lifecycles: [
      lifecycle('private-edge', false),
      disabled,
      lifecycle('observability', false),
    ],
    plans: {
      'private-edge': {},
      identity: { error: 'The provider is unavailable.' },
      observability: {},
    },
  });

  assert.equal(report.capabilities[1].state, 'disabled');
  assert.match(report.capabilities[1].summary, /declared but disabled/i);
  assert.match(report.summary, /core is ready/i);
});
