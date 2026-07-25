import type { IdentityInstallPlan } from '../extensions/identity-planner';
import type { ObservabilityInstallPlan } from '../extensions/observability-planner';
import type { ExtensionInstallPlan } from '../extensions/planner';
import type {
  ProjectModel,
  ServiceDefinition,
  ServiceIdentityIntegration,
  ServiceObservabilityIntegration,
} from '../shared/contracts';
import { AppError } from '../shared/errors';

export type ApplicationPrivateEdgeState =
  | 'not-declared'
  | 'not-selected'
  | 'waiting-runtime'
  | 'ready-to-publish'
  | 'ready'
  | 'conflict';

export type ApplicationIdentityState =
  | 'not-declared'
  | 'waiting-provider'
  | 'waiting-private-edge'
  | 'waiting-client-registration'
  | 'ready';

export type ApplicationObservabilityState =
  | 'not-declared'
  | 'waiting-infrastructure'
  | 'ready';

export interface ApplicationContractEnvironmentValue {
  key: string;
  value?: string;
  secret: boolean;
  configured: boolean;
  source: 'derived' | 'user';
}

export interface ApplicationServiceContract {
  version: 1;
  workspace: ExtensionInstallPlan['workspace'];
  service: {
    id: string;
    name: string;
    group: ServiceDefinition['group'];
    runtime?: ServiceDefinition['runtime'];
    runtimeName?: string;
    definitionSource?: ServiceDefinition['definitionSource'];
    port?: string;
    portEnv?: string;
  };
  local: {
    url?: string;
  };
  privateEdge: {
    state: ApplicationPrivateEdgeState;
    declared: boolean;
    selected: boolean;
    routeStatus?: 'active' | 'missing' | 'conflict';
    url?: string;
    requiresConfirmation: boolean;
    detail: string;
  };
  identity: {
    state: ApplicationIdentityState;
    declared: boolean;
    provider: 'oidc';
    adapter?: 'pocket-id';
    issuerUrl?: string;
    discoveryUrl?: string;
    callbackUrl?: string;
    postLogoutRedirectUrl?: string;
    scopes: string[];
    confidentialClient: true;
    environment: ApplicationContractEnvironmentValue[];
    manualRegistrationRequired: boolean;
    detail: string;
  };
  observability: {
    state: ApplicationObservabilityState;
    declared: boolean;
    provider: 'opentelemetry';
    topology: 'docker' | 'host';
    endpoint?: string;
    protocol: 'http/protobuf';
    serviceName: string;
    deliveryVerified: boolean;
    lastDeliveryVerifiedAt?: string;
    environment: ApplicationContractEnvironmentValue[];
    detail: string;
  };
  nextSteps: string[];
}

export interface BuildApplicationContractInput {
  model: ProjectModel;
  edgePlan: ExtensionInstallPlan;
  identityPlan?: IdentityInstallPlan;
  identityPlanError?: string;
  observabilityPlan?: ObservabilityInstallPlan;
  observabilityPlanError?: string;
  selector: string;
}

function configured(value: string | undefined): boolean {
  if (!value?.trim()) return false;
  return !/(?:example\.com|example-tailnet|change[-_]?me|<[^>]+>)/i.test(value);
}

function environmentPrefix(service: ServiceDefinition): string {
  return service.id
    .toUpperCase()
    .replace(/[^A-Z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '') || 'SERVICE';
}

function defaultIdentityIntegration(service: ServiceDefinition): ServiceIdentityIntegration {
  return {
    callbackPath: '/auth/oidc/callback',
    postLogoutPath: '/',
    scopes: ['openid', 'profile', 'email'],
    envPrefix: environmentPrefix(service),
  };
}

function defaultObservabilityIntegration(service: ServiceDefinition): ServiceObservabilityIntegration {
  return { serviceName: service.id };
}

function joinUrl(origin: string | undefined, path: string): string | undefined {
  if (!origin) return undefined;
  try {
    const url = new URL(origin);
    const basePath = url.pathname.replace(/\/+$/, '');
    url.pathname = `${basePath}${path.startsWith('/') ? path : `/${path}`}` || '/';
    url.search = '';
    url.hash = '';
    return url.toString();
  } catch {
    return undefined;
  }
}

function discoveryUrl(issuer: string | undefined): string | undefined {
  return joinUrl(issuer, '/.well-known/openid-configuration');
}

function resolveService(definitions: ServiceDefinition[], selector: string): ServiceDefinition {
  const normalized = selector.trim().toLowerCase();
  if (!normalized) {
    throw new AppError('MISSING_SERVICE_SELECTOR', 'A service id, name, or runtime name is required.', 400);
  }

  const score = (service: ServiceDefinition): number => {
    if (service.runtimeName?.toLowerCase() === normalized) return 3;
    if (service.id.toLowerCase() === normalized) return 2;
    if (service.name.toLowerCase() === normalized) return 1;
    return 0;
  };
  const matches = definitions
    .map((service) => ({ service, score: score(service) }))
    .filter((candidate) => candidate.score > 0);
  const bestScore = Math.max(0, ...matches.map((candidate) => candidate.score));
  const best = matches.filter((candidate) => candidate.score === bestScore).map((candidate) => candidate.service);

  if (best.length === 0) {
    const available = definitions
      .map((service) => `${service.name} (${service.id}${service.runtimeName ? `, runtime ${service.runtimeName}` : ''})`)
      .join(', ');
    throw new AppError(
      'UNKNOWN_SERVICE',
      `Service "${selector}" was not found. Available services: ${available || 'none'}.`,
      404,
    );
  }
  if (best.length === 1) return best[0];

  const explicit = best.filter((service) => service.definitionSource === 'services');
  if (explicit.length === 1) return explicit[0];
  const integrated = best.filter((service) => service.integrations);
  if (integrated.length === 1) return integrated[0];

  throw new AppError(
    'AMBIGUOUS_SERVICE',
    `Service selector "${selector}" matches multiple declarations: ${best.map((service) => (
      `${service.name} (${service.id}, ${service.definitionSource || service.group}${service.runtimeName ? `, runtime ${service.runtimeName}` : ''})`
    )).join(', ')}. Use an exact unique runtime name or remove the duplicate declaration.`,
    409,
  );
}

function privateEdgeContract(
  service: ServiceDefinition,
  edgePlan: ExtensionInstallPlan,
): ApplicationServiceContract['privateEdge'] {
  const declared = edgePlan.steps.some((step) => step.id === 'declare-private-edge' && step.status === 'complete');
  const selected = edgePlan.selection.selected.some((candidate) => candidate.id === service.id);
  const route = edgePlan.routePlan.routes.find((candidate) => candidate.serviceId === service.id);

  let state: ApplicationPrivateEdgeState;
  if (!declared) state = 'not-declared';
  else if (!selected) state = 'not-selected';
  else if (route?.status === 'conflict' || edgePlan.routePlan.state === 'conflict') state = 'conflict';
  else if (route?.status === 'active' && route.url) state = 'ready';
  else if (route?.status === 'missing' && route.url && edgePlan.routePlan.confirmationToken) state = 'ready-to-publish';
  else state = 'waiting-runtime';

  const detail = state === 'ready'
    ? `The service is privately reachable at ${route?.url}.`
    : state === 'ready-to-publish'
      ? 'A deterministic private URL is ready, but publishing still requires explicit confirmation of a fresh Private Edge plan.'
      : state === 'not-selected'
        ? 'The service is not selected for Private Edge exposure.'
        : state === 'not-declared'
          ? 'Private Edge is not enabled for this workspace.'
          : state === 'conflict'
            ? route?.detail || edgePlan.routePlan.summary
            : edgePlan.routePlan.summary;

  return {
    state,
    declared,
    selected,
    routeStatus: route?.status,
    url: route?.url,
    requiresConfirmation: state === 'ready-to-publish',
    detail,
  };
}

function identityContract(
  service: ServiceDefinition,
  model: ProjectModel,
  identityPlan: IdentityInstallPlan | undefined,
  planError: string | undefined,
  privateEdge: ApplicationServiceContract['privateEdge'],
): ApplicationServiceContract['identity'] {
  const integration = service.integrations?.identity || defaultIdentityIntegration(service);
  const declared = Boolean(service.integrations?.identity);
  const prefix = integration.envPrefix;
  const keys = {
    issuer: `${prefix}_OIDC_ISSUER_URL`,
    clientId: `${prefix}_OIDC_CLIENT_ID`,
    clientSecret: `${prefix}_OIDC_CLIENT_SECRET`,
    redirect: `${prefix}_OIDC_REDIRECT_URI`,
    postLogout: `${prefix}_OIDC_POST_LOGOUT_REDIRECT_URI`,
    scopes: `${prefix}_OIDC_SCOPES`,
  };
  const callbackUrl = joinUrl(privateEdge.url, integration.callbackPath);
  const postLogoutRedirectUrl = joinUrl(privateEdge.url, integration.postLogoutPath);
  const clientIdConfigured = configured(model.env[keys.clientId]);
  const clientSecretConfigured = configured(model.env[keys.clientSecret]);
  const providerReady = Boolean(identityPlan?.service.healthy && identityPlan.service.issuer);

  let state: ApplicationIdentityState;
  if (!declared) state = 'not-declared';
  else if (!providerReady) state = 'waiting-provider';
  else if (privateEdge.state !== 'ready') state = 'waiting-private-edge';
  else if (!clientIdConfigured || !clientSecretConfigured) state = 'waiting-client-registration';
  else state = 'ready';

  const detail = state === 'ready'
    ? 'The provider, private callback, and local client credential references are configured.'
    : state === 'waiting-client-registration'
      ? 'Create one confidential OIDC client with the exact callback/logout values below, then store its client ID and secret in the named local environment keys.'
      : state === 'waiting-private-edge'
        ? 'Publish the application Private Edge route before registering its stable HTTPS callback.'
        : state === 'waiting-provider'
          ? planError || identityPlan?.summary || 'The workspace identity provider is not installed and healthy yet.'
          : 'Declare the service identity integration before LocalLink treats OIDC as part of its application contract.';

  return {
    state,
    declared,
    provider: 'oidc',
    adapter: identityPlan?.provider,
    issuerUrl: identityPlan?.service.issuer,
    discoveryUrl: discoveryUrl(identityPlan?.service.issuer),
    callbackUrl,
    postLogoutRedirectUrl,
    scopes: integration.scopes,
    confidentialClient: true,
    environment: [
      {
        key: keys.issuer,
        value: identityPlan?.service.issuer,
        secret: false,
        configured: Boolean(identityPlan?.service.issuer),
        source: 'derived',
      },
      {
        key: keys.clientId,
        secret: false,
        configured: clientIdConfigured,
        source: 'user',
      },
      {
        key: keys.clientSecret,
        secret: true,
        configured: clientSecretConfigured,
        source: 'user',
      },
      {
        key: keys.redirect,
        value: callbackUrl,
        secret: false,
        configured: Boolean(callbackUrl),
        source: 'derived',
      },
      {
        key: keys.postLogout,
        value: postLogoutRedirectUrl,
        secret: false,
        configured: Boolean(postLogoutRedirectUrl),
        source: 'derived',
      },
      {
        key: keys.scopes,
        value: integration.scopes.join(' '),
        secret: false,
        configured: integration.scopes.length > 0,
        source: 'derived',
      },
    ],
    manualRegistrationRequired: !clientIdConfigured || !clientSecretConfigured,
    detail,
  };
}

function observabilityContract(
  service: ServiceDefinition,
  model: ProjectModel,
  observabilityPlan: ObservabilityInstallPlan | undefined,
  planError: string | undefined,
): ApplicationServiceContract['observability'] {
  const integration = service.integrations?.observability || defaultObservabilityIntegration(service);
  const declared = Boolean(service.integrations?.observability);
  const topology = service.group === 'docker' || service.runtime === 'docker' ? 'docker' : 'host';
  const endpoint = topology === 'docker'
    ? observabilityPlan?.telemetry.dockerReceiverHttpEndpoint
      || (configured(model.env.LOCALLINK_OTEL_DOCKER_ENDPOINT) ? model.env.LOCALLINK_OTEL_DOCKER_ENDPOINT : undefined)
    : observabilityPlan?.telemetry.receiverHttpEndpoint
      || (configured(model.env.OTEL_EXPORTER_OTLP_ENDPOINT) ? model.env.OTEL_EXPORTER_OTLP_ENDPOINT : undefined);
  const protocol: 'http/protobuf' = observabilityPlan?.telemetry.protocol || 'http/protobuf';
  const infrastructureReady = Boolean(
    observabilityPlan?.collector.healthy
    && observabilityPlan.collector.configured
    && observabilityPlan.collector.deliveryVerified,
  );
  const state: ApplicationObservabilityState = !declared
    ? 'not-declared'
    : infrastructureReady
      ? 'ready'
      : 'waiting-infrastructure';
  const detail = state === 'ready'
    ? `Send OTLP/HTTP from this ${topology} runtime to the workspace collector; no OpenObserve credential belongs in the application.`
    : state === 'waiting-infrastructure'
      ? planError || observabilityPlan?.summary || 'The workspace telemetry collector is not installed and verified yet.'
      : 'Declare the service observability integration and a stable service name before LocalLink treats telemetry as part of its application contract.';

  return {
    state,
    declared,
    provider: 'opentelemetry',
    topology,
    endpoint,
    protocol,
    serviceName: integration.serviceName,
    deliveryVerified: Boolean(observabilityPlan?.collector.deliveryVerified),
    lastDeliveryVerifiedAt: observabilityPlan?.collector.lastDeliveryVerifiedAt,
    environment: [
      {
        key: 'OTEL_EXPORTER_OTLP_ENDPOINT',
        value: endpoint,
        secret: false,
        configured: infrastructureReady,
        source: 'derived',
      },
      {
        key: 'OTEL_EXPORTER_OTLP_PROTOCOL',
        value: protocol,
        secret: false,
        configured: infrastructureReady,
        source: 'derived',
      },
      {
        key: 'OTEL_SERVICE_NAME',
        value: integration.serviceName,
        secret: false,
        configured: declared,
        source: 'derived',
      },
    ],
    detail,
  };
}

export function buildApplicationServiceContract(
  input: BuildApplicationContractInput,
): ApplicationServiceContract {
  const service = resolveService(input.model.definitions, input.selector);
  const privateEdge = privateEdgeContract(service, input.edgePlan);
  const identity = identityContract(
    service,
    input.model,
    input.identityPlan,
    input.identityPlanError,
    privateEdge,
  );
  const observability = observabilityContract(
    service,
    input.model,
    input.observabilityPlan,
    input.observabilityPlanError,
  );
  const localUrl = service.port && service.port !== '—'
    ? `http://127.0.0.1:${service.port}`
    : undefined;
  const nextSteps: string[] = [];

  if (privateEdge.state === 'not-declared') {
    nextSteps.push('Enable Private Edge with `locallink extension apply private-edge <service>`.');
  } else if (privateEdge.state === 'not-selected') {
    const completeSelection = [
      ...input.edgePlan.selection.selected.map((candidate) => candidate.id),
      service.id,
    ];
    nextSteps.push(
      `Review \`locallink extension plan private-edge ${completeSelection.join(' ')}\`, then apply that complete selection so existing routes are preserved.`,
    );
  } else if (privateEdge.state === 'ready-to-publish') {
    nextSteps.push('Review `locallink extension plan private-edge` and explicitly apply its fresh route confirmation token.');
  } else if (privateEdge.state === 'waiting-runtime' || privateEdge.state === 'conflict') {
    nextSteps.push(`Resolve Private Edge first: ${privateEdge.detail}`);
  }

  if (!identity.declared) {
    nextSteps.push('Declare `integrations.identity` for the service, including callback/logout paths, scopes, and its environment prefix.');
  } else if (identity.state === 'waiting-provider') {
    nextSteps.push('Finish `locallink extension plan identity` before registering an application client.');
  } else if (identity.state === 'waiting-client-registration') {
    nextSteps.push('Complete the Pocket ID administrator/passkey setup, create the application OIDC client, and store its returned ID/secret only in the named local keys.');
  }

  if (!observability.declared) {
    nextSteps.push('Declare `integrations.observability.serviceName` and instrument the application with an OpenTelemetry SDK.');
  } else if (observability.state === 'waiting-infrastructure') {
    nextSteps.push('Finish `locallink extension apply observability` and require its end-to-end collector verification to pass.');
  }

  return {
    version: 1,
    workspace: input.edgePlan.workspace,
    service: {
      id: service.id,
      name: service.name,
      group: service.group,
      runtime: service.runtime,
      runtimeName: service.runtimeName,
      definitionSource: service.definitionSource,
      port: service.port === '—' ? undefined : service.port,
      portEnv: service.portEnv,
    },
    local: { url: localUrl },
    privateEdge,
    identity,
    observability,
    nextSteps,
  };
}
