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
import { detectTailscaleRuntime, tailscaleRuntimeCommand } from '../runtime/tailscale-runtime';
import type { PrivateEdgeRouteOwnership, WorkspaceExtension } from '../shared/contracts';
import { AppError } from '../shared/errors';
import type { CommandRunner } from '../shared/utils';
import { runCommand } from '../shared/utils';
import { WorkspaceStateRepository } from '../state/workspace-state';
import { deriveWorkspaceIdentity } from '../workspace/identity';
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
  telemetry: {
    organization: string;
    stream: string;
    otlpBaseUrl: string;
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
  plan: ObservabilityInstallPlan;
}

const OPENOBSERVE_DATA_VOLUME = 'openobserve-data';
const OPENOBSERVE_IMAGE = 'public.ecr.aws/zinclabs/openobserve:v0.90.3';

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
    const runtime = await detectOpenObserveRuntime(this.root, this.commandRunner, model.env, this.httpProbe);
    const port = await this.plannedPort(runtime, model.env.OPENOBSERVE_PORT);
    const organization = model.env.OPENOBSERVE_ORGANIZATION || 'default';
    const stream = model.env.OPENOBSERVE_STREAM || 'default';
    const localUrl = `http://127.0.0.1:${port}`;
    const otlpBaseUrl = `${localUrl}/api/${organization}`;

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
        label: 'Configure the OpenObserve OTLP contract',
        owner: 'locallink',
        status: model.env.OPENOBSERVE_OTLP_BASE_URL === otlpBaseUrl
          && model.env.OPENOBSERVE_ORGANIZATION === organization
          && model.env.OPENOBSERVE_STREAM === stream
          ? 'complete'
          : 'pending',
        automatic: true,
        targetFile: '.env',
        detail: `Use OTLP/HTTP base ${otlpBaseUrl} for organization ${organization} and stream ${stream}; signal exporters append /v1/logs, /v1/metrics, or /v1/traces.`,
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
    const blocking = credentialInvalid || credentialUnverified || existingUnsafeStorage;
    const state: ObservabilityInstallPlan['state'] = blocking
      ? 'error'
      : automaticPending
        ? 'ready-to-apply'
        : !routeActive
          ? 'ready-to-route'
          : runtime.healthy && runtime.credentialState === 'valid'
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
          : automaticPending
            ? 'LocalLink can install or safely reconcile the workspace-owned OpenObserve components.'
            : !routeActive
              ? 'OpenObserve is healthy locally; review and confirm its Private Edge route.'
              : 'OpenObserve is healthy, persistent, authenticated, and privately reachable.',
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
      telemetry: {
        organization,
        stream,
        otlpBaseUrl,
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
        },
        unset: ['OPENOBSERVE_TOKEN'],
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

    return {
      capability: 'observability',
      provider: 'openobserve',
      applied: changedFiles.length > 0 || started,
      changedFiles: unique(changedFiles),
      started,
      plan: await this.plan('observability'),
    };
  }
}
