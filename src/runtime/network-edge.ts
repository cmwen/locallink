import type { ServiceDefinition, WorkspaceExtension } from '../shared/contracts';
import type { CommandRunner } from '../shared/utils';

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
