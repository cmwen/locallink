import assert from 'node:assert/strict';
import test from 'node:test';

import type { IdentityInstallPlan } from '../src/extensions/identity-planner';
import type { ObservabilityInstallPlan } from '../src/extensions/observability-planner';
import type { ExtensionInstallPlan } from '../src/extensions/planner';
import {
  buildApplicationServiceContract,
  type BuildApplicationContractInput,
} from '../src/services/application-contract';
import type { ProjectModel } from '../src/shared/contracts';

function input(overrides: Partial<BuildApplicationContractInput> = {}): BuildApplicationContractInput {
  const workspace = {
    id: 'workspace-one',
    name: 'Workspace One',
    root: '/tmp/workspace-one',
    dockerProject: 'locallink-workspace-one',
    pm2Home: '/tmp/workspace-one/.locallink/pm2/workspace-one',
  };
  const model: ProjectModel = {
    env: {
      EXAMPLE_API_OIDC_CLIENT_ID: 'client-id-present',
      EXAMPLE_API_OIDC_CLIENT_SECRET: 'do-not-return-this-secret',
    },
    definitions: [{
      id: 'example-api',
      name: 'Example API',
      kind: 'Docker',
      group: 'docker',
      runtime: 'docker',
      runtimeName: 'example-api-runtime',
      definitionSource: 'compose',
      port: '5100',
      portEnv: 'EXAMPLE_API_PORT',
      notes: 'Example.',
      detail: 'Example API.',
      tags: 'api',
      integrations: {
        identity: {
          callbackPath: '/auth/oidc/callback',
          postLogoutPath: '/signed-out',
          scopes: ['openid', 'profile', 'email'],
          envPrefix: 'EXAMPLE_API',
        },
        observability: {
          serviceName: 'workspace-one.example-api',
        },
      },
    }],
    extensions: [],
  };
  const edgePlan = {
    workspace,
    capability: 'private-edge',
    state: 'complete',
    summary: 'ready',
    canApply: false,
    selection: {
      requested: false,
      selected: [{ id: 'example-api', name: 'Example API', port: '5100' }],
      available: [{ id: 'example-api', name: 'Example API', port: '5100' }],
    },
    routePlan: {
      adapter: 'tailscale-caddy',
      state: 'in-sync',
      summary: 'ready',
      mutatesHost: false,
      requiresConfirmation: true,
      applySupported: true,
      prerequisites: [],
      generatedFiles: [],
      routes: [{
        serviceId: 'example-api',
        serviceName: 'Example API',
        targetPort: '5100',
        proxyPort: '20510',
        httpsPort: '7510',
        url: 'https://machine.tailnet.ts.net:7510/',
        status: 'active',
        detail: 'active',
        apply: { command: 'docker', args: [] },
        rollback: { command: 'docker', args: [] },
      }],
    },
    reconciliation: {
      adapter: 'tailscale-caddy',
      state: 'clean',
      summary: 'clean',
      requiresConfirmation: true,
      removals: [],
    },
    steps: [{
      id: 'declare-private-edge',
      label: 'Declare',
      owner: 'locallink',
      status: 'complete',
      automatic: true,
      detail: 'declared',
    }],
  } as ExtensionInstallPlan;
  const identityPlan = {
    workspace,
    capability: 'identity',
    provider: 'pocket-id',
    state: 'waiting-user',
    summary: 'healthy',
    canApply: false,
    service: {
      name: 'pocket-id',
      installed: true,
      running: true,
      healthy: true,
      persistent: true,
      port: '1411',
      issuer: 'https://machine.tailnet.ts.net:7452/',
      setupUrl: 'https://machine.tailnet.ts.net:7452/setup',
    },
    privateEdge: {
      declared: true,
      selected: true,
      state: 'in-sync',
      url: 'https://machine.tailnet.ts.net:7452/',
    },
    steps: [],
  } as IdentityInstallPlan;
  const observabilityPlan = {
    workspace,
    capability: 'observability',
    provider: 'openobserve',
    state: 'healthy',
    summary: 'healthy',
    canApply: false,
    service: {
      name: 'openobserve',
      installed: true,
      running: true,
      healthy: true,
      persistent: true,
      loopbackOnly: true,
      credentialState: 'valid',
      port: '5080',
      localUrl: 'http://127.0.0.1:5080',
    },
    collector: {
      name: 'otel-collector',
      installed: true,
      running: true,
      healthy: true,
      configured: true,
      managedByLocalLink: true,
      configurationState: 'valid',
      credentialInjectionConfigured: true,
      loopbackOnly: true,
      grpcPort: '4317',
      httpPort: '4318',
      healthPort: '13133',
      grpcEndpoint: 'http://127.0.0.1:4317',
      httpEndpoint: 'http://127.0.0.1:4318',
      healthUrl: 'http://127.0.0.1:13133/',
      configPath: '.locallink/otel-collector.yaml',
      deliveryVerified: true,
      lastDeliveryVerifiedAt: '2026-07-26T00:00:00.000Z',
    },
    telemetry: {
      organization: 'default',
      stream: 'default',
      otlpBaseUrl: 'http://127.0.0.1:5080/api/default',
      receiverGrpcEndpoint: 'http://127.0.0.1:4317',
      receiverHttpEndpoint: 'http://127.0.0.1:4318',
      dockerReceiverHttpEndpoint: 'http://otel-collector:4318',
      protocol: 'http/protobuf',
      credentialsConfigured: true,
    },
    privateEdge: {
      declared: true,
      selected: true,
      state: 'in-sync',
    },
    steps: [],
  } as ObservabilityInstallPlan;

  return {
    selector: 'example-api',
    model,
    edgePlan,
    identityPlan,
    observabilityPlan,
    ...overrides,
  };
}

test('application contract joins active edge, generic OIDC, and Docker OTLP settings without returning secrets', () => {
  const contract = buildApplicationServiceContract(input());

  assert.equal(contract.privateEdge.state, 'ready');
  assert.equal(contract.privateEdge.url, 'https://machine.tailnet.ts.net:7510/');
  assert.equal(contract.identity.state, 'ready');
  assert.equal(contract.identity.callbackUrl, 'https://machine.tailnet.ts.net:7510/auth/oidc/callback');
  assert.equal(contract.identity.postLogoutRedirectUrl, 'https://machine.tailnet.ts.net:7510/signed-out');
  assert.equal(contract.identity.discoveryUrl, 'https://machine.tailnet.ts.net:7452/.well-known/openid-configuration');
  assert.equal(contract.identity.environment.find((entry) => entry.secret)?.configured, true);
  assert.equal(contract.observability.state, 'ready');
  assert.equal(contract.observability.topology, 'docker');
  assert.equal(contract.observability.endpoint, 'http://otel-collector:4318');
  assert.equal(contract.observability.serviceName, 'workspace-one.example-api');
  assert.doesNotMatch(JSON.stringify(contract), /do-not-return-this-secret/);
  assert.doesNotMatch(JSON.stringify(contract), /OPENOBSERVE_ACCESS_KEY/i);
});

test('application contract distinguishes undeclared app integrations from healthy shared infrastructure', () => {
  const value = input();
  value.model.definitions[0].integrations = undefined;
  value.model.env = {};

  const contract = buildApplicationServiceContract(value);

  assert.equal(contract.identity.state, 'not-declared');
  assert.equal(contract.identity.environment.find((entry) => entry.key === 'EXAMPLE_API_OIDC_CLIENT_SECRET')?.value, undefined);
  assert.equal(contract.observability.state, 'not-declared');
  assert.equal(contract.observability.endpoint, 'http://otel-collector:4318');
  assert.ok(contract.nextSteps.some((step) => step.includes('integrations.identity')));
  assert.ok(contract.nextSteps.some((step) => step.includes('integrations.observability')));
});

test('application contract includes the complete existing selection when suggesting a new edge service', () => {
  const value = input();
  value.edgePlan.selection.selected = [{ id: 'existing-ui', name: 'Existing UI', port: '5200' }];
  value.edgePlan.routePlan.routes = [];

  const contract = buildApplicationServiceContract(value);

  assert.equal(contract.privateEdge.state, 'not-selected');
  assert.ok(contract.nextSteps.some((step) => (
    step.includes('private-edge existing-ui example-api')
    && step.includes('complete selection')
  )));
});

test('application contract uses the host collector endpoint for PM2 services', () => {
  const value = input();
  value.model.definitions[0] = {
    ...value.model.definitions[0],
    group: 'pm2',
    runtime: 'pm2',
  };

  const contract = buildApplicationServiceContract(value);

  assert.equal(contract.observability.topology, 'host');
  assert.equal(contract.observability.endpoint, 'http://127.0.0.1:4318');
});

test('application contract remains readable when shared observability planning is unavailable', () => {
  const value = input({
    observabilityPlan: undefined,
    observabilityPlanError: 'No collector receiver port is currently available.',
  });
  value.model.env.LOCALLINK_OTEL_DOCKER_ENDPOINT = 'http://custom-collector:4318';

  const contract = buildApplicationServiceContract(value);

  assert.equal(contract.observability.state, 'waiting-infrastructure');
  assert.equal(contract.observability.endpoint, 'http://custom-collector:4318');
  assert.equal(contract.observability.deliveryVerified, false);
  assert.match(contract.observability.detail, /No collector receiver port/);
});

test('application contract rejects unknown service selectors with available choices', () => {
  assert.throws(
    () => buildApplicationServiceContract(input({ selector: 'missing' })),
    (error: unknown) => (
      !!error
      && typeof error === 'object'
      && 'code' in error
      && error.code === 'UNKNOWN_SERVICE'
      && 'message' in error
      && String(error.message).includes('Example API')
    ),
  );
});
