import { createHash } from 'node:crypto';

import type { PrivateEdgeRouteOwnership, ServiceDefinition, WorkspaceExtension } from '../shared/contracts';
import { AppError } from '../shared/errors';
import type { CommandRunner } from '../shared/utils';
import { caddyValidationCommand, detectCaddyRuntime } from './caddy-runtime';

interface TailscaleWebHandler {
  Proxy?: string;
}

interface TailscaleWebServer {
  Handlers?: Record<string, TailscaleWebHandler>;
}

interface TailscaleTcpHandler {
  HTTP?: boolean;
  HTTPS?: boolean;
}

interface TailscaleServeConfig {
  TCP?: Record<string, TailscaleTcpHandler>;
  Web?: Record<string, TailscaleWebServer>;
  Services?: Record<string, TailscaleServeConfig>;
  Foreground?: Record<string, TailscaleServeConfig>;
}

export interface NetworkEdgeRoute {
  url: string;
  targetPort: string;
}

export interface PrivateEdgeRouteCommand {
  command: string;
  args: string[];
}

export interface PrivateEdgePlannedRoute {
  serviceId: string;
  serviceName: string;
  targetPort: string;
  proxyPort?: string;
  httpsPort: string;
  url?: string;
  status: 'active' | 'missing' | 'conflict';
  detail: string;
  apply: PrivateEdgeRouteCommand;
  rollback: PrivateEdgeRouteCommand;
}

export interface PrivateEdgeRoutePlan {
  adapter: string;
  state: 'waiting-tailscale' | 'waiting-adapter' | 'waiting-selection' | 'blocked-runtime' | 'ready' | 'in-sync' | 'conflict';
  summary: string;
  mutatesHost: false;
  requiresConfirmation: true;
  applySupported: boolean;
  confirmationToken?: string;
  prerequisites: Array<{
    id: string;
    label: string;
    status: 'available' | 'missing' | 'blocked';
    detail: string;
  }>;
  generatedFiles: Array<{
    path: string;
    content: string;
    validate: PrivateEdgeRouteCommand;
  }>;
  routes: PrivateEdgePlannedRoute[];
  runtime?: {
    source: 'docker-compose' | 'host-cli' | 'missing';
    running: boolean;
    manageable: boolean;
    serviceName?: string;
    configPath?: string;
    configTarget?: string;
  };
}

export interface PrivateEdgeRemovalPlanItem extends PrivateEdgeRouteOwnership {
  liveStatus: 'active' | 'absent' | 'changed';
  action: 'remove' | 'forget';
  detail: string;
}

export interface PrivateEdgeRemovalPlan {
  adapter: string;
  state: 'clean' | 'ready' | 'waiting-tailscale' | 'blocked-runtime';
  summary: string;
  requiresConfirmation: true;
  confirmationToken?: string;
  removals: PrivateEdgeRemovalPlanItem[];
}

interface TailscaleStatus {
  BackendState?: string;
  Self?: { DNSName?: string };
}

function normalizeConfiguredEdgeUrl(value: string | undefined): string | undefined {
  if (!value) return undefined;

  try {
    const url = new URL(value);
    if (url.protocol !== 'https:' || url.username || url.password || url.search || url.hash) return undefined;
    if (url.hostname === 'localhost' || url.hostname.endsWith('.example') || url.hostname.endsWith('.example.com') || url.hostname.includes('example-tailnet')) return undefined;
    return url.toString().replace(/\/$/, '');
  } catch {
    return undefined;
  }
}

function proxyTargetPort(proxy: string | undefined): string | undefined {
  if (!proxy) return undefined;

  try {
    const normalized = proxy.replace(/^https\+insecure:/, 'https:');
    const url = new URL(normalized);
    if (url.port) return url.port;
    if (url.protocol === 'https:') return '443';
    if (url.protocol === 'http:') return '80';
  } catch {
    return undefined;
  }

  return undefined;
}

function publicRouteUrl(hostPort: string, mountPoint: string, tcp: TailscaleServeConfig['TCP']): string | undefined {
  const separator = hostPort.lastIndexOf(':');
  const exposedPort = separator >= 0 ? hostPort.slice(separator + 1) : '';
  const tcpHandler = exposedPort ? tcp?.[exposedPort] : undefined;
  const protocol = tcpHandler?.HTTPS ? 'https:' : tcpHandler?.HTTP ? 'http:' : exposedPort === '443' ? 'https:' : 'http:';

  try {
    const url = new URL(`${protocol}//${hostPort}`);
    if (mountPoint && mountPoint !== '/') {
      url.pathname = mountPoint.startsWith('/') ? mountPoint : `/${mountPoint}`;
    }
    return url.toString();
  } catch {
    return undefined;
  }
}

function collectRoutes(config: TailscaleServeConfig, routes: NetworkEdgeRoute[]): void {
  for (const [hostPort, server] of Object.entries(config.Web || {})) {
    for (const [mountPoint, handler] of Object.entries(server.Handlers || {})) {
      const targetPort = proxyTargetPort(handler.Proxy);
      const url = publicRouteUrl(hostPort, mountPoint, config.TCP);
      if (targetPort && url) routes.push({ url, targetPort });
    }
  }

  for (const service of Object.values(config.Services || {})) collectRoutes(service, routes);
  for (const foreground of Object.values(config.Foreground || {})) collectRoutes(foreground, routes);
}

function parseTailscaleNodeServeRoutes(raw: string): NetworkEdgeRoute[] {
  try {
    const config = JSON.parse(raw) as TailscaleServeConfig;
    const nodeConfig = { ...config, Services: undefined };
    const routes: NetworkEdgeRoute[] = [];
    collectRoutes(nodeConfig, routes);
    return routes.filter((route, index) => routes.findIndex((candidate) => candidate.url === route.url && candidate.targetPort === route.targetPort) === index);
  } catch {
    return [];
  }
}

export function parseTailscaleServeRoutes(raw: string): NetworkEdgeRoute[] {
  try {
    const config = JSON.parse(raw) as TailscaleServeConfig;
    const routes: NetworkEdgeRoute[] = [];
    collectRoutes(config, routes);
    return routes.filter((route, index) => routes.findIndex((candidate) => candidate.url === route.url && candidate.targetPort === route.targetPort) === index);
  } catch {
    return [];
  }
}

function parseTailscaleStatus(raw: string): TailscaleStatus | undefined {
  try {
    return JSON.parse(raw) as TailscaleStatus;
  } catch {
    return undefined;
  }
}

function listenerPort(route: NetworkEdgeRoute): string | undefined {
  try {
    const url = new URL(route.url);
    if (url.protocol !== 'https:' || (url.pathname && url.pathname !== '/')) return undefined;
    return url.port || '443';
  } catch {
    return undefined;
  }
}

function configuredHttpsPortStart(configuredStart?: string): number | undefined {
  const configured = Number(configuredStart);
  if (Number.isInteger(configured) && configured >= 1024 && configured <= 65500) return configured;
  return undefined;
}

function generatedHttpsPort(workspaceId: string, serviceId: string): number {
  const hash = createHash('sha256').update(`${workspaceId}\0${serviceId}`).digest().readUInt32BE(0);
  return 10000 + (hash % 50000);
}

function routeUrl(hostname: string | undefined, httpsPort: string): string | undefined {
  if (!hostname) return undefined;
  return `https://${hostname}${httpsPort === '443' ? '' : `:${httpsPort}`}`;
}

export async function planPrivateEdgeRoutes(
  workspaceId: string,
  services: Array<{ id: string; name: string; port: string }>,
  command: string,
  commandRunner: CommandRunner,
  configuredPortStart?: string,
): Promise<PrivateEdgeRoutePlan> {
  if (services.length === 0) {
    return {
      adapter: 'tailscale-serve',
      state: 'waiting-selection',
      summary: 'Select at least one workspace service before generating Tailscale Serve routes.',
      mutatesHost: false,
      requiresConfirmation: true,
      applySupported: true,
      prerequisites: [],
      generatedFiles: [],
      routes: [],
    };
  }

  const statusResult = await commandRunner(command, ['status', '--json'], { timeoutMs: 2_000 });
  const status = statusResult.ok ? parseTailscaleStatus(statusResult.stdout) : undefined;
  const connected = statusResult.ok && (!status?.BackendState || status.BackendState.toLowerCase() === 'running');
  if (!connected) {
    return {
      adapter: 'tailscale-serve',
      state: 'waiting-tailscale',
      summary: 'Tailscale must be installed and connected before LocalLink can calculate live route conflicts.',
      mutatesHost: false,
      requiresConfirmation: true,
      applySupported: true,
      prerequisites: [{ id: 'tailscale', label: 'Tailscale', status: 'missing', detail: 'Tailscale is not connected.' }],
      generatedFiles: [],
      routes: [],
    };
  }

  const serveResult = await commandRunner(command, ['serve', 'status', '--json'], { timeoutMs: 2_000 });
  const currentRoutes = serveResult.ok ? parseTailscaleNodeServeRoutes(serveResult.stdout) : [];
  const routesByListener = new Map<string, NetworkEdgeRoute[]>();
  for (const route of currentRoutes) {
    const port = listenerPort(route);
    if (!port) continue;
    routesByListener.set(port, [...(routesByListener.get(port) || []), route]);
  }

  const hostname = status?.Self?.DNSName?.replace(/\.$/, '')
    || currentRoutes.map((route) => {
      try { return new URL(route.url).hostname; } catch { return undefined; }
    }).find(Boolean);
  const configuredStart = configuredHttpsPortStart(configuredPortStart);
  const ordered = [...services].sort((left, right) => left.id.localeCompare(right.id));
  const generatedPorts = new Set<number>();
  const routes = ordered.map((service, index): PrivateEdgePlannedRoute => {
    let numericPort = configuredStart === undefined ? generatedHttpsPort(workspaceId, service.id) : configuredStart + index;
    if (numericPort > 65535) numericPort = 1024 + (numericPort - 65536);
    while (generatedPorts.has(numericPort)) numericPort = numericPort === 65535 ? 1024 : numericPort + 1;
    generatedPorts.add(numericPort);
    const httpsPort = String(numericPort);
    const occupants = routesByListener.get(httpsPort) || [];
    const active = occupants.some((route) => route.targetPort === service.port);
    const conflict = !active && occupants.length > 0;
    const apply = { command, args: ['serve', '--bg', '--yes', `--https=${httpsPort}`, `http://127.0.0.1:${service.port}`] };
    const rollback = { command, args: ['serve', '--yes', `--https=${httpsPort}`, 'off'] };
    return {
      serviceId: service.id,
      serviceName: service.name,
      targetPort: service.port,
      httpsPort,
      url: routeUrl(hostname, httpsPort),
      status: active ? 'active' : conflict ? 'conflict' : 'missing',
      detail: active
        ? 'The generated listener already targets this workspace service.'
        : conflict
          ? `HTTPS port ${httpsPort} is already owned by another Tailscale Serve route.`
          : 'This listener can be added without replacing an observed root Serve route.',
      apply,
      rollback,
    };
  });

  const conflicts = routes.filter((route) => route.status === 'conflict').length;
  const missing = routes.filter((route) => route.status === 'missing').length;
  const confirmationToken = conflicts === 0 && missing > 0
    ? `private-edge:${createHash('sha256').update(JSON.stringify({ adapter: 'tailscale-serve', workspaceId, routes: routes.map((route) => route.apply) })).digest('hex')}`
    : undefined;
  return {
    adapter: 'tailscale-serve',
    state: conflicts > 0 ? 'conflict' : missing > 0 ? 'ready' : 'in-sync',
    summary: conflicts > 0
      ? `${conflicts} generated HTTPS listener${conflicts === 1 ? '' : 's'} conflict with existing Tailscale Serve configuration.`
      : missing > 0
        ? `${missing} reversible Tailscale Serve route${missing === 1 ? '' : 's'} can be applied after review.`
        : 'Every generated workspace route is already active.',
    mutatesHost: false,
    requiresConfirmation: true,
    applySupported: true,
    prerequisites: [{ id: 'tailscale', label: 'Tailscale', status: 'available', detail: 'Tailscale is connected.' }],
    generatedFiles: [],
    confirmationToken,
    routes,
  };
}

export async function planPrivateEdgeRouteRemovals(
  workspaceId: string,
  ownership: PrivateEdgeRouteOwnership[],
  desiredRoutes: PrivateEdgePlannedRoute[],
  command: string,
  commandRunner: CommandRunner,
): Promise<PrivateEdgeRemovalPlan> {
  const staleOwnership = ownership.filter((owned) => owned.adapter === 'tailscale-serve').filter((owned) => {
    const desired = desiredRoutes.find((candidate) => (
      candidate.serviceId === owned.serviceId
      && candidate.targetPort === owned.targetPort
      && candidate.httpsPort === owned.httpsPort
    ));
    return !desired || desired.status === 'conflict';
  });
  if (staleOwnership.length === 0) {
    return {
      adapter: 'tailscale-serve',
      state: 'clean',
      summary: 'No LocalLink-owned Private Edge routes need reconciliation.',
      requiresConfirmation: true,
      removals: [],
    };
  }

  const statusResult = await commandRunner(command, ['status', '--json'], { timeoutMs: 2_000 });
  const status = statusResult.ok ? parseTailscaleStatus(statusResult.stdout) : undefined;
  const connected = statusResult.ok && (!status?.BackendState || status.BackendState.toLowerCase() === 'running');
  if (!connected) {
    return {
      adapter: 'tailscale-serve',
      state: 'waiting-tailscale',
      summary: 'Tailscale must be connected before LocalLink can safely reconcile owned routes.',
      requiresConfirmation: true,
      removals: [],
    };
  }

  const serveResult = await commandRunner(command, ['serve', 'status', '--json'], { timeoutMs: 2_000 });
  const currentRoutes = serveResult.ok ? parseTailscaleNodeServeRoutes(serveResult.stdout) : [];
  const removals = staleOwnership.map((owned): PrivateEdgeRemovalPlanItem => {
    const listeners = currentRoutes.filter((route) => listenerPort(route) === owned.httpsPort);
    const active = listeners.some((route) => route.targetPort === owned.targetPort);
    const changed = !active && listeners.length > 0;
    return {
      ...owned,
      liveStatus: active ? 'active' : changed ? 'changed' : 'absent',
      action: active ? 'remove' : 'forget',
      detail: active
        ? 'The listener still matches this workspace ownership record and can be removed.'
        : changed
          ? 'The listener now targets something else; LocalLink will forget its stale ownership record without changing Tailscale.'
          : 'The listener is already absent; LocalLink will remove only its stale ownership record.',
    };
  });
  const confirmationToken = `private-edge-removal:${createHash('sha256').update(JSON.stringify({
    adapter: 'tailscale-serve',
    workspaceId,
    removals: removals.map(({ serviceId, targetPort, httpsPort, liveStatus, action, rollbackArgs }) => ({
      serviceId, targetPort, httpsPort, liveStatus, action, rollbackArgs,
    })),
  })).digest('hex')}`;
  const hostRemovals = removals.filter((item) => item.action === 'remove').length;
  const ownershipCleanup = removals.length - hostRemovals;
  return {
    adapter: 'tailscale-serve',
    state: 'ready',
    summary: [
      hostRemovals > 0 ? `${hostRemovals} owned listener${hostRemovals === 1 ? '' : 's'} can be removed` : '',
      ownershipCleanup > 0 ? `${ownershipCleanup} stale ownership record${ownershipCleanup === 1 ? '' : 's'} can be forgotten without host mutation` : '',
    ].filter(Boolean).join('; ') + '.',
    requiresConfirmation: true,
    confirmationToken,
    removals,
  };
}

export interface PrivateEdgeRouteAdapter {
  id: string;
  displayName: string;
  command: string;
  planRoutes(
    workspaceId: string,
    services: Array<{ id: string; name: string; port: string }>,
    commandRunner: CommandRunner,
    configuredPortStart?: string,
    workspaceRoot?: string,
  ): Promise<PrivateEdgeRoutePlan>;
  planRemovals(
    workspaceId: string,
    ownership: PrivateEdgeRouteOwnership[],
    desiredRoutes: PrivateEdgePlannedRoute[],
    commandRunner: CommandRunner,
  ): Promise<PrivateEdgeRemovalPlan>;
}

class TailscaleServeRouteAdapter implements PrivateEdgeRouteAdapter {
  readonly id = 'tailscale-serve';

  readonly displayName = 'Tailscale Serve';

  constructor(readonly command: string) {}

  async planRoutes(
    workspaceId: string,
    services: Array<{ id: string; name: string; port: string }>,
    commandRunner: CommandRunner,
    configuredPortStart?: string,
    _workspaceRoot?: string,
  ): Promise<PrivateEdgeRoutePlan> {
    return planPrivateEdgeRoutes(workspaceId, services, this.command, commandRunner, configuredPortStart);
  }

  async planRemovals(
    workspaceId: string,
    ownership: PrivateEdgeRouteOwnership[],
    desiredRoutes: PrivateEdgePlannedRoute[],
    commandRunner: CommandRunner,
  ): Promise<PrivateEdgeRemovalPlan> {
    return planPrivateEdgeRouteRemovals(workspaceId, ownership, desiredRoutes, this.command, commandRunner);
  }
}

function generatedCaddyPort(workspaceId: string, serviceId: string): number {
  const hash = createHash('sha256').update(`${workspaceId}\0caddy-proxy\0${serviceId}`).digest().readUInt32BE(0);
  return 20000 + (hash % 38000);
}

function generatedCaddyAdminPort(workspaceId: string): number {
  const hash = createHash('sha256').update(`${workspaceId}\0caddy-admin`).digest().readUInt32BE(0);
  return 61000 + (hash % 4000);
}

function buildPrivateEdgeCaddyfile(
  workspaceId: string,
  services: Array<{ id: string; name: string; port: string }>,
  upstreamHost = '127.0.0.1',
): { content: string; proxyPorts: Map<string, string> } {
  const used = new Set<number>();
  const proxyPorts = new Map<string, string>();
  const blocks = [...services].sort((left, right) => left.id.localeCompare(right.id)).map((service) => {
    let port = generatedCaddyPort(workspaceId, service.id);
    while (used.has(port)) port = port >= 59999 ? 20000 : port + 1;
    used.add(port);
    proxyPorts.set(service.id, String(port));
    return [
      `http://127.0.0.1:${port} {`,
      '  bind 127.0.0.1',
      `  reverse_proxy http://${upstreamHost}:${service.port}`,
      '}',
    ].join('\n');
  });
  const content = [
    '{',
    `  admin 127.0.0.1:${generatedCaddyAdminPort(workspaceId)}`,
    '  auto_https off',
    '}',
    '',
    '# BEGIN LOCALLINK MANAGED PRIVATE EDGE ROUTES',
    ...blocks,
    '# END LOCALLINK MANAGED PRIVATE EDGE ROUTES',
    '',
  ].join('\n');
  return { content, proxyPorts };
}

class TailscaleCaddyRouteAdapter implements PrivateEdgeRouteAdapter {
  readonly id = 'tailscale-caddy';

  readonly displayName = 'Tailscale Serve + Caddy';

  constructor(readonly command: string, private readonly caddyCommand = 'caddy') {}

  async planRoutes(
    workspaceId: string,
    services: Array<{ id: string; name: string; port: string }>,
    commandRunner: CommandRunner,
    configuredPortStart?: string,
    workspaceRoot?: string,
  ): Promise<PrivateEdgeRoutePlan> {
    const generatedPath = '.locallink/generated/private-edge/Caddyfile';
    const caddyRuntime = await detectCaddyRuntime(workspaceRoot, commandRunner, this.caddyCommand);
    const { content, proxyPorts } = buildPrivateEdgeCaddyfile(
      workspaceId,
      services,
      caddyRuntime.source === 'docker-compose' ? 'host.docker.internal' : '127.0.0.1',
    );
    const proxyServices = services.map((service) => ({ ...service, port: proxyPorts.get(service.id)! }));
    const tailscalePlan = await planPrivateEdgeRoutes(
      workspaceId,
      proxyServices,
      this.command,
      commandRunner,
      configuredPortStart,
    );
    const routes = tailscalePlan.routes.map((route) => {
      const service = services.find((candidate) => candidate.id === route.serviceId)!;
      return { ...route, targetPort: service.port, proxyPort: route.targetPort };
    });
    const caddyAvailable = caddyRuntime.available;
    const caddyManageable = caddyRuntime.manageable;
    const confirmationToken = caddyManageable && tailscalePlan.confirmationToken
      ? `private-edge-caddy:${createHash('sha256').update(JSON.stringify({
          tailscale: tailscalePlan.confirmationToken,
          runtime: {
            serviceName: caddyRuntime.serviceName,
            configPath: caddyRuntime.configPath,
            configTarget: caddyRuntime.configTarget,
          },
          caddyfile: content,
        })).digest('hex')}`
      : undefined;
    const state = services.length === 0
      ? 'waiting-selection'
      : tailscalePlan.state === 'waiting-tailscale'
        ? 'waiting-tailscale'
        : !caddyAvailable
          ? 'waiting-adapter'
        : !caddyManageable
          ? 'blocked-runtime'
          : tailscalePlan.state;
    return {
      ...tailscalePlan,
      adapter: this.id,
      state,
      summary: services.length === 0
        ? 'Select at least one workspace service before generating the Tailscale+Caddy topology.'
        : tailscalePlan.state === 'waiting-tailscale'
          ? tailscalePlan.summary
          : !caddyAvailable
            ? 'The Tailscale+Caddy topology is generated, but Caddy is not available through this workspace or the host.'
            : !caddyManageable
              ? 'Caddy is available, but LocalLink cannot safely own its workspace Caddyfile mount or runtime yet.'
              : tailscalePlan.summary,
      applySupported: caddyManageable,
      confirmationToken,
      prerequisites: [
        ...tailscalePlan.prerequisites,
        {
          id: 'caddy',
          label: 'Caddy',
          status: caddyAvailable ? 'available' : 'missing',
          detail: caddyRuntime.detail,
        },
        {
          id: 'caddy-runtime-ownership',
          label: 'Per-workspace Caddy runtime ownership',
          status: caddyManageable ? 'available' : 'blocked',
          detail: caddyManageable
            ? `LocalLink can validate and reload ${caddyRuntime.serviceName} using ${caddyRuntime.configPath}.`
            : 'The Caddy service must be running and mount its Caddyfile from inside this workspace before LocalLink can manage it.',
        },
      ],
      generatedFiles: [{
        path: generatedPath,
        content,
        validate: caddyValidationCommand(caddyRuntime, generatedPath, this.caddyCommand),
      }],
      routes,
      runtime: {
        source: caddyRuntime.source,
        running: caddyRuntime.running,
        manageable: caddyRuntime.manageable,
        serviceName: caddyRuntime.serviceName,
        configPath: caddyRuntime.configPath,
        configTarget: caddyRuntime.configTarget,
      },
    };
  }

  async planRemovals(
    _workspaceId: string,
    ownership: PrivateEdgeRouteOwnership[],
    _desiredRoutes: PrivateEdgePlannedRoute[],
    _commandRunner: CommandRunner,
  ): Promise<PrivateEdgeRemovalPlan> {
    const owned = ownership.filter((route) => route.adapter === this.id);
    return owned.length === 0
      ? {
          adapter: this.id,
          state: 'clean',
          summary: 'No LocalLink-owned Tailscale+Caddy routes need reconciliation.',
          requiresConfirmation: true,
          removals: [],
        }
      : {
          adapter: this.id,
          state: 'blocked-runtime',
          summary: 'Tailscale+Caddy reconciliation is blocked until LocalLink owns the generated Caddy runtime.',
          requiresConfirmation: true,
          removals: [],
        };
  }
}

export function resolvePrivateEdgeRouteAdapter(adapterId: string | undefined, command = 'tailscale'): PrivateEdgeRouteAdapter {
  const normalized = adapterId?.trim().toLowerCase() || 'tailscale-serve';
  if (normalized === 'tailscale-serve') return new TailscaleServeRouteAdapter(command);
  if (normalized === 'tailscale-caddy') return new TailscaleCaddyRouteAdapter(command);
  throw new AppError(
    'UNSUPPORTED_PRIVATE_EDGE_ADAPTER',
    `Private Edge route adapter "${adapterId}" is not supported. Available adapters: tailscale-serve, tailscale-caddy.`,
    400,
  );
}

export async function discoverServiceEdgeUrls(
  extensions: WorkspaceExtension[],
  services: ServiceDefinition[],
  commandRunner: CommandRunner,
  env: Record<string, string> = {},
): Promise<Map<string, string[]>> {
  const networkEdge = extensions.find((extension) => extension.kind === 'network-edge' && extension.enabled && extension.status !== 'disabled');
  if (!networkEdge) return new Map();
  const selectedPorts = new Set(networkEdge.exposedPorts.filter((port) => Boolean(port && port !== '—')));
  if (selectedPorts.size === 0) return new Map();

  const urlsByService = new Map<string, string[]>();
  const pocketIdExtension = extensions.find((extension) => extension.kind === 'identity-provider' && extension.enabled && extension.status !== 'disabled');
  const pocketIdUrl = pocketIdExtension ? normalizeConfiguredEdgeUrl(env.POCKET_ID_APP_URL) : undefined;
  if (pocketIdExtension && pocketIdUrl) {
    const pocketIdService = services.find((service) => service.id === pocketIdExtension.id || service.runtimeName === pocketIdExtension.id);
    if (pocketIdService?.port && selectedPorts.has(pocketIdService.port)) urlsByService.set(pocketIdService.id, [pocketIdUrl]);
  }

  const result = await commandRunner(networkEdge.command || 'tailscale', ['serve', 'status', '--json'], { timeoutMs: 2_000 });
  if (!result.ok) return urlsByService;

  const routes = parseTailscaleServeRoutes(result.stdout);
  for (const service of services) {
    const port = service.port?.trim();
    if (!port || port === '—' || !selectedPorts.has(port)) continue;
    const urls = routes.filter((route) => route.targetPort === port).map((route) => route.url);
    if (urls.length > 0) urlsByService.set(service.id, [...new Set([...(urlsByService.get(service.id) || []), ...urls])]);
  }
  return urlsByService;
}
