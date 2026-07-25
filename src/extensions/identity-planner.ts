import { randomBytes } from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';

import { ConfigRepository } from '../config/files';
import { detectCaddyRuntime, readWorkspaceFile } from '../runtime/caddy-runtime';
import { parseTailscaleServeRoutes } from '../runtime/network-edge';
import {
  detectPocketIdRuntime,
  pocketIdStartCommand,
  type PocketIdRuntimeDetection,
} from '../runtime/pocket-id-runtime';
import { detectTailscaleRuntime, tailscaleRuntimeCommand } from '../runtime/tailscale-runtime';
import type { PrivateEdgeRouteOwnership, WorkspaceExtension } from '../shared/contracts';
import { AppError } from '../shared/errors';
import type { CommandRunner } from '../shared/utils';
import { runCommand } from '../shared/utils';
import { WorkspaceStateRepository } from '../state/workspace-state';
import { deriveWorkspaceIdentity } from '../workspace/identity';
import { ExtensionPlanner, type ExtensionPlanStep } from './planner';

export interface IdentityInstallPlan {
  workspace: ReturnType<typeof deriveWorkspaceIdentity>;
  capability: 'identity';
  provider: 'pocket-id';
  state: 'ready-to-apply' | 'ready-to-route' | 'waiting-user' | 'healthy' | 'error';
  summary: string;
  canApply: boolean;
  service: {
    name: string;
    installed: boolean;
    running: boolean;
    healthy: boolean;
    persistent: boolean;
    port: string;
    issuer?: string;
    setupUrl?: string;
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

export interface IdentityApplyResult {
  capability: 'identity';
  provider: 'pocket-id';
  applied: boolean;
  changedFiles: string[];
  started: boolean;
  plan: IdentityInstallPlan;
}

const POCKET_ID_SECRET_PATH = '.locallink/secrets/pocket-id/encryption-key';
const POCKET_ID_SECRET_TARGET = '/run/secrets/pocket-id-encryption-key';
const POCKET_ID_DATA_VOLUME = 'pocket-id-data';

function validIssuer(value: string | undefined): value is string {
  if (!value) return false;
  try {
    const url = new URL(value);
    return url.protocol === 'https:'
      && !/(^|\.)example(?:-tailnet)?\./i.test(url.hostname)
      && !url.hostname.endsWith('.example.com')
      && !url.hostname.endsWith('.example.org');
  } catch {
    return false;
  }
}

function setupUrl(issuer: string | undefined): string | undefined {
  if (!validIssuer(issuer)) return undefined;
  const url = new URL(issuer);
  url.pathname = '/setup';
  url.search = '';
  url.hash = '';
  return url.toString().replace(/\/$/, '');
}

function identityExtension(extensions: WorkspaceExtension[]): WorkspaceExtension | undefined {
  return extensions.find((extension) => extension.kind === 'identity-provider');
}

async function fileExists(filePath: string): Promise<boolean> {
  try {
    await fs.access(filePath);
    return true;
  } catch {
    return false;
  }
}

async function ensureEncryptionSecret(workspaceRoot: string): Promise<{ path: string; created: boolean }> {
  const filePath = path.join(workspaceRoot, POCKET_ID_SECRET_PATH);
  if (await fileExists(filePath)) return { path: filePath, created: false };
  await fs.mkdir(path.dirname(filePath), { recursive: true, mode: 0o700 });
  await fs.writeFile(filePath, randomBytes(32).toString('base64'), { mode: 0o600, flag: 'wx' });
  await fs.chmod(filePath, 0o600);
  return { path: filePath, created: true };
}

function unique(values: string[]): string[] {
  return [...new Set(values)];
}

function sameUrl(left: string | undefined, right: string | undefined): boolean {
  if (!left || !right) return false;
  try {
    const a = new URL(left);
    const b = new URL(right);
    return a.protocol === b.protocol
      && a.hostname.toLowerCase() === b.hostname.toLowerCase()
      && (a.port || (a.protocol === 'https:' ? '443' : '80')) === (b.port || (b.protocol === 'https:' ? '443' : '80'))
      && (a.pathname || '/') === (b.pathname || '/');
  } catch {
    return false;
  }
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

export async function findAdoptablePocketIdRoute(
  root: string,
  runtime: PocketIdRuntimeDetection,
  commandRunner: CommandRunner,
): Promise<PrivateEdgeRouteOwnership | undefined> {
  if (!runtime.serviceName || !runtime.port || !validIssuer(runtime.appUrl)) return undefined;
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
  const serve = await commandRunner(
    target.command,
    [...target.argsPrefix, 'serve', 'status', '--json'],
    { cwd: root, timeoutMs: 3_000 },
  );
  if (!serve.ok) return undefined;
  const route = parseTailscaleServeRoutes(serve.stdout).find((candidate) => sameUrl(candidate.url, runtime.appUrl));
  if (!route) return undefined;
  const caddyfile = await readWorkspaceFile(caddy.configPath);
  if (!caddyfile) return undefined;
  const listener = escapeRegExp(route.targetPort);
  const block = caddyfile.match(new RegExp(
    `(?:^|\\n)\\s*(?::|https?://127\\.0\\.0\\.1:)${listener}\\s*\\{([\\s\\S]*?)\\n\\s*\\}`,
    'm',
  ))?.[1];
  if (!block || !new RegExp(`\\breverse_proxy\\s+[^\\n]*\\b${escapeRegExp(runtime.serviceName)}(?:\\s|:|$)`, 'm').test(block)) {
    return undefined;
  }
  const issuer = new URL(runtime.appUrl);
  const httpsPort = issuer.port || '443';
  return {
    adapter: 'tailscale-caddy',
    adopted: true,
    serviceId: 'pocket-id',
    serviceName: 'Pocket ID',
    targetPort: runtime.port,
    proxyPort: route.targetPort,
    httpsPort,
    url: runtime.appUrl,
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

export class IdentityPlanner {
  constructor(
    private readonly root: string,
    private readonly configRepository = new ConfigRepository(root),
    private readonly commandRunner: CommandRunner = runCommand,
    private readonly workspaceState = new WorkspaceStateRepository(path.join(root, '.locallink', 'workspace-state.json')),
    private readonly edgePlanner = new ExtensionPlanner(root, configRepository, commandRunner, workspaceState),
  ) {}

  async plan(capability: string): Promise<IdentityInstallPlan> {
    if (capability !== 'identity') {
      throw new AppError(
        'UNSUPPORTED_IDENTITY_CAPABILITY',
        `Identity planning supports "identity"; received "${capability}".`,
        400,
      );
    }
    await this.configRepository.hydrateProcessEnv();
    const model = await this.configRepository.loadProjectModel();
    const workspace = deriveWorkspaceIdentity(this.root, model.env.LOCALLINK_WORKSPACE_ID);
    const declaration = identityExtension(model.extensions);
    const runtime = await detectPocketIdRuntime(this.root, this.commandRunner, model.env);
    await this.workspaceState.load();
    const existingOwnership = this.workspaceState.read().privateEdgeRoutes.find((route) => route.serviceId === 'pocket-id');
    const adoptableRoute = existingOwnership
      ? undefined
      : await findAdoptablePocketIdRoute(this.root, runtime, this.commandRunner);
    const edgePlan = await this.edgePlanner.plan('private-edge');
    const pocketService = model.definitions.find((service) => (
      service.id === 'pocket-id'
      || service.name.toLowerCase() === 'pocket id'
      || service.name.toLowerCase() === 'pocket-id'
    ));
    const selected = Boolean(pocketService && edgePlan.selection.selected.some((service) => service.id === pocketService.id));
    const route = pocketService
      ? edgePlan.routePlan.routes.find((candidate) => candidate.serviceId === pocketService.id)
      : undefined;
    const issuer = validIssuer(runtime.appUrl)
      ? runtime.appUrl
      : validIssuer(route?.url)
        ? route?.url
        : undefined;
    const issuerMismatch = validIssuer(runtime.appUrl)
      && validIssuer(route?.url)
      && new URL(runtime.appUrl).toString() !== new URL(route.url).toString();
    const routeActive = route?.status === 'active' || Boolean(existingOwnership?.status === 'active');
    const defaultsReady = model.env.POCKET_ID_PORT === '1411'
      && model.env.POCKET_ID_INTERNAL_PORT === '1411'
      && Boolean(model.env.POCKET_ID_TRUST_PROXY);

    const steps: ExtensionPlanStep[] = [
      {
        id: 'declare-pocket-id',
        label: 'Declare the Pocket ID identity capability',
        owner: 'locallink',
        status: declaration?.enabled ? 'complete' : 'pending',
        automatic: true,
        targetFile: 'locallink.extensions.yml',
        detail: declaration?.enabled
          ? `The ${declaration.id} identity-provider declaration is enabled.`
          : 'Add an enabled, provider-neutral identity-provider declaration for Pocket ID.',
      },
      {
        id: 'install-pocket-id',
        label: 'Install the Pocket ID Docker service',
        owner: 'locallink',
        status: runtime.available ? 'complete' : 'pending',
        automatic: true,
        targetFile: 'docker-compose.yml',
        detail: runtime.available
          ? `Docker Compose service ${runtime.serviceName} is declared.`
          : 'Add the Pocket ID v2 service with loopback-only publishing and a persistent data volume.',
      },
      {
        id: 'configure-pocket-id-secret',
        label: 'Generate the Pocket ID encryption key',
        owner: 'locallink',
        status: runtime.encryptionConfigured ? 'complete' : 'pending',
        automatic: true,
        targetFile: POCKET_ID_SECRET_PATH,
        detail: runtime.encryptionConfigured
          ? `An existing ${runtime.encryptionSource === 'file' ? 'workspace secret file' : 'environment secret'} is configured and will be preserved.`
          : 'Generate a 32-byte workspace-local encryption key without printing or committing it.',
      },
      {
        id: 'configure-pocket-id-defaults',
        label: 'Configure Pocket ID local defaults',
        owner: 'locallink',
        status: defaultsReady ? 'complete' : 'pending',
        automatic: true,
        targetFile: '.env',
        detail: defaultsReady
          ? 'Pocket ID uses the expected loopback port and explicit proxy trust setting.'
          : 'Set the local/internal ports and keep proxy trust disabled unless the operator explicitly narrows it.',
      },
      {
        id: 'select-pocket-id-edge',
        label: 'Select Pocket ID for Private Edge',
        owner: 'locallink',
        status: selected ? 'complete' : 'pending',
        automatic: true,
        targetFile: 'locallink.extensions.yml',
        detail: selected
          ? 'Pocket ID is included in this workspace’s explicit Private Edge selection.'
          : 'Add Pocket ID to the existing Private Edge selection without deselecting other services.',
      },
      {
        id: 'configure-pocket-id-issuer',
        label: 'Bind Pocket ID to its private HTTPS issuer',
        owner: issuerMismatch ? 'user' : 'locallink',
        status: issuerMismatch ? 'blocked' : validIssuer(runtime.appUrl) ? 'complete' : route?.url ? 'pending' : 'blocked',
        automatic: !issuerMismatch,
        targetFile: '.env',
        detail: issuerMismatch
          ? `The configured issuer ${runtime.appUrl} differs from the planned Private Edge URL ${route?.url}. Changing an active issuer can break registered OIDC clients, so LocalLink will not replace it automatically.`
          : validIssuer(runtime.appUrl)
            ? `Pocket ID’s issuer is ${runtime.appUrl}.`
            : route?.url
              ? `Set POCKET_ID_APP_URL=${route.url} from the deterministic Private Edge plan.`
              : 'A connected Private Edge route plan is required before Pocket ID can receive a stable HTTPS issuer.',
      },
      {
        id: 'adopt-pocket-id-route',
        label: 'Capture an existing verified Pocket ID route',
        owner: 'locallink',
        status: existingOwnership ? 'complete' : adoptableRoute ? 'pending' : 'complete',
        automatic: true,
        detail: existingOwnership
          ? `LocalLink already records the active HTTPS listener on port ${existingOwnership.httpsPort}.`
          : adoptableRoute
            ? `The configured issuer, live Tailscale listener, and Caddy upstream agree on HTTPS :${adoptableRoute.httpsPort}; record that existing route without changing it.`
            : 'No pre-existing matching route needs adoption.',
      },
      {
        id: 'start-pocket-id',
        label: 'Start and verify Pocket ID',
        owner: 'locallink',
        status: runtime.healthy ? 'complete' : runtime.configured ? 'pending' : 'blocked',
        automatic: true,
        detail: runtime.healthy
          ? 'Pocket ID’s built-in container healthcheck passes.'
          : runtime.configured
            ? 'Start the Docker service and run its built-in healthcheck.'
            : 'Pocket ID will start after its encryption key and HTTPS issuer are configured.',
      },
      {
        id: 'publish-pocket-id',
        label: 'Publish the private Pocket ID URL',
        owner: 'user',
        status: routeActive ? 'complete' : 'pending',
        automatic: false,
        detail: routeActive
          ? `Pocket ID is published privately at ${route?.url || existingOwnership?.url || runtime.appUrl}.`
          : adoptableRoute
            ? 'The existing live Caddy and Tailscale route can be captured without changing either runtime.'
          : edgePlan.routePlan.confirmationToken
            ? 'Review the generated Private Edge route and explicitly confirm its fresh token.'
            : edgePlan.routePlan.summary,
      },
      {
        id: 'create-pocket-id-admin',
        label: 'Create the first administrator and passkey',
        owner: 'user',
        status: 'pending',
        automatic: false,
        detail: setupUrl(issuer)
          ? `Open ${setupUrl(issuer)} and complete the one-time administrator/passkey setup.`
          : 'Complete the one-time administrator/passkey setup after the private HTTPS issuer is reachable.',
      },
      {
        id: 'register-oidc-clients',
        label: 'Register application OIDC clients',
        owner: 'user',
        status: 'pending',
        automatic: false,
        detail: 'Choose each application’s callback/logout URLs and create one OIDC client per application; keep the generated client secret local.',
      },
    ];

    const automaticPending = steps.some((step) => step.owner === 'locallink' && step.status === 'pending');
    const automaticBlocked = steps.some((step) => step.owner === 'locallink' && step.status === 'blocked');
    const state: IdentityInstallPlan['state'] = issuerMismatch
      ? 'error'
      : automaticPending
        ? 'ready-to-apply'
        : automaticBlocked
          ? 'ready-to-route'
          : !routeActive
            ? 'ready-to-route'
            : runtime.healthy
              ? 'waiting-user'
              : 'error';

    return {
      workspace,
      capability: 'identity',
      provider: 'pocket-id',
      state,
      summary: issuerMismatch
        ? 'Pocket ID has an issuer mismatch that requires an explicit migration decision.'
        : automaticPending
          ? 'LocalLink can install and configure the workspace-owned Pocket ID components.'
          : !routeActive
            ? 'Pocket ID is configured locally; review and confirm its Private Edge route.'
            : runtime.healthy
              ? 'Pocket ID infrastructure is healthy; finish the administrator/passkey and OIDC client choices.'
              : 'Pocket ID is configured but not healthy.',
      canApply: automaticPending && !issuerMismatch,
      service: {
        name: runtime.serviceName || 'pocket-id',
        installed: runtime.available,
        running: runtime.running,
        healthy: runtime.healthy,
        persistent: runtime.persistent,
        port: runtime.port || model.env.POCKET_ID_PORT || '1411',
        issuer,
        setupUrl: setupUrl(issuer),
      },
      privateEdge: {
        declared: Boolean(model.extensions.find((extension) => extension.kind === 'network-edge')?.enabled),
        selected,
        state: edgePlan.routePlan.state,
        url: route?.url,
        confirmationToken: edgePlan.routePlan.confirmationToken,
      },
      steps,
    };
  }

  async apply(capability: string): Promise<IdentityApplyResult> {
    const before = await this.plan(capability);
    if (!before.canApply) {
      return {
        capability: 'identity',
        provider: 'pocket-id',
        applied: false,
        changedFiles: [],
        started: false,
        plan: before,
      };
    }

    const changedFiles: string[] = [];
    await this.configRepository.hydrateProcessEnv();
    let model = await this.configRepository.loadProjectModel();
    let runtime = await detectPocketIdRuntime(this.root, this.commandRunner, model.env);
    const directKey = model.env.POCKET_ID_ENCRYPTION_KEY?.trim();
    let generatedSecret = false;
    if (!runtime.encryptionConfigured && !directKey) {
      generatedSecret = (await ensureEncryptionSecret(this.root)).created;
      if (generatedSecret) changedFiles.push(POCKET_ID_SECRET_PATH);
    }

    if (!runtime.available || !runtime.persistent || !runtime.encryptionConfigured) {
      const useDirectKey = Boolean(directKey);
      await this.configRepository.writeInfraConfig({
        targetFile: 'docker-compose.yml',
        patch: {
          kind: 'compose',
          serviceName: runtime.serviceName || 'pocket-id',
          updates: {
            ...(!runtime.available ? {
              image: 'ghcr.io/pocket-id/pocket-id:v2',
              restart: 'unless-stopped',
              profiles: ['identity'],
              ports: ['127.0.0.1:${POCKET_ID_PORT:-1411}:${POCKET_ID_INTERNAL_PORT:-1411}'],
              dependsOn: [],
            } : {}),
            environment: {
              APP_URL: '${POCKET_ID_APP_URL}',
              ...(useDirectKey
                ? { ENCRYPTION_KEY: '${POCKET_ID_ENCRYPTION_KEY}' }
                : { ENCRYPTION_KEY_FILE: POCKET_ID_SECRET_TARGET }),
              TRUST_PROXY: '${POCKET_ID_TRUST_PROXY:-false}',
              ALLOW_INSECURE_CALLBACK_URLS: 'false',
              PORT: '${POCKET_ID_INTERNAL_PORT:-1411}',
            },
            volumes: [
              `${POCKET_ID_DATA_VOLUME}:/app/data`,
              ...(!useDirectKey
                ? [`./${POCKET_ID_SECRET_PATH}:${POCKET_ID_SECRET_TARGET}:ro`]
                : []),
            ],
            healthcheck: {
              test: ['CMD', '/app/pocket-id', 'healthcheck'],
              interval: '10s',
              timeout: '5s',
              retries: 12,
              start_period: '20s',
            },
            labels: {
              'locallink.name': 'Pocket ID',
              'locallink.provider': 'pocket-id',
              'locallink.group': 'docker',
              'locallink.runtime': 'docker',
              'locallink.notes': 'Private passkey-first OIDC provider for internal applications.',
              'locallink.detail': 'Tailscale controls network reachability; Pocket ID provides provider-neutral application sessions.',
              'locallink.tags': 'docker,identity,oidc,passkey',
              'locallink.portEnv': 'POCKET_ID_PORT',
              'locallink.envVars': 'POCKET_ID_APP_URL;POCKET_ID_PORT;POCKET_ID_INTERNAL_PORT;POCKET_ID_TRUST_PROXY',
              'locallink.docsUrl': 'https://pocket-id.org/docs/setup/installation',
            },
          },
          topLevelVolumes: {
            [POCKET_ID_DATA_VOLUME]: {},
          },
        },
      });
      changedFiles.push('docker-compose.yml');
    }

    await this.configRepository.writeInfraConfig({
      targetFile: '.env',
      patch: {
        kind: 'env',
        set: {
          POCKET_ID_PORT: model.env.POCKET_ID_PORT || '1411',
          POCKET_ID_INTERNAL_PORT: model.env.POCKET_ID_INTERNAL_PORT || '1411',
          POCKET_ID_TRUST_PROXY: model.env.POCKET_ID_TRUST_PROXY || 'false',
        },
      },
    });
    changedFiles.push('.env');
    await this.configRepository.writeInfraConfig({
      targetFile: '.env.example',
      patch: {
        kind: 'env',
        set: {
          POCKET_ID_APP_URL: '',
          POCKET_ID_PORT: '1411',
          POCKET_ID_INTERNAL_PORT: '1411',
          POCKET_ID_TRUST_PROXY: 'false',
        },
        unset: ['POCKET_ID_ENCRYPTION_KEY'],
      },
    });
    changedFiles.push('.env.example');
    await this.configRepository.writeInfraConfig({
      targetFile: 'locallink.extensions.yml',
      patch: {
        kind: 'extension',
        extensionId: identityExtension(model.extensions)?.id || 'pocket-id',
        updates: {
          name: identityExtension(model.extensions)?.name || 'Pocket ID Application SSO',
          kind: 'identity-provider',
          enabled: true,
          detail: identityExtension(model.extensions)?.detail
            || 'Private passkey-first OIDC issuer for internal applications; Tailscale remains the network gate.',
          dependsOn: ['private-edge'],
          exposedPorts: [model.env.POCKET_ID_PORT || '1411'],
          requiredEnv: ['POCKET_ID_APP_URL'],
          docsUrl: 'https://pocket-id.org/docs/setup/installation',
        },
      },
    });
    changedFiles.push('locallink.extensions.yml');

    model = await this.configRepository.loadProjectModel();
    const pocketService = model.definitions.find((service) => service.id === 'pocket-id');
    if (!pocketService) {
      throw new AppError('POCKET_ID_INSTALL_FAILED', 'Pocket ID was written to Docker Compose but could not be rediscovered.', 500);
    }
    const existingEdge = model.extensions.find((extension) => extension.kind === 'network-edge');
    const selectedServiceIds = model.definitions
      .filter((service) => service.port && existingEdge?.exposedPorts.includes(service.port))
      .map((service) => service.id);
    runtime = await detectPocketIdRuntime(this.root, this.commandRunner, model.env);
    await this.workspaceState.load();
    const existingOwnership = this.workspaceState.read().privateEdgeRoutes.find((route) => route.serviceId === pocketService.id);
    if (!existingOwnership) {
      const adoptable = await findAdoptablePocketIdRoute(this.root, runtime, this.commandRunner);
      if (adoptable) {
        await this.workspaceState.upsertPrivateEdgeRoutes([{ ...adoptable, serviceId: pocketService.id, serviceName: pocketService.name }]);
      }
    }
    await this.edgePlanner.apply('private-edge', unique([...selectedServiceIds, pocketService.id]));
    if (!changedFiles.includes('locallink.extensions.yml')) changedFiles.push('locallink.extensions.yml');

    const edgePlan = await this.edgePlanner.plan('private-edge');
    const route = edgePlan.routePlan.routes.find((candidate) => candidate.serviceId === pocketService.id);
    const existingIssuer = model.env.POCKET_ID_APP_URL;
    if (!validIssuer(existingIssuer) && validIssuer(route?.url)) {
      await this.configRepository.writeInfraConfig({
        targetFile: '.env',
        patch: {
          kind: 'env',
          set: { POCKET_ID_APP_URL: route.url },
        },
      });
    }

    await this.configRepository.hydrateProcessEnv();
    model = await this.configRepository.loadProjectModel();
    runtime = await detectPocketIdRuntime(this.root, this.commandRunner, model.env);
    let started = false;
    if (runtime.configured && !runtime.running) {
      const start = pocketIdStartCommand(runtime);
      if (!start) {
        throw new AppError('POCKET_ID_START_UNSUPPORTED', 'Pocket ID is not a manageable Docker Compose service.', 409);
      }
      const result = await this.commandRunner(start.command, start.args, { cwd: this.root, timeoutMs: 120_000 });
      if (!result.ok) {
        throw new AppError(
          'POCKET_ID_START_FAILED',
          `Pocket ID configuration was saved, but Docker could not start ${runtime.serviceName}: ${result.stderr || result.error || 'unknown error'}`,
          502,
        );
      }
      started = true;
      runtime = await detectPocketIdRuntime(this.root, this.commandRunner, model.env);
      if (!runtime.healthy) {
        throw new AppError(
          'POCKET_ID_HEALTHCHECK_FAILED',
          `Pocket ID started, but its built-in healthcheck did not pass. Inspect docker compose logs ${runtime.serviceName}.`,
          502,
        );
      }
    }
    await this.workspaceState.load();
    await this.workspaceState.updatePreferences({ pocketIdEnabled: true });

    return {
      capability: 'identity',
      provider: 'pocket-id',
      applied: changedFiles.length > 0 || started,
      changedFiles: unique(changedFiles),
      started,
      plan: await this.plan('identity'),
    };
  }
}
