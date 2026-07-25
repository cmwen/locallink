import path from 'node:path';

import type {
  ExtensionAutomation,
  ExtensionKind,
  ExtensionLifecycleCheck,
  ExtensionLifecycleRecord,
  WorkspaceExtension,
} from '../shared/contracts';
import { isCommandMissingResult, parseJsonOutput, runCommand, type CommandRunner } from '../shared/utils';
import { parseTailscaleServeRoutes } from '../runtime/network-edge';
import { detectCaddyRuntime } from '../runtime/caddy-runtime';
import { detectTailscaleRuntime, tailscaleRuntimeCommand } from '../runtime/tailscale-runtime';
import { WorkspaceStateRepository } from '../state/workspace-state';
import { ConfigRepository } from '../config/files';
import { detectPocketIdRuntime } from '../runtime/pocket-id-runtime';
import { detectOpenObserveRuntime } from '../runtime/openobserve-runtime';

interface CapabilitySpec {
  id: string;
  name: string;
  kind: ExtensionKind;
  summary: string;
  docsUrl?: string;
  automation: ExtensionAutomation;
}

interface TailscaleStatus {
  BackendState?: string;
}

const CAPABILITY_CATALOG: CapabilitySpec[] = [
  {
    id: 'private-edge',
    name: 'Private Edge',
    kind: 'network-edge',
    summary: 'Publish selected loopback services to an authenticated private network.',
    docsUrl: 'https://tailscale.com/docs/features/tailscale-serve',
    automation: 'guided',
  },
  {
    id: 'reverse-proxy',
    name: 'Reverse Proxy',
    kind: 'reverse-proxy',
    summary: 'Route stable workspace origins to local service ports.',
    docsUrl: 'https://caddyserver.com/docs/quick-starts/reverse-proxy',
    automation: 'guided',
  },
  {
    id: 'identity',
    name: 'Identity',
    kind: 'identity-provider',
    summary: 'Add provider-neutral OIDC sign-in to private applications.',
    docsUrl: '/docs/pocket-id-tailscale.html',
    automation: 'guided',
  },
  {
    id: 'observability',
    name: 'Observability',
    kind: 'observability',
    summary: 'Connect services to an OTLP-compatible telemetry backend.',
    automation: 'guided',
  },
];

function availableRecord(spec: CapabilitySpec): ExtensionLifecycleRecord {
  return {
    ...spec,
    declared: false,
    enabled: false,
    state: 'available',
    summary: `${spec.summary} This capability is not declared in the current workspace.`,
    nextStep: `Add the ${spec.name} capability to this workspace before LocalLink changes runtime configuration.`,
    checks: [],
  };
}

function declarationCheck(extension: WorkspaceExtension): ExtensionLifecycleCheck {
  return {
    id: 'declaration',
    label: 'Workspace declaration',
    status: extension.enabled ? 'ok' : 'warning',
    detail: extension.enabled
      ? `Declared as ${extension.id} in locallink.extensions.yml.`
      : `The ${extension.id} declaration is disabled.`,
    owner: 'locallink',
  };
}

function baseDeclaredRecord(spec: CapabilitySpec, extension: WorkspaceExtension): ExtensionLifecycleRecord {
  if (!extension.enabled) {
    return {
      ...spec,
      declarationId: extension.id,
      declared: true,
      enabled: false,
      state: 'disabled',
      summary: `${spec.name} is declared but disabled for this workspace.`,
      nextStep: `Enable ${extension.id} in locallink.extensions.yml when this workspace needs it.`,
      docsUrl: extension.docsUrl || spec.docsUrl,
      checks: [declarationCheck(extension)],
    };
  }

  if (extension.missingEnv.length > 0) {
    return {
      ...spec,
      declarationId: extension.id,
      declared: true,
      enabled: true,
      state: 'waiting-configuration',
      summary: `${spec.name} is declared but required workspace configuration is missing.`,
      nextStep: `Configure ${extension.missingEnv.join(', ')} without committing secret values.`,
      docsUrl: extension.docsUrl || spec.docsUrl,
      checks: [
        declarationCheck(extension),
        {
          id: 'required-environment',
          label: 'Required configuration',
          status: 'missing',
          detail: `Missing: ${extension.missingEnv.join(', ')}.`,
          owner: 'user',
        },
      ],
    };
  }

  return {
    ...spec,
    declarationId: extension.id,
    declared: true,
    enabled: true,
    state: extension.kind === 'dashboard' ? 'healthy' : 'declared',
    summary: extension.kind === 'dashboard'
      ? 'The LocalLink dashboard is healthy for this workspace.'
      : `${spec.name} is declared and its required workspace configuration is present. Runtime health is not yet verified.`,
    docsUrl: extension.docsUrl || spec.docsUrl,
    checks: [declarationCheck(extension)],
  };
}

async function privateEdgeRecord(
  spec: CapabilitySpec,
  extension: WorkspaceExtension,
  commandRunner: CommandRunner,
  workspaceRoot?: string,
): Promise<ExtensionLifecycleRecord> {
  const base = baseDeclaredRecord(spec, extension);
  if (!extension.enabled || extension.missingEnv.length > 0) return base;

  const runtime = workspaceRoot
    ? await detectTailscaleRuntime(workspaceRoot, commandRunner, extension.command || 'tailscale')
    : undefined;
  const target = runtime
    ? tailscaleRuntimeCommand(runtime, extension.command || 'tailscale')
    : { command: extension.command || 'tailscale', argsPrefix: [] };
  if (runtime?.source === 'docker-compose' && !runtime.running) {
    return {
      ...base,
      state: 'installed',
      summary: `Private Edge is declared and the ${runtime.serviceName} Docker sidecar is ready to be started.`,
      nextStep: 'Select services and review a confirmed route plan; LocalLink can start the workspace sidecar.',
      checks: [...base.checks, {
        id: 'tailscale-runtime',
        label: 'Tailscale Docker runtime',
        status: runtime.manageable ? 'warning' : 'missing',
        detail: runtime.detail,
        owner: 'locallink',
      }],
    };
  }
  if (runtime?.source === 'missing') {
    const commandMissing = /not available on PATH/i.test(runtime.detail);
    return {
      ...base,
      state: commandMissing ? 'waiting-external' : 'waiting-user',
      automation: 'manual',
      summary: commandMissing
        ? 'Private Edge is declared, but Tailscale is not installed on this machine.'
        : 'Private Edge is declared, but Tailscale is not connected.',
      nextStep: commandMissing
        ? 'Install Tailscale, then return to LocalLink to verify and configure private routes.'
        : 'Authenticate this machine with Tailscale and approve the required tailnet access policy.',
      checks: [...base.checks, {
        id: commandMissing ? 'tailscale-cli' : 'tailscale-connection',
        label: commandMissing ? 'Tailscale CLI' : 'Tailnet connection',
        status: 'missing',
        detail: runtime.detail,
        owner: commandMissing ? 'system' : 'user',
      }],
    };
  }
  const statusResult = target
    ? await commandRunner(target.command, [...target.argsPrefix, 'status', '--json'], { cwd: workspaceRoot, timeoutMs: 2_000 })
    : { ok: false, code: null, signal: null, stdout: '', stderr: runtime?.detail || 'Tailscale is unavailable.', timedOut: false, error: runtime?.detail };
  if (isCommandMissingResult(statusResult)) {
    return {
      ...base,
      state: 'waiting-external',
      automation: 'manual',
      summary: 'Private Edge is declared, but Tailscale is not installed on this machine.',
      nextStep: 'Install Tailscale, then return to LocalLink to verify and configure private routes.',
      checks: [...base.checks, {
        id: 'tailscale-cli',
        label: 'Tailscale CLI',
        status: 'missing',
        detail: 'The tailscale command is not available on PATH.',
        owner: 'system',
      }],
    };
  }

  const status = statusResult.ok ? parseJsonOutput<TailscaleStatus>(statusResult.stdout)[0] : undefined;
  const connected = statusResult.ok && (!status?.BackendState || status.BackendState.toLowerCase() === 'running');
  if (!connected) {
    return {
      ...base,
      state: 'waiting-user',
      automation: 'manual',
      summary: 'Tailscale is installed, but this machine has not joined a tailnet.',
      nextStep: 'Authenticate this machine with Tailscale and approve the required tailnet access policy.',
      checks: [...base.checks, {
        id: 'tailscale-connection',
        label: 'Tailnet connection',
        status: 'missing',
        detail: statusResult.stderr || 'Tailscale is not connected.',
        owner: 'user',
      }],
    };
  }

  const serveResult = await commandRunner(
    target!.command,
    [...target!.argsPrefix, 'serve', 'status', '--json'],
    { cwd: workspaceRoot, timeoutMs: 2_000 },
  );
  const routes = serveResult.ok ? parseTailscaleServeRoutes(serveResult.stdout) : [];
  const workspacePorts = new Set(extension.exposedPorts.filter((port) => Boolean(port && port !== '—')));
  let workspaceRoutes = routes.filter((route) => workspacePorts.has(route.targetPort));
  const routedPorts = new Set(workspaceRoutes.map((route) => route.targetPort));
  if (workspaceRoot && extension.adapter === 'tailscale-caddy') {
    const state = new WorkspaceStateRepository(path.join(workspaceRoot, '.locallink', 'workspace-state.json'));
    const ownership = (await state.load()).privateEdgeRoutes.filter((route) => route.adapter === 'tailscale-caddy');
    const ownedRoutes = ownership.flatMap((owned) => routes.filter((route) => {
      if (route.targetPort !== owned.proxyPort) return false;
      try {
        const url = new URL(route.url);
        return (url.port || (url.protocol === 'https:' ? '443' : '80')) === owned.httpsPort;
      } catch {
        return false;
      }
    }));
    workspaceRoutes = [...workspaceRoutes, ...ownedRoutes].filter((route, index, values) => (
      values.findIndex((candidate) => candidate.url === route.url && candidate.targetPort === route.targetPort) === index
    ));
    for (const owned of ownership) {
      if (ownedRoutes.some((route) => route.targetPort === owned.proxyPort)) routedPorts.add(owned.targetPort);
    }
  }
  const missingPorts = [...workspacePorts].filter((port) => !routedPorts.has(port));
  if (workspacePorts.size === 0 || missingPorts.length > 0) {
    return {
      ...base,
      state: 'waiting-configuration',
      summary: 'Tailscale is connected, but no private Serve routes are configured.',
      nextStep: 'Select the workspace services to publish, then configure Tailscale Serve routes for their loopback ports.',
      checks: [
        ...base.checks,
        {
          id: 'tailscale-connection',
          label: 'Tailnet connection',
          status: 'ok',
          detail: 'This machine is connected to a tailnet.',
          owner: 'user',
        },
        {
          id: 'tailscale-routes',
          label: 'Private routes',
          status: 'missing',
          detail: workspacePorts.size > 0 && workspaceRoutes.length > 0
            ? `Tailscale Serve is still missing routes for selected workspace ports: ${missingPorts.join(', ')}.`
            : routes.length > 0
              ? 'Tailscale Serve routes exist, but none target a service declared by this workspace.'
            : 'No active Tailscale Serve routes were detected.',
          owner: 'locallink',
        },
      ],
    };
  }

  return {
    ...base,
    state: 'healthy',
    summary: `Private Edge is connected with ${workspaceRoutes.length} active workspace Tailscale Serve route${workspaceRoutes.length === 1 ? '' : 's'}.`,
    nextStep: 'Review the published service URLs and tailnet access policy whenever routes change.',
    checks: [
      ...base.checks,
      {
        id: 'tailscale-connection',
        label: 'Tailnet connection',
        status: 'ok',
        detail: 'This machine is connected to a tailnet.',
        owner: 'user',
      },
      {
        id: 'tailscale-routes',
        label: 'Private routes',
        status: 'ok',
        detail: `${workspaceRoutes.length} active workspace route${workspaceRoutes.length === 1 ? '' : 's'} detected.`,
        owner: 'locallink',
      },
    ],
  };
}

async function reverseProxyRecord(
  spec: CapabilitySpec,
  extension: WorkspaceExtension,
  commandRunner: CommandRunner,
  workspaceRoot?: string,
): Promise<ExtensionLifecycleRecord> {
  const base = baseDeclaredRecord(spec, extension);
  if (!extension.enabled || extension.missingEnv.length > 0) return base;

  const caddyRuntime = !extension.command || extension.command === 'caddy'
    ? await detectCaddyRuntime(workspaceRoot, commandRunner, extension.command || 'caddy')
    : undefined;
  const candidates = extension.command ? (extension.command === 'caddy' ? [] : [extension.command]) : ['traefik', 'nginx'];
  const results = await Promise.all(candidates.map(async (command) => ({
    command,
    result: await commandRunner(command, command === 'nginx' ? ['-v'] : ['version'], { timeoutMs: 1_500 }),
  })));
  const detected = results.find(({ result }) => result.ok);
  if (caddyRuntime?.available) {
    return {
      ...base,
      state: 'installed',
      summary: caddyRuntime.source === 'docker-compose'
        ? `Caddy is installed through this workspace's Docker Compose configuration${caddyRuntime.running ? ' and its service is running' : ''}.`
        : 'Caddy is installed as a host command. Route health still depends on the workspace proxy configuration.',
      nextStep: caddyRuntime.source === 'docker-compose' && !caddyRuntime.running
        ? `Review a confirmed Private Edge plan; LocalLink can start ${caddyRuntime.serviceName} when applying managed Caddy routes.`
        : 'Verify configured routes and upstream health before treating the proxy as ready.',
      checks: [...base.checks, {
        id: 'reverse-proxy-runtime',
        label: 'Reverse proxy runtime',
        status: caddyRuntime.running ? 'ok' : 'warning',
        detail: caddyRuntime.detail,
        owner: 'system',
      }],
    };
  }

  if (!detected) {
    return {
      ...base,
      state: 'waiting-external',
      automation: 'manual',
      summary: 'A reverse proxy is declared, but no workspace Docker service or supported host command was detected.',
      nextStep: 'Declare the selected reverse proxy in this workspace Docker Compose file, or install its host command.',
      checks: [...base.checks, {
        id: 'reverse-proxy-command',
        label: 'Reverse proxy runtime',
        status: 'missing',
        detail: caddyRuntime?.detail || 'No supported reverse proxy command responded successfully.',
        owner: 'system',
      }],
    };
  }

  return {
    ...base,
    state: 'installed',
    summary: `${detected.command} is installed. Route health still depends on the workspace proxy configuration.`,
    nextStep: 'Verify generated routes and upstream health before treating the proxy as ready.',
    checks: [...base.checks, {
      id: 'reverse-proxy-command',
      label: 'Reverse proxy runtime',
      status: 'ok',
      detail: `${detected.command} responded successfully.`,
      owner: 'system',
    }],
  };
}

async function identityRecord(
  spec: CapabilitySpec,
  extension: WorkspaceExtension,
  commandRunner: CommandRunner,
  workspaceRoot?: string,
): Promise<ExtensionLifecycleRecord> {
  const base = baseDeclaredRecord(spec, workspaceRoot ? { ...extension, missingEnv: [] } : extension);
  if (!extension.enabled || !workspaceRoot) return base;

  const model = await new ConfigRepository(workspaceRoot, false).loadProjectModel();
  const runtime = await detectPocketIdRuntime(workspaceRoot, commandRunner, model.env);
  if (!runtime.available) {
    return {
      ...base,
      state: 'waiting-configuration',
      automation: 'automatic',
      summary: 'Identity is declared, but the Pocket ID Docker service is not installed.',
      nextStep: 'Run the reviewed Identity workspace plan; LocalLink can install Pocket ID with persistent storage and a generated secret.',
      checks: [...base.checks, {
        id: 'pocket-id-runtime',
        label: 'Pocket ID runtime',
        status: 'missing',
        detail: runtime.detail,
        owner: 'locallink',
      }],
    };
  }

  if (!runtime.encryptionConfigured || !runtime.appUrl?.startsWith('https://') || !runtime.persistent) {
    const missing = [
      !runtime.encryptionConfigured ? 'an encryption key' : '',
      !runtime.appUrl?.startsWith('https://') ? 'a private HTTPS issuer' : '',
      !runtime.persistent ? 'persistent /app/data storage' : '',
    ].filter(Boolean);
    return {
      ...base,
      state: 'waiting-configuration',
      automation: 'automatic',
      summary: 'Pocket ID is installed, but its workspace-owned configuration is incomplete.',
      nextStep: `Run the Identity plan to configure ${missing.join(', ')}.`,
      checks: [...base.checks, {
        id: 'pocket-id-configuration',
        label: 'Pocket ID configuration',
        status: 'missing',
        detail: runtime.detail,
        owner: 'locallink',
      }],
    };
  }

  if (!runtime.running) {
    return {
      ...base,
      state: 'installed',
      automation: 'automatic',
      summary: 'Pocket ID is configured with persistent storage but is not running.',
      nextStep: 'Apply the reviewed Identity plan; LocalLink can start the Docker service and verify its built-in healthcheck.',
      checks: [...base.checks, {
        id: 'pocket-id-runtime',
        label: 'Pocket ID runtime',
        status: 'warning',
        detail: runtime.detail,
        owner: 'locallink',
      }],
    };
  }

  if (!runtime.healthy) {
    return {
      ...base,
      state: 'error',
      automation: 'automatic',
      summary: 'Pocket ID is running, but its built-in healthcheck is failing.',
      nextStep: `Inspect docker compose logs ${runtime.serviceName || 'pocket-id'} before publishing or registering OIDC clients.`,
      checks: [...base.checks, {
        id: 'pocket-id-health',
        label: 'Pocket ID health',
        status: 'missing',
        detail: runtime.detail,
        owner: 'system',
      }],
    };
  }

  const state = new WorkspaceStateRepository(path.join(workspaceRoot, '.locallink', 'workspace-state.json'));
  const ownership = (await state.load()).privateEdgeRoutes.find((route) => (
    route.serviceId === 'pocket-id'
    && route.status === 'active'
    && (!runtime.appUrl || route.url === runtime.appUrl)
  ));
  if (!ownership) {
    return {
      ...base,
      state: 'waiting-configuration',
      automation: 'guided',
      summary: 'Pocket ID is healthy locally, but LocalLink has not verified its private HTTPS route.',
      nextStep: 'Review and confirm the generated Private Edge route before creating the first administrator.',
      checks: [
        ...base.checks,
        {
          id: 'pocket-id-health',
          label: 'Pocket ID health',
          status: 'ok',
          detail: runtime.detail,
          owner: 'system',
        },
        {
          id: 'pocket-id-route',
          label: 'Private HTTPS issuer',
          status: 'missing',
          detail: `The configured issuer is ${runtime.appUrl}, but no matching LocalLink-owned active route is recorded.`,
          owner: 'user',
        },
      ],
    };
  }

  return {
    ...base,
    state: 'healthy',
    automation: 'guided',
    summary: `Pocket ID is healthy and privately reachable at ${ownership.url || runtime.appUrl}.`,
    nextStep: `Complete the one-time administrator/passkey setup at ${(ownership.url || runtime.appUrl)?.replace(/\/$/, '')}/setup, then create one OIDC client per application.`,
    checks: [
      ...base.checks,
      {
        id: 'pocket-id-health',
        label: 'Pocket ID health',
        status: 'ok',
        detail: runtime.detail,
        owner: 'system',
      },
      {
        id: 'pocket-id-route',
        label: 'Private HTTPS issuer',
        status: 'ok',
        detail: `LocalLink owns and verifies ${ownership.url || runtime.appUrl}.`,
        owner: 'locallink',
      },
    ],
  };
}

async function observabilityRecord(
  spec: CapabilitySpec,
  extension: WorkspaceExtension,
  commandRunner: CommandRunner,
  workspaceRoot?: string,
): Promise<ExtensionLifecycleRecord> {
  const base = baseDeclaredRecord(spec, workspaceRoot ? { ...extension, missingEnv: [] } : extension);
  if (!extension.enabled || !workspaceRoot) return base;

  const model = await new ConfigRepository(workspaceRoot, false).loadProjectModel();
  const runtime = await detectOpenObserveRuntime(workspaceRoot, commandRunner, model.env);
  if (!runtime.available) {
    return {
      ...base,
      state: 'waiting-configuration',
      automation: 'automatic',
      summary: 'Observability is declared, but the OpenObserve Docker service is not installed.',
      nextStep: 'Run the reviewed Observability plan; LocalLink can install OpenObserve with persistent storage and generated local credentials.',
      checks: [...base.checks, {
        id: 'openobserve-runtime',
        label: 'OpenObserve runtime',
        status: 'missing',
        detail: runtime.detail,
        owner: 'locallink',
      }],
    };
  }

  if (!runtime.persistent) {
    return {
      ...base,
      state: 'waiting-user',
      automation: 'guided',
      summary: 'OpenObserve is installed, but its data is not backed by declared persistent storage.',
      nextStep: 'Back up the existing container data and choose a volume migration; LocalLink will not attach a volume that could hide existing data.',
      checks: [...base.checks, {
        id: 'openobserve-storage',
        label: 'Persistent telemetry data',
        status: 'missing',
        detail: runtime.detail,
        owner: 'user',
      }],
    };
  }

  if (runtime.credentialState === 'missing' || runtime.credentialState === 'invalid') {
    return {
      ...base,
      state: 'waiting-user',
      automation: 'guided',
      summary: runtime.credentialState === 'invalid'
        ? 'OpenObserve is installed, but the saved workspace credentials no longer authenticate.'
        : 'OpenObserve is installed, but LocalLink cannot find a usable workspace credential record.',
      nextStep: runtime.credentialState === 'invalid'
        ? 'Recover or explicitly reset the OpenObserve root account; LocalLink will preserve the existing data and will not silently rotate it.'
        : 'Recover the existing root credential or explicitly choose an account reset before changing the service.',
      checks: [...base.checks, {
        id: 'openobserve-credentials',
        label: 'OpenObserve credentials',
        status: 'missing',
        detail: runtime.detail,
        owner: 'user',
      }],
    };
  }

  if (!runtime.running) {
    return {
      ...base,
      state: 'installed',
      automation: 'automatic',
      summary: 'OpenObserve has persistent storage and configured credentials but is not running.',
      nextStep: 'Apply the reviewed Observability plan; LocalLink can start the Docker service and verify /healthz and API authentication.',
      checks: [...base.checks, {
        id: 'openobserve-runtime',
        label: 'OpenObserve runtime',
        status: 'warning',
        detail: runtime.detail,
        owner: 'locallink',
      }],
    };
  }

  if (!runtime.healthy) {
    return {
      ...base,
      state: 'error',
      automation: 'automatic',
      summary: 'OpenObserve is running, but its /healthz endpoint is failing.',
      nextStep: `Inspect docker compose logs ${runtime.serviceName || 'openobserve'} before changing credentials or publishing the UI.`,
      checks: [...base.checks, {
        id: 'openobserve-health',
        label: 'OpenObserve health',
        status: 'missing',
        detail: runtime.detail,
        owner: 'system',
      }],
    };
  }

  if (runtime.credentialState !== 'valid') {
    return {
      ...base,
      state: 'waiting-configuration',
      automation: 'guided',
      summary: 'OpenObserve is healthy, but API authentication could not be verified.',
      nextStep: 'Confirm local connectivity and the configured organization, then retry the Observability plan.',
      checks: [...base.checks, {
        id: 'openobserve-credentials',
        label: 'OpenObserve credentials',
        status: 'warning',
        detail: runtime.detail,
        owner: 'system',
      }],
    };
  }

  if (!runtime.loopbackOnly) {
    return {
      ...base,
      state: 'waiting-configuration',
      automation: 'automatic',
      summary: 'OpenObserve is healthy and authenticated, but its Docker port is not restricted to loopback.',
      nextStep: 'Apply the reviewed Observability plan to recreate only this service with a loopback-only host binding while preserving its volume and credentials.',
      checks: [...base.checks, {
        id: 'openobserve-binding',
        label: 'Private host binding',
        status: 'warning',
        detail: runtime.detail,
        owner: 'locallink',
      }],
    };
  }

  const state = new WorkspaceStateRepository(path.join(workspaceRoot, '.locallink', 'workspace-state.json'));
  const ownership = (await state.load()).privateEdgeRoutes.find((route) => (
    route.serviceId === 'openobserve' && route.status === 'active'
  ));
  if (!ownership) {
    return {
      ...base,
      state: 'waiting-configuration',
      automation: 'guided',
      summary: 'OpenObserve is healthy locally, but LocalLink has not verified a private HTTPS UI route.',
      nextStep: 'Review and confirm the generated Private Edge route. Local OTLP ingestion remains available independently.',
      checks: [
        ...base.checks,
        {
          id: 'openobserve-health',
          label: 'OpenObserve health and credentials',
          status: 'ok',
          detail: runtime.detail,
          owner: 'system',
        },
        {
          id: 'openobserve-route',
          label: 'Private OpenObserve UI',
          status: 'missing',
          detail: 'No LocalLink-owned active Private Edge route is recorded for OpenObserve.',
          owner: 'user',
        },
      ],
    };
  }

  return {
    ...base,
    state: 'healthy',
    automation: 'guided',
    summary: `OpenObserve is healthy, persistent, authenticated, and privately reachable at ${ownership.url}.`,
    nextStep: `Open ${ownership.url} to inspect telemetry, then configure applications with the standard OTLP environment contract.`,
    checks: [
      ...base.checks,
      {
        id: 'openobserve-health',
        label: 'OpenObserve health and credentials',
        status: 'ok',
        detail: runtime.detail,
        owner: 'system',
      },
      {
        id: 'openobserve-route',
        label: 'Private OpenObserve UI',
        status: 'ok',
        detail: `LocalLink owns and verifies ${ownership.url}.`,
        owner: 'locallink',
      },
    ],
  };
}

export async function buildExtensionLifecycles(
  extensions: WorkspaceExtension[],
  commandRunner: CommandRunner = runCommand,
  workspaceRoot?: string,
): Promise<ExtensionLifecycleRecord[]> {
  const claimedDeclarations = new Set<string>();
  const records = await Promise.all(CAPABILITY_CATALOG.map(async (spec) => {
    const extension = extensions.find((candidate) => candidate.kind === spec.kind);
    if (!extension) return availableRecord(spec);
    claimedDeclarations.add(extension.id);
    if (spec.kind === 'network-edge') return privateEdgeRecord(spec, extension, commandRunner, workspaceRoot);
    if (spec.kind === 'reverse-proxy') return reverseProxyRecord(spec, extension, commandRunner, workspaceRoot);
    if (spec.kind === 'identity-provider') return identityRecord(spec, extension, commandRunner, workspaceRoot);
    if (spec.kind === 'observability') return observabilityRecord(spec, extension, commandRunner, workspaceRoot);
    return baseDeclaredRecord(spec, extension);
  }));

  const customRecords = extensions
    .filter((extension) => extension.kind !== 'dashboard' && !claimedDeclarations.has(extension.id))
    .map((extension) => baseDeclaredRecord({
      id: extension.id,
      name: extension.name,
      kind: extension.kind,
      summary: extension.detail,
      docsUrl: extension.docsUrl,
      automation: 'guided',
    }, extension));

  return [...records, ...customRecords];
}
