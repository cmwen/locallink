import type {
  ExtensionAutomation,
  ExtensionKind,
  ExtensionLifecycleCheck,
  ExtensionLifecycleRecord,
  ServiceDefinition,
  WorkspaceExtension,
} from '../shared/contracts';
import { isCommandMissingResult, parseJsonOutput, runCommand, type CommandRunner } from '../shared/utils';
import { parseTailscaleServeRoutes } from '../runtime/network-edge';

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
  services: ServiceDefinition[],
): Promise<ExtensionLifecycleRecord> {
  const base = baseDeclaredRecord(spec, extension);
  if (!extension.enabled || extension.missingEnv.length > 0) return base;

  const statusResult = await commandRunner(extension.command || 'tailscale', ['status', '--json'], { timeoutMs: 2_000 });
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

  const serveResult = await commandRunner(extension.command || 'tailscale', ['serve', 'status', '--json'], { timeoutMs: 2_000 });
  const routes = serveResult.ok ? parseTailscaleServeRoutes(serveResult.stdout) : [];
  const workspacePorts = new Set([
    ...services.map((service) => service.port),
    ...extension.exposedPorts,
  ].filter((port): port is string => Boolean(port && port !== '—')));
  const workspaceRoutes = routes.filter((route) => workspacePorts.has(route.targetPort));
  if (workspaceRoutes.length === 0) {
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
          detail: routes.length > 0
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
): Promise<ExtensionLifecycleRecord> {
  const base = baseDeclaredRecord(spec, extension);
  if (!extension.enabled || extension.missingEnv.length > 0) return base;

  const candidates = extension.command ? [extension.command] : ['caddy', 'traefik', 'nginx'];
  const results = await Promise.all(candidates.map(async (command) => ({
    command,
    result: await commandRunner(command, command === 'nginx' ? ['-v'] : ['version'], { timeoutMs: 1_500 }),
  })));
  const detected = results.find(({ result }) => result.ok);
  if (!detected) {
    return {
      ...base,
      state: 'waiting-external',
      automation: 'manual',
      summary: 'A reverse proxy is declared, but Caddy, Traefik, or Nginx was not detected.',
      nextStep: 'Install the selected reverse proxy or set the declaration command to an available provider.',
      checks: [...base.checks, {
        id: 'reverse-proxy-command',
        label: 'Reverse proxy runtime',
        status: 'missing',
        detail: 'No supported reverse proxy command responded successfully.',
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

export async function buildExtensionLifecycles(
  extensions: WorkspaceExtension[],
  commandRunner: CommandRunner = runCommand,
  services: ServiceDefinition[] = [],
): Promise<ExtensionLifecycleRecord[]> {
  const claimedDeclarations = new Set<string>();
  const records = await Promise.all(CAPABILITY_CATALOG.map(async (spec) => {
    const extension = extensions.find((candidate) => candidate.kind === spec.kind);
    if (!extension) return availableRecord(spec);
    claimedDeclarations.add(extension.id);
    if (spec.kind === 'network-edge') return privateEdgeRecord(spec, extension, commandRunner, services);
    if (spec.kind === 'reverse-proxy') return reverseProxyRecord(spec, extension, commandRunner);
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
