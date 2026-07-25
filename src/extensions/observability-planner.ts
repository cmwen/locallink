import { randomBytes } from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';

import { ConfigRepository } from '../config/files';
import { PortAllocator } from '../ports/allocator';
import { detectCaddyRuntime, readWorkspaceFile } from '../runtime/caddy-runtime';
import { parseTailscaleServeRoutes } from '../runtime/network-edge';
import {
  detectOpenObserveRuntime,
  openObserveStartCommand,
  type OpenObserveHttpProbe,
  type OpenObserveRuntimeDetection,
} from '../runtime/openobserve-runtime';
import {
  detectOtelCollectorRuntime,
  otelCollectorStartCommand,
  type OtelCollectorHttpProbe,
  type OtelLogDeliveryResult,
  type OtelLogDeliveryVerifier,
  type OtelCollectorRuntimeDetection,
  verifyOtelLogDelivery,
} from '../runtime/otel-collector-runtime';
import { detectTailscaleRuntime, tailscaleRuntimeCommand } from '../runtime/tailscale-runtime';
import type { PrivateEdgeRouteOwnership, WorkspaceExtension } from '../shared/contracts';
import { AppError } from '../shared/errors';
import type { CommandRunner } from '../shared/utils';
import { runCommand } from '../shared/utils';
import { WorkspaceStateRepository } from '../state/workspace-state';
import { deriveWorkspaceIdentity } from '../workspace/identity';
import {
  OTEL_COLLECTOR_CONFIG_RELATIVE_PATH,
  OTEL_COLLECTOR_VERIFICATION_RELATIVE_PATH,
  readOtelCollectorVerification,
  writeOtelCollectorConfig,
  writeOtelCollectorVerification,
} from './otel-collector-config';
import { ExtensionPlanner, type ExtensionPlanStep } from './planner';

export interface ObservabilityInstallPlan {
  workspace: ReturnType<typeof deriveWorkspaceIdentity>;
  capability: 'observability';
  provider: 'openobserve';
  state: 'ready-to-apply' | 'ready-to-route' | 'waiting-user' | 'healthy' | 'error';
  summary: string;
  canApply: boolean;
  service: {
    name: string;
    installed: boolean;
    running: boolean;
    healthy: boolean;
    persistent: boolean;
    loopbackOnly: boolean;
    credentialState: OpenObserveRuntimeDetection['credentialState'];
    port: string;
    localUrl: string;
    privateUrl?: string;
  };
  collector: {
    name: string;
    installed: boolean;
    running: boolean;
    healthy: boolean;
    configured: boolean;
    managedByLocalLink: boolean;
    configurationState: OtelCollectorRuntimeDetection['configurationState'];
    credentialInjectionConfigured: boolean;
    loopbackOnly: boolean;
    grpcPort: string;
    httpPort: string;
    healthPort: string;
    grpcEndpoint: string;
    httpEndpoint: string;
    healthUrl: string;
    configPath: string;
    deliveryVerified: boolean;
    lastDeliveryVerifiedAt?: string;
  };
  telemetry: {
    organization: string;
    stream: string;
    otlpBaseUrl: string;
    receiverGrpcEndpoint: string;
    receiverHttpEndpoint: string;
    protocol: 'http/protobuf';
    credentialsConfigured: boolean;
  };
  privateEdge: {
    declared: boolean;
    selected: boolean;
    state: string;
    url?: string;
    confirmationToken?: string;
  };
  steps: ExtensionPlanStep[];
}

export interface ObservabilityApplyResult {
  capability: 'observability';
  provider: 'openobserve';
  applied: boolean;
  changedFiles: string[];
  started: boolean;
  verification?: OtelLogDeliveryResult;
  plan: ObservabilityInstallPlan;
}

const OPENOBSERVE_DATA_VOLUME = 'openobserve-data';
const OPENOBSERVE_IMAGE = 'public.ecr.aws/zinclabs/openobserve:v0.90.3';
const OTEL_COLLECTOR_IMAGE = 'otel/opentelemetry-collector:0.157.0';

function observabilityExtension(extensions: WorkspaceExtension[]): WorkspaceExtension | undefined {
  return extensions.find((extension) => extension.kind === 'observability');
}

function unique(values: string[]): string[] {
  return [...new Set(values)];
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function generatedPassword(): string {
  return `${randomBytes(24).toString('base64url')}Aa1!`;
}

function accessKey(username: string, password: string): string {
  return Buffer.from(`${username}:${password}`, 'utf8').toString('base64');
}

function validPort(value: string | undefined): value is string {
  const port = Number(value);
  return Number.isInteger(port) && port >= 1024 && port <= 65535;
}

export async function findAdoptableOpenObserveRoute(
  root: string,
  runtime: OpenObserveRuntimeDetection,
  commandRunner: CommandRunner,
): Promise<PrivateEdgeRouteOwnership | undefined> {
  if (!runtime.serviceName || !runtime.port) return undefined;
  const [caddy, tailscale] = await Promise.all([
    detectCaddyRuntime(root, commandRunner),
    detectTailscaleRuntime(root, commandRunner),
  ]);
  if (
    caddy.source !== 'docker-compose'
    || tailscale.source !== 'docker-compose'
    || caddy.networkMode !== `service:${tailscale.serviceName}`
    || !caddy.configPath
  ) return undefined;
  const target = tailscaleRuntimeCommand(tailscale);
  if (!target) return undefined;
  const [serve, caddyfile] = await Promise.all([
    commandRunner(
      target.command,
      [...target.argsPrefix, 'serve', 'status', '--json'],
      { cwd: root, timeoutMs: 3_000 },
    ),
    readWorkspaceFile(caddy.configPath),
  ]);
  if (!serve.ok || !caddyfile) return undefined;

  for (const route of parseTailscaleServeRoutes(serve.stdout)) {
    const listener = escapeRegExp(route.targetPort);
    const block = caddyfile.match(new RegExp(
      `(?:^|\\n)\\s*(?::|https?://127\\.0\\.0\\.1:)${listener}\\s*\\{([\\s\\S]*?)\\n\\s*\\}`,
      'm',
    ))?.[1];
    if (!block) continue;
    const upstreamMatches = new RegExp(
      `\\breverse_proxy\\s+[^\\n]*(?:\\b${escapeRegExp(runtime.serviceName)}\\b|\\{\\$OPENOBSERVE_PORT\\}|\\$\\{OPENOBSERVE_PORT\\}|:${escapeRegExp(runtime.port)}\\b)`,
      'm',
    ).test(block);
    if (!upstreamMatches) continue;
    const url = new URL(route.url);
    const httpsPort = url.port || '443';
    return {
      adapter: 'tailscale-caddy',
      adopted: true,
      serviceId: 'openobserve',
      serviceName: 'OpenObserve',
      targetPort: runtime.port,
      proxyPort: route.targetPort,
      httpsPort,
      url: route.url,
      command: target.command,
      applyArgs: [
        ...target.argsPrefix,
        'serve',
        '--bg',
        '--yes',
        `--https=${httpsPort}`,
        `http://127.0.0.1:${route.targetPort}`,
      ],
      rollbackArgs: [...target.argsPrefix, 'serve', '--yes', `--https=${httpsPort}`, 'off'],
      appliedAt: new Date().toISOString(),
      status: 'active',
    };
  }
  return undefined;
}

export class ObservabilityPlanner {
  constructor(
    private readonly root: string,
    private readonly configRepository = new ConfigRepository(root),
    private readonly commandRunner: CommandRunner = runCommand,
    private readonly workspaceState = new WorkspaceStateRepository(path.join(root, '.locallink', 'workspace-state.json')),
    private readonly edgePlanner = new ExtensionPlanner(root, configRepository, commandRunner, workspaceState),
    private readonly portAllocator = new PortAllocator(),
    private readonly httpProbe?: OpenObserveHttpProbe,
    private readonly collectorHttpProbe?: OtelCollectorHttpProbe,
    private readonly deliveryVerifier: OtelLogDeliveryVerifier = verifyOtelLogDelivery,
  ) {}

  private async plannedPort(runtime: OpenObserveRuntimeDetection, configured?: string): Promise<string> {
    if (runtime.available && validPort(runtime.port)) return runtime.port;
    const requested = validPort(configured) ? Number(configured) : 5080;
    return String((await this.portAllocator.findNextAvailablePort(requested)).nextFree);
  }

  private async waitForHealthyRuntime(
    env: Record<string, string>,
    attempts = 30,
  ): Promise<OpenObserveRuntimeDetection> {
    let runtime = await detectOpenObserveRuntime(this.root, this.commandRunner, env, this.httpProbe);
    for (let attempt = 1; attempt < attempts && !runtime.healthy; attempt += 1) {
      await new Promise((resolve) => setTimeout(resolve, 2_000));
      runtime = await detectOpenObserveRuntime(this.root, this.commandRunner, env, this.httpProbe);
    }
    return runtime;
  }

  private async plannedCollectorPorts(
    runtime: OtelCollectorRuntimeDetection,
    env: Record<string, string>,
    unavailable: string[] = [],
  ): Promise<{ grpc: string; http: string; health: string }> {
    const selected = new Set(unavailable.filter(validPort));
    const allocate = async (configured: string | undefined, fallback: number): Promise<string> => {
      let requested = validPort(configured) ? Number(configured) : fallback;
      for (let attempt = 0; attempt < 10; attempt += 1) {
        const port = String((await this.portAllocator.findNextAvailablePort(requested)).nextFree);
        if (!selected.has(port)) {
          selected.add(port);
          return port;
        }
        requested = Number(port) + 1;
      }
      throw new AppError(
        'OTEL_COLLECTOR_PORTS_UNAVAILABLE',
        'LocalLink could not allocate distinct workspace ports for the OpenTelemetry Collector.',
        409,
      );
    };

    const grpc = runtime.available && validPort(runtime.grpcPort)
      ? runtime.grpcPort
      : await allocate(env.OTEL_COLLECTOR_GRPC_PORT, 4317);
    selected.add(grpc);
    const http = runtime.available && validPort(runtime.httpPort)
      ? runtime.httpPort
      : await allocate(env.OTEL_COLLECTOR_HTTP_PORT, 4318);
    selected.add(http);
    const health = runtime.available && validPort(runtime.healthPort)
      ? runtime.healthPort
      : await allocate(env.OTEL_COLLECTOR_HEALTH_PORT, 13133);
    return { grpc, http, health };
  }

  private async waitForHealthyCollector(
    env: Record<string, string>,
    attempts = 30,
  ): Promise<OtelCollectorRuntimeDetection> {
    let runtime = await detectOtelCollectorRuntime(
      this.root,
      this.commandRunner,
      env,
      this.collectorHttpProbe,
    );
    for (let attempt = 1; attempt < attempts && !runtime.healthy; attempt += 1) {
      await new Promise((resolve) => setTimeout(resolve, 2_000));
      runtime = await detectOtelCollectorRuntime(
        this.root,
        this.commandRunner,
        env,
        this.collectorHttpProbe,
      );
    }
    return runtime;
  }

  async plan(capability: string): Promise<ObservabilityInstallPlan> {
    if (capability !== 'observability') {
      throw new AppError(
        'UNSUPPORTED_OBSERVABILITY_CAPABILITY',
        `Observability planning supports "observability"; received "${capability}".`,
        400,
      );
    }

    await this.configRepository.hydrateProcessEnv();
    const model = await this.configRepository.loadProjectModel();
    const workspace = deriveWorkspaceIdentity(this.root, model.env.LOCALLINK_WORKSPACE_ID);
    const declaration = observabilityExtension(model.extensions);
    const [runtime, collectorRuntime] = await Promise.all([
      detectOpenObserveRuntime(this.root, this.commandRunner, model.env, this.httpProbe),
      detectOtelCollectorRuntime(this.root, this.commandRunner, model.env, this.collectorHttpProbe),
    ]);
    const port = await this.plannedPort(runtime, model.env.OPENOBSERVE_PORT);
    const collectorPorts = await this.plannedCollectorPorts(collectorRuntime, model.env, [port]);
    const organization = model.env.OPENOBSERVE_ORGANIZATION || 'default';
    const stream = model.env.OPENOBSERVE_STREAM || 'default';
    const localUrl = `http://127.0.0.1:${port}`;
    const otlpBaseUrl = `${localUrl}/api/${organization}`;
    const receiverGrpcEndpoint = `http://127.0.0.1:${collectorPorts.grpc}`;
    const receiverHttpEndpoint = `http://127.0.0.1:${collectorPorts.http}`;
    const collectorHealthUrl = `http://127.0.0.1:${collectorPorts.health}/`;
    const deliveryVerification = await readOtelCollectorVerification(this.root, {
      receiverHttpEndpoint,
      backendOtlpBaseUrl: otlpBaseUrl,
      organization,
      stream,
    });

    await this.workspaceState.load();
    const existingOwnership = this.workspaceState.read().privateEdgeRoutes.find((route) => route.serviceId === 'openobserve');
    const adoptableRoute = existingOwnership
      ? undefined
      : await findAdoptableOpenObserveRoute(this.root, runtime, this.commandRunner);
    const edgePlan = await this.edgePlanner.plan('private-edge');
    const service = model.definitions.find((candidate) => (
      candidate.id === 'openobserve'
      || candidate.runtimeName === runtime.serviceName
      || candidate.name.toLowerCase() === 'openobserve'
    ));
    const selected = Boolean(service && edgePlan.selection.selected.some((candidate) => candidate.id === service.id));
    const route = service
      ? edgePlan.routePlan.routes.find((candidate) => candidate.serviceId === service.id)
      : undefined;
    const privateUrl = existingOwnership?.url || adoptableRoute?.url || route?.url;
    const routeActive = Boolean(existingOwnership?.status === 'active' || route?.status === 'active');
    const credentialInvalid = runtime.credentialState === 'invalid';
    const credentialUnverified = runtime.running
      && runtime.healthy
      && runtime.credentialState === 'unverified';
    const existingUnsafeStorage = runtime.available && !runtime.persistent;
    const customCollectorNeedsReview = collectorRuntime.available
      && !collectorRuntime.managedByLocalLink;
    const collectorContractConfigured = model.env.OTEL_EXPORTER_OTLP_ENDPOINT === receiverHttpEndpoint
      && model.env.OTEL_EXPORTER_OTLP_PROTOCOL === 'http/protobuf';

    const steps: ExtensionPlanStep[] = [
      {
        id: 'declare-openobserve',
        label: 'Declare the OpenObserve observability capability',
        owner: 'locallink',
        status: declaration?.enabled ? 'complete' : 'pending',
        automatic: true,
        targetFile: 'locallink.extensions.yml',
        detail: declaration?.enabled
          ? `The ${declaration.id} observability declaration is enabled.`
          : 'Add an enabled, provider-neutral observability declaration backed by OpenObserve.',
      },
      {
        id: 'install-openobserve',
        label: 'Install the OpenObserve Docker service',
        owner: 'locallink',
        status: runtime.available ? 'complete' : 'pending',
        automatic: true,
        targetFile: 'docker-compose.yml',
        detail: runtime.available
          ? `Docker Compose service ${runtime.serviceName} is declared and its existing image will be preserved.`
          : `Install the official OpenObserve OSS image on workspace-specific loopback port ${port}.`,
      },
      {
        id: 'persist-openobserve-data',
        label: 'Persist OpenObserve data',
        owner: existingUnsafeStorage ? 'user' : 'locallink',
        status: runtime.persistent ? 'complete' : existingUnsafeStorage ? 'blocked' : 'pending',
        automatic: !existingUnsafeStorage,
        targetFile: 'docker-compose.yml',
        detail: runtime.persistent
          ? 'OpenObserve data is backed by a declared Docker volume.'
          : existingUnsafeStorage
            ? 'This existing service stores data inside the container. Back it up and choose a migration before attaching a new volume; LocalLink will not hide or replace it automatically.'
            : 'Create a workspace-scoped named volume mounted at /data.',
      },
      {
        id: 'configure-openobserve-credentials',
        label: 'Configure and verify OpenObserve credentials',
        owner: credentialInvalid || credentialUnverified || (runtime.available && !runtime.credentialsConfigured) ? 'user' : 'locallink',
        status: runtime.credentialState === 'valid'
          ? 'complete'
          : credentialInvalid || credentialUnverified || (runtime.available && !runtime.credentialsConfigured)
            ? 'blocked'
            : 'pending',
        automatic: !credentialInvalid && !credentialUnverified && (!runtime.available || runtime.credentialsConfigured),
        targetFile: '.env',
        detail: runtime.credentialState === 'valid'
          ? 'The configured root credentials authenticate against the local OpenObserve API.'
          : credentialInvalid
            ? 'The configured credentials no longer match OpenObserve state. LocalLink will preserve the data and will not silently reset the root account.'
            : credentialUnverified
              ? 'OpenObserve is healthy, but the authenticated API check could not be completed. Fix local connectivity before recreating this existing service.'
            : runtime.available && !runtime.credentialsConfigured
              ? 'This existing data store has no usable workspace credential record. Recover or explicitly reset the root account before LocalLink changes it.'
              : 'Generate a strong workspace-local root password and derived OTLP Basic authorization value without printing either secret.',
      },
      {
        id: 'secure-openobserve-binding',
        label: 'Restrict the OpenObserve host port to loopback',
        owner: credentialInvalid || credentialUnverified ? 'user' : 'locallink',
        status: runtime.loopbackOnly ? 'complete' : credentialInvalid || credentialUnverified ? 'blocked' : 'pending',
        automatic: !credentialInvalid && !credentialUnverified,
        targetFile: 'docker-compose.yml',
        detail: runtime.loopbackOnly
          ? `The OpenObserve UI is loopback-only on port ${port}.`
          : credentialInvalid || credentialUnverified
            ? 'Recover the credentials before recreating the existing container with a loopback-only port.'
            : 'Publish port 5080 only on 127.0.0.1; Private Edge remains the remote access path.',
      },
      {
        id: 'configure-openobserve-otlp',
        label: 'Configure the OpenObserve backend contract',
        owner: 'locallink',
        status: model.env.OPENOBSERVE_OTLP_BASE_URL === otlpBaseUrl
          && model.env.OPENOBSERVE_ORGANIZATION === organization
          && model.env.OPENOBSERVE_STREAM === stream
          ? 'complete'
          : 'pending',
        automatic: true,
        targetFile: '.env',
        detail: `Use internal OTLP/HTTP base ${otlpBaseUrl} for organization ${organization} and stream ${stream}. Applications will send to the workspace collector instead of carrying backend credentials.`,
      },
      {
        id: 'install-otel-collector',
        label: 'Install the workspace OpenTelemetry Collector',
        owner: customCollectorNeedsReview ? 'user' : 'locallink',
        status: collectorRuntime.available
          ? customCollectorNeedsReview ? 'blocked' : 'complete'
          : 'pending',
        automatic: !customCollectorNeedsReview,
        targetFile: 'docker-compose.yml',
        detail: collectorRuntime.available
          ? customCollectorNeedsReview
            ? `Existing service ${collectorRuntime.serviceName} is not explicitly LocalLink-managed. Review and adopt it before LocalLink replaces any receiver or exporter contract.`
            : `Docker Compose service ${collectorRuntime.serviceName} is available and its existing image will be preserved.`
          : `Install the official OpenTelemetry Collector image with isolated workspace receiver ports ${collectorPorts.grpc}/${collectorPorts.http}.`,
      },
      {
        id: 'configure-otel-collector',
        label: 'Configure logs, metrics, and traces pipelines',
        owner: customCollectorNeedsReview ? 'user' : 'locallink',
        status: collectorRuntime.configurationState === 'valid'
          && collectorRuntime.credentialInjectionConfigured
          ? 'complete'
          : customCollectorNeedsReview ? 'blocked' : 'pending',
        automatic: !customCollectorNeedsReview,
        targetFile: OTEL_COLLECTOR_CONFIG_RELATIVE_PATH,
        detail: collectorRuntime.configurationState === 'valid'
          && collectorRuntime.credentialInjectionConfigured
          ? 'All three OTLP signals forward to OpenObserve, whose authorization value is injected only through the container environment.'
          : customCollectorNeedsReview
            ? 'The existing collector pipeline is user-owned; LocalLink will not overwrite it implicitly.'
            : `Generate ${OTEL_COLLECTOR_CONFIG_RELATIVE_PATH} with environment references and no stored credential value.`,
      },
      {
        id: 'secure-otel-receivers',
        label: 'Restrict telemetry receivers to loopback',
        owner: customCollectorNeedsReview ? 'user' : 'locallink',
        status: collectorRuntime.loopbackOnly ? 'complete' : customCollectorNeedsReview ? 'blocked' : 'pending',
        automatic: !customCollectorNeedsReview,
        targetFile: 'docker-compose.yml',
        detail: collectorRuntime.loopbackOnly
          ? `OTLP/gRPC :${collectorPorts.grpc}, OTLP/HTTP :${collectorPorts.http}, and health :${collectorPorts.health} are loopback-only.`
          : customCollectorNeedsReview
            ? 'The existing collector publishes one or more ports beyond loopback and must be reviewed before recreation.'
            : 'Publish the receivers and health probe only on 127.0.0.1; telemetry ingestion is never a Private Edge route.',
      },
      {
        id: 'configure-application-otlp',
        label: 'Write the generic application telemetry contract',
        owner: 'locallink',
        status: collectorContractConfigured ? 'complete' : 'pending',
        automatic: true,
        targetFile: '.env',
        detail: `Applications use OTEL_EXPORTER_OTLP_ENDPOINT=${receiverHttpEndpoint} and OTEL_EXPORTER_OTLP_PROTOCOL=http/protobuf with no OpenObserve authorization header.`,
      },
      {
        id: 'start-otel-collector',
        label: 'Start and verify telemetry delivery',
        owner: customCollectorNeedsReview ? 'user' : 'locallink',
        status: collectorRuntime.healthy && collectorRuntime.configured && deliveryVerification
          ? 'complete'
          : customCollectorNeedsReview ? 'blocked' : 'pending',
        automatic: !customCollectorNeedsReview,
        detail: collectorRuntime.healthy && collectorRuntime.configured && deliveryVerification
          ? `The collector is healthy and a timestamped OTLP log reached OpenObserve at ${deliveryVerification.verifiedAt}.`
          : customCollectorNeedsReview
            ? 'Validate and explicitly adopt the existing collector before LocalLink starts or recreates it.'
            : collectorRuntime.healthy && collectorRuntime.configured
              ? 'Send a timestamped canary through the collector and require it to appear in the configured OpenObserve stream.'
              : 'Start the collector after OpenObserve, require its health endpoint to pass, then verify end-to-end log delivery.',
      },
      {
        id: 'select-openobserve-edge',
        label: 'Select OpenObserve for Private Edge',
        owner: 'locallink',
        status: selected ? 'complete' : 'pending',
        automatic: true,
        targetFile: 'locallink.extensions.yml',
        detail: selected
          ? 'OpenObserve is included in this workspace’s explicit Private Edge selection.'
          : 'Add OpenObserve without deselecting other workspace services.',
      },
      {
        id: 'adopt-openobserve-route',
        label: 'Capture an existing verified OpenObserve route',
        owner: 'locallink',
        status: existingOwnership ? 'complete' : adoptableRoute ? 'pending' : 'complete',
        automatic: true,
        detail: existingOwnership
          ? `LocalLink records the active OpenObserve listener on HTTPS :${existingOwnership.httpsPort}.`
          : adoptableRoute
            ? `The live Tailscale listener and Caddy upstream agree on HTTPS :${adoptableRoute.httpsPort}; record it without changing either runtime.`
            : 'No pre-existing matching OpenObserve route needs adoption.',
      },
      {
        id: 'start-openobserve',
        label: 'Start and verify OpenObserve',
        owner: 'locallink',
        status: runtime.healthy ? 'complete' : runtime.available || !existingUnsafeStorage ? 'pending' : 'blocked',
        automatic: true,
        detail: runtime.healthy
          ? 'OpenObserve /healthz returns successfully.'
          : 'Start the Docker service, wait for /healthz, and verify the stored credentials against the API.',
      },
      {
        id: 'publish-openobserve',
        label: 'Publish the private OpenObserve UI',
        owner: 'user',
        status: routeActive ? 'complete' : 'pending',
        automatic: false,
        detail: routeActive
          ? `OpenObserve is privately reachable at ${privateUrl}.`
          : adoptableRoute
            ? 'The existing private route can be adopted automatically without a runtime change.'
            : edgePlan.routePlan.confirmationToken
              ? 'Review and explicitly confirm the generated Private Edge route.'
              : edgePlan.routePlan.summary,
      },
    ];

    const automaticPending = steps.some((step) => step.owner === 'locallink' && step.status === 'pending');
    const blocking = credentialInvalid
      || credentialUnverified
      || existingUnsafeStorage
      || customCollectorNeedsReview;
    const state: ObservabilityInstallPlan['state'] = blocking
      ? 'error'
      : automaticPending
        ? 'ready-to-apply'
        : !routeActive
          ? 'ready-to-route'
          : runtime.healthy
            && runtime.credentialState === 'valid'
            && collectorRuntime.healthy
            && collectorRuntime.configured
            ? 'healthy'
            : 'waiting-user';

    return {
      workspace,
      capability: 'observability',
      provider: 'openobserve',
      state,
      summary: credentialInvalid
        ? 'OpenObserve is healthy, but the saved credentials no longer authenticate; data and account state will be preserved.'
        : credentialUnverified
          ? 'OpenObserve is healthy, but authenticated API access could not be verified; the existing service will not be recreated.'
        : existingUnsafeStorage
          ? 'OpenObserve exists without persistent storage and requires an explicit backup/migration decision.'
          : customCollectorNeedsReview
            ? 'An unowned Docker OpenTelemetry Collector exists and requires explicit review before LocalLink can adopt its configuration.'
          : automaticPending
            ? 'LocalLink can safely reconcile OpenObserve and its workspace-local OpenTelemetry Collector.'
            : !routeActive
              ? 'OpenObserve and the telemetry collector are healthy locally; review and confirm the OpenObserve UI’s Private Edge route.'
              : 'OpenObserve is healthy, persistent, authenticated, privately reachable, and receiving through a workspace-local telemetry gateway.',
      canApply: automaticPending && !blocking,
      service: {
        name: runtime.serviceName || 'openobserve',
        installed: runtime.available,
        running: runtime.running,
        healthy: runtime.healthy,
        persistent: runtime.persistent,
        loopbackOnly: runtime.loopbackOnly,
        credentialState: runtime.credentialState,
        port,
        localUrl,
        privateUrl,
      },
      collector: {
        name: collectorRuntime.serviceName || 'otel-collector',
        installed: collectorRuntime.available,
        running: collectorRuntime.running,
        healthy: collectorRuntime.healthy,
        configured: collectorRuntime.configured,
        managedByLocalLink: collectorRuntime.managedByLocalLink,
        configurationState: collectorRuntime.configurationState,
        credentialInjectionConfigured: collectorRuntime.credentialInjectionConfigured,
        loopbackOnly: collectorRuntime.loopbackOnly,
        grpcPort: collectorPorts.grpc,
        httpPort: collectorPorts.http,
        healthPort: collectorPorts.health,
        grpcEndpoint: receiverGrpcEndpoint,
        httpEndpoint: receiverHttpEndpoint,
        healthUrl: collectorHealthUrl,
        configPath: OTEL_COLLECTOR_CONFIG_RELATIVE_PATH,
        deliveryVerified: Boolean(deliveryVerification),
        lastDeliveryVerifiedAt: deliveryVerification?.verifiedAt,
      },
      telemetry: {
        organization,
        stream,
        otlpBaseUrl,
        receiverGrpcEndpoint,
        receiverHttpEndpoint,
        protocol: 'http/protobuf',
        credentialsConfigured: runtime.credentialsConfigured,
      },
      privateEdge: {
        declared: Boolean(model.extensions.find((extension) => extension.kind === 'network-edge')?.enabled),
        selected,
        state: edgePlan.routePlan.state,
        url: privateUrl,
        confirmationToken: edgePlan.routePlan.confirmationToken,
      },
      steps,
    };
  }

  async apply(capability: string): Promise<ObservabilityApplyResult> {
    const before = await this.plan(capability);
    if (!before.canApply) {
      return {
        capability: 'observability',
        provider: 'openobserve',
        applied: false,
        changedFiles: [],
        started: false,
        plan: before,
      };
    }

    const changedFiles: string[] = [];
    await this.configRepository.hydrateProcessEnv();
    let model = await this.configRepository.loadProjectModel();
    let runtime = await detectOpenObserveRuntime(this.root, this.commandRunner, model.env, this.httpProbe);
    let collectorRuntime = await detectOtelCollectorRuntime(
      this.root,
      this.commandRunner,
      model.env,
      this.collectorHttpProbe,
    );
    const freshInstall = !runtime.available;
    const username = model.env.OPENOBSERVE_USERNAME || 'root@localhost';
    const password = model.env.OPENOBSERVE_PASSWORD || (freshInstall ? generatedPassword() : '');
    if (!password) {
      throw new AppError(
        'OPENOBSERVE_CREDENTIALS_REQUIRED',
        'The existing OpenObserve data store does not have recoverable workspace credentials. LocalLink will not reset it implicitly.',
        409,
      );
    }
    const port = before.service.port;
    const organization = model.env.OPENOBSERVE_ORGANIZATION || 'default';
    const stream = model.env.OPENOBSERVE_STREAM || 'default';
    const endpoint = `http://127.0.0.1:${port}`;
    const otlpBaseUrl = `${endpoint}/api/${organization}`;
    const authorization = accessKey(username, password);
    const receiverGrpcEndpoint = before.collector.grpcEndpoint;
    const receiverHttpEndpoint = before.collector.httpEndpoint;

    await this.configRepository.writeInfraConfig({
      targetFile: '.env',
      patch: {
        kind: 'env',
        set: {
          OPENOBSERVE_PORT: port,
          OPENOBSERVE_USERNAME: username,
          OPENOBSERVE_PASSWORD: password,
          OPENOBSERVE_ACCESS_KEY_B64: authorization,
          OPENOBSERVE_ENDPOINT: endpoint,
          OPENOBSERVE_ORGANIZATION: organization,
          OPENOBSERVE_STREAM: stream,
          OPENOBSERVE_OTLP_BASE_URL: otlpBaseUrl,
          OTEL_COLLECTOR_GRPC_PORT: before.collector.grpcPort,
          OTEL_COLLECTOR_HTTP_PORT: before.collector.httpPort,
          OTEL_COLLECTOR_HEALTH_PORT: before.collector.healthPort,
          OTEL_EXPORTER_OTLP_ENDPOINT: receiverHttpEndpoint,
          OTEL_EXPORTER_OTLP_PROTOCOL: 'http/protobuf',
        },
      },
    });
    await fs.chmod(path.join(this.root, '.env'), 0o600);
    changedFiles.push('.env');
    await this.configRepository.writeInfraConfig({
      targetFile: '.env.example',
      patch: {
        kind: 'env',
        set: {
          OPENOBSERVE_PORT: '5080',
          OPENOBSERVE_USERNAME: 'root@localhost',
          OPENOBSERVE_PASSWORD: '',
          OPENOBSERVE_ACCESS_KEY_B64: '',
          OPENOBSERVE_ENDPOINT: 'http://127.0.0.1:5080',
          OPENOBSERVE_ORGANIZATION: 'default',
          OPENOBSERVE_STREAM: 'default',
          OPENOBSERVE_OTLP_BASE_URL: 'http://127.0.0.1:5080/api/default',
          OTEL_COLLECTOR_GRPC_PORT: '4317',
          OTEL_COLLECTOR_HTTP_PORT: '4318',
          OTEL_COLLECTOR_HEALTH_PORT: '13133',
          OTEL_EXPORTER_OTLP_ENDPOINT: 'http://127.0.0.1:4318',
          OTEL_EXPORTER_OTLP_PROTOCOL: 'http/protobuf',
        },
        unset: ['OPENOBSERVE_TOKEN', 'OTEL_EXPORTER_OTLP_HEADERS'],
      },
    });
    changedFiles.push('.env.example');

    const mustSecureBinding = runtime.available && !runtime.loopbackOnly;
    if (freshInstall || mustSecureBinding) {
      await this.configRepository.writeInfraConfig({
        targetFile: 'docker-compose.yml',
        patch: {
          kind: 'compose',
          serviceName: runtime.serviceName || 'openobserve',
          updates: {
            ...(freshInstall ? {
              image: OPENOBSERVE_IMAGE,
              restart: 'unless-stopped',
              profiles: ['observability'],
              environment: {
                ZO_ROOT_USER_EMAIL: '${OPENOBSERVE_USERNAME}',
                ZO_ROOT_USER_PASSWORD: '${OPENOBSERVE_PASSWORD}',
                ZO_DATA_DIR: '/data',
              },
              volumes: [`${OPENOBSERVE_DATA_VOLUME}:/data`],
            } : {}),
            ports: ['127.0.0.1:${OPENOBSERVE_PORT:-5080}:5080'],
            labels: {
              'locallink.name': 'OpenObserve',
              'locallink.provider': 'openobserve',
              'locallink.group': 'docker',
              'locallink.runtime': 'docker',
              'locallink.notes': 'Workspace observability UI and OTLP-compatible telemetry backend.',
              'locallink.detail': 'Receives standard OpenTelemetry logs, metrics, and traces without provider-specific application code.',
              'locallink.tags': 'docker,observability,otlp,logs,metrics,traces',
              'locallink.portEnv': 'OPENOBSERVE_PORT',
              'locallink.envVars': 'OPENOBSERVE_PORT;OPENOBSERVE_ENDPOINT;OPENOBSERVE_ORGANIZATION;OPENOBSERVE_STREAM;OPENOBSERVE_OTLP_BASE_URL',
              'locallink.docsUrl': 'https://openobserve.ai/docs/getting-started/',
            },
          },
          ...(freshInstall ? {
            topLevelVolumes: {
              [OPENOBSERVE_DATA_VOLUME]: {},
            },
          } : {}),
        },
      });
      changedFiles.push('docker-compose.yml');
    }

    const collectorConfig = await writeOtelCollectorConfig(
      this.root,
      runtime.serviceName || 'openobserve',
    );
    if (collectorConfig.changed) changedFiles.push(OTEL_COLLECTOR_CONFIG_RELATIVE_PATH);
    const freshCollectorInstall = !collectorRuntime.available;
    if (freshCollectorInstall || collectorRuntime.managedByLocalLink || collectorRuntime.configured) {
      await this.configRepository.writeInfraConfig({
        targetFile: 'docker-compose.yml',
        patch: {
          kind: 'compose',
          serviceName: collectorRuntime.serviceName || 'otel-collector',
          updates: {
            ...(freshCollectorInstall ? {
              image: OTEL_COLLECTOR_IMAGE,
              restart: 'unless-stopped',
              profiles: ['observability'],
            } : {}),
            ports: [
              '127.0.0.1:${OTEL_COLLECTOR_GRPC_PORT:-4317}:4317',
              '127.0.0.1:${OTEL_COLLECTOR_HTTP_PORT:-4318}:4318',
              '127.0.0.1:${OTEL_COLLECTOR_HEALTH_PORT:-13133}:13133',
            ],
            environment: {
              OPENOBSERVE_ACCESS_KEY_B64: '${OPENOBSERVE_ACCESS_KEY_B64}',
              OPENOBSERVE_ORGANIZATION: '${OPENOBSERVE_ORGANIZATION:-default}',
              OPENOBSERVE_STREAM: '${OPENOBSERVE_STREAM:-default}',
            },
            volumes: [`./${OTEL_COLLECTOR_CONFIG_RELATIVE_PATH}:/etc/otelcol/config.yaml:ro`],
            dependsOn: [runtime.serviceName || 'openobserve'],
            labels: {
              'locallink.name': 'OpenTelemetry Collector',
              'locallink.provider': 'opentelemetry-collector',
              'locallink.managedBy': 'locallink',
              'locallink.group': 'docker',
              'locallink.runtime': 'docker',
              'locallink.notes': 'Workspace-local OpenTelemetry gateway.',
              'locallink.detail': 'Receives standard OTLP logs, metrics, and traces on loopback and forwards them to the configured observability backend.',
              'locallink.tags': 'docker,observability,opentelemetry,otlp,logs,metrics,traces',
              'locallink.portEnv': 'OTEL_COLLECTOR_HTTP_PORT',
              'locallink.envVars': 'OTEL_COLLECTOR_GRPC_PORT;OTEL_COLLECTOR_HTTP_PORT;OTEL_EXPORTER_OTLP_ENDPOINT;OTEL_EXPORTER_OTLP_PROTOCOL',
              'locallink.docsUrl': 'https://opentelemetry.io/docs/collector/',
            },
          },
        },
      });
      changedFiles.push('docker-compose.yml');
    }

    await this.configRepository.writeInfraConfig({
      targetFile: 'locallink.extensions.yml',
      patch: {
        kind: 'extension',
        extensionId: observabilityExtension(model.extensions)?.id || 'openobserve',
        updates: {
          name: observabilityExtension(model.extensions)?.name || 'OpenObserve Telemetry',
          kind: 'observability',
          enabled: true,
          detail: observabilityExtension(model.extensions)?.detail
            || 'Persistent local logs, metrics, and traces through the provider-neutral OpenTelemetry protocol.',
          dependsOn: [],
          exposedPorts: [port],
          requiredEnv: [],
          docsUrl: 'https://openobserve.ai/docs/getting-started/',
        },
      },
    });
    changedFiles.push('locallink.extensions.yml');

    await this.configRepository.hydrateProcessEnv();
    model = await this.configRepository.loadProjectModel();
    runtime = await detectOpenObserveRuntime(this.root, this.commandRunner, model.env, this.httpProbe);
    const service = model.definitions.find((candidate) => (
      candidate.id === 'openobserve'
      || candidate.runtimeName === runtime.serviceName
      || candidate.name.toLowerCase() === 'openobserve'
    ));
    if (!service) {
      throw new AppError('OPENOBSERVE_INSTALL_FAILED', 'OpenObserve was written to Docker Compose but could not be rediscovered.', 500);
    }

    await this.workspaceState.load();
    const existingOwnership = this.workspaceState.read().privateEdgeRoutes.find((route) => route.serviceId === service.id);
    if (!existingOwnership) {
      const adoptable = await findAdoptableOpenObserveRoute(this.root, runtime, this.commandRunner);
      if (adoptable) {
        await this.workspaceState.upsertPrivateEdgeRoutes([{
          ...adoptable,
          serviceId: service.id,
          serviceName: service.name,
        }]);
      }
    }
    const existingEdge = model.extensions.find((extension) => extension.kind === 'network-edge');
    const selectedServiceIds = model.definitions
      .filter((candidate) => candidate.port && existingEdge?.exposedPorts.includes(candidate.port))
      .map((candidate) => candidate.id);
    await this.edgePlanner.apply('private-edge', unique([...selectedServiceIds, service.id]));

    await this.configRepository.hydrateProcessEnv();
    model = await this.configRepository.loadProjectModel();
    runtime = await detectOpenObserveRuntime(this.root, this.commandRunner, model.env, this.httpProbe);
    let started = false;
    if (!runtime.running || mustSecureBinding) {
      const start = openObserveStartCommand(runtime);
      if (!start) {
        throw new AppError('OPENOBSERVE_START_UNSUPPORTED', 'OpenObserve is not a manageable Docker Compose service.', 409);
      }
      const result = await this.commandRunner(start.command, start.args, { cwd: this.root, timeoutMs: 180_000 });
      if (!result.ok) {
        throw new AppError(
          'OPENOBSERVE_START_FAILED',
          `OpenObserve configuration was saved, but Docker could not start ${runtime.serviceName}: ${result.stderr || result.error || 'unknown error'}`,
          502,
        );
      }
      started = true;
      runtime = await this.waitForHealthyRuntime(model.env);
    }
    if (!runtime.healthy) {
      throw new AppError(
        'OPENOBSERVE_HEALTHCHECK_FAILED',
        `OpenObserve is running, but /healthz did not pass. Inspect docker compose logs ${runtime.serviceName || 'openobserve'}.`,
        502,
      );
    }
    if (runtime.credentialState !== 'valid') {
      throw new AppError(
        'OPENOBSERVE_CREDENTIAL_CHECK_FAILED',
        'OpenObserve is healthy, but the saved credentials did not authenticate. Existing data and account state were preserved.',
        409,
      );
    }

    await this.configRepository.hydrateProcessEnv();
    model = await this.configRepository.loadProjectModel();
    collectorRuntime = await detectOtelCollectorRuntime(
      this.root,
      this.commandRunner,
      model.env,
      this.collectorHttpProbe,
    );
    const collectorNeedsRestart = !collectorRuntime.running
      || !collectorRuntime.configured
      || collectorConfig.changed;
    if (collectorNeedsRestart) {
      const start = otelCollectorStartCommand(
        collectorRuntime,
        collectorRuntime.running && (collectorConfig.changed || !collectorRuntime.configured),
      );
      if (!start) {
        throw new AppError(
          'OTEL_COLLECTOR_START_UNSUPPORTED',
          'The OpenTelemetry Collector is not a manageable Docker Compose service.',
          409,
        );
      }
      const result = await this.commandRunner(start.command, start.args, {
        cwd: this.root,
        timeoutMs: 180_000,
      });
      if (!result.ok) {
        throw new AppError(
          'OTEL_COLLECTOR_START_FAILED',
          `The telemetry gateway configuration was saved, but Docker could not start ${collectorRuntime.serviceName}: ${result.stderr || result.error || 'unknown error'}`,
          502,
        );
      }
      started = true;
      collectorRuntime = await this.waitForHealthyCollector(model.env);
    }
    if (!collectorRuntime.healthy) {
      throw new AppError(
        'OTEL_COLLECTOR_HEALTHCHECK_FAILED',
        `The OpenTelemetry Collector is running, but its health endpoint did not pass. Inspect docker compose logs ${collectorRuntime.serviceName || 'otel-collector'}.`,
        502,
      );
    }
    if (!collectorRuntime.configured) {
      throw new AppError(
        'OTEL_COLLECTOR_CONFIGURATION_FAILED',
        'The OpenTelemetry Collector started, but its receiver, exporter, credential-injection, or loopback contract could not be verified.',
        502,
      );
    }
    const verification = await this.deliveryVerifier({
      collectorHttpEndpoint: receiverHttpEndpoint,
      openObserveEndpoint: endpoint,
      organization,
      stream,
      username,
      password,
      workspaceId: before.workspace.id,
    });
    if (!verification.ok || !verification.verifiedAt) {
      throw new AppError(
        'OTEL_COLLECTOR_DELIVERY_FAILED',
        verification.detail,
        502,
      );
    }
    await writeOtelCollectorVerification(this.root, {
      version: 1,
      verifiedAt: verification.verifiedAt,
      receiverHttpEndpoint,
      backendOtlpBaseUrl: otlpBaseUrl,
      organization,
      stream,
    });
    changedFiles.push(OTEL_COLLECTOR_VERIFICATION_RELATIVE_PATH);

    return {
      capability: 'observability',
      provider: 'openobserve',
      applied: changedFiles.length > 0 || started,
      changedFiles: unique(changedFiles),
      started,
      verification,
      plan: await this.plan('observability'),
    };
  }
}
