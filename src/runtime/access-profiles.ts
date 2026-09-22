import {
  SERVICE_ACCESS_PROFILES,
  type ServiceAccessEndpointAdapter,
  type ServiceAccessProfile,
  type ServiceDefinition,
} from '../shared/contracts';

/** The only access profiles understood by the planner. */
export const ACCESS_PROFILES = SERVICE_ACCESS_PROFILES;

export type AccessProfile = ServiceAccessProfile;
export type AccessAdapter = ServiceAccessEndpointAdapter | 'tailscale-caddy';
export type AccessProtocol = 'http' | 'https';
export type AccessDiagnosticStatus = 'ok' | 'warning' | 'error';
export type AccessDiagnosticOwner = 'locallink' | 'service' | 'external' | 'user';

export const DEFAULT_MDNS_SERVICE_TYPE = '_locallink._tcp';

/**
 * The service portion is deliberately structural so callers can pass a
 * ServiceDefinition directly without changing the existing contracts.
 */
export type AccessServiceInfo = Pick<ServiceDefinition, 'id' | 'name' | 'runtimeName' | 'runtime' | 'port'> & {
  /** The host/port on which the application can be reached by its adapter. */
  upstreamHost?: string;
  upstreamProtocol?: AccessProtocol;
  /** The application's bind address, when known. */
  listenHost?: string;
  /** Explicitly declares that the application is not reachable from the LAN. */
  loopbackOnly?: boolean;
  /** Explicitly declares that a direct LAN listener is reachable. */
  lanReachable?: boolean;
};

/** Facts discovered by the caller. The planner never probes or mutates them. */
export interface AccessRuntimeInfo {
  tailscaleAvailable?: boolean;
  caddyAvailable?: boolean;
  customDnsConfigured?: boolean;
  mdnsAvailable?: boolean;
  tailscaleHostname?: string;
}

export interface AccessProfileDeclaration {
  id?: string;
  profile: AccessProfile | string;
  adapter?: AccessAdapter | string;
  hostname?: string;
  /** Overrides the service port for this endpoint. */
  port?: string | number;
  protocol?: AccessProtocol | string;
  path?: string;
  listenerPort?: string | number;
  instanceName?: string;
  serviceType?: string;
  /** SRV target for DNS-SD. It is optional when the actual host is unknown. */
  targetHost?: string;
  txt?: Record<string, string | number | boolean>;
}

export interface AccessProfilePlannerInput {
  service: AccessServiceInfo;
  declarations: readonly AccessProfileDeclaration[];
  runtime?: AccessRuntimeInfo;
}

export interface AccessPrerequisiteDiagnostic {
  id: string;
  label: string;
  status: AccessDiagnosticStatus;
  owner: AccessDiagnosticOwner;
  required: boolean;
  blocking: boolean;
  detail: string;
}

export interface AccessUpstreamIntent {
  host: string;
  port: number;
  protocol: AccessProtocol;
  path: string;
}

export interface AccessRouteIntent {
  adapter: AccessAdapter;
  hostname: string;
  protocol: AccessProtocol;
  path: string;
  upstream: AccessUpstreamIntent;
  /** True only when this profile needs Caddy to own the route. */
  caddyRequired: boolean;
  /** True when the route is intended for Tailscale Serve. */
  tailscaleServe: boolean;
}

export interface AccessListenerIntent {
  adapter: AccessAdapter;
  hostname: string;
  protocol: AccessProtocol;
  port: number;
  /** A semantic bind target; no socket is opened by this module. */
  bind: 'tailscale' | 'lan' | 'caddy' | 'service';
  /** The source of ownership for a future generated listener. */
  owner: 'tailscale' | 'caddy' | 'service';
}

export interface MdnsDiscoveryIntent {
  kind: 'mdns-dns-sd';
  hostname: string;
  serviceType: string;
  instanceName: string;
  targetHost?: string;
  port: number;
  protocol: AccessProtocol;
  path: string;
  txt: Record<string, string>;
}

export interface TailscaleDiscoveryIntent {
  kind: 'tailscale-dns';
  hostname: string;
  mechanism: 'tailscale-serve';
}

export interface CustomDomainDiscoveryIntent {
  kind: 'custom-dns';
  hostname: string;
  mechanism: 'external-dns';
  /** DNS changes are deliberately outside this planner's side-effect boundary. */
  externalPrerequisite: 'dns-record';
}

export type AccessDiscoveryIntent =
  | MdnsDiscoveryIntent
  | TailscaleDiscoveryIntent
  | CustomDomainDiscoveryIntent;

export interface NormalizedAccessProfileDeclaration {
  id: string;
  profile: AccessProfile;
  adapter: AccessAdapter;
  hostname: string;
  port: number;
  protocol: AccessProtocol;
  path: string;
  listenerPort: number;
  instanceName?: string;
  serviceType?: string;
  targetHost?: string;
  txt: Record<string, string>;
}

export interface AccessProfilePlan {
  declarationId: string;
  profile?: AccessProfile;
  normalized?: NormalizedAccessProfileDeclaration;
  prerequisites: AccessPrerequisiteDiagnostic[];
  route?: AccessRouteIntent;
  listener?: AccessListenerIntent;
  discovery?: AccessDiscoveryIntent;
  ready: boolean;
  /** Always `none`: applying these intents is owned by another module. */
  sideEffects: 'none';
}

export interface AccessProfilePlanResult {
  service: {
    id: string;
    name: string;
    upstreamHost: string;
    port?: number;
  };
  profiles: AccessProfilePlan[];
  diagnostics: AccessPrerequisiteDiagnostic[];
  ready: boolean;
  sideEffects: 'none';
}

const FQDN_LABEL = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/;
const PROFILE_SET = new Set<string>(ACCESS_PROFILES);

function diagnostic(
  id: string,
  label: string,
  status: AccessDiagnosticStatus,
  owner: AccessDiagnosticOwner,
  detail: string,
  required = true,
  blocking = status === 'error',
): AccessPrerequisiteDiagnostic {
  return { id, label, status, owner, required, blocking, detail };
}

function normalizeText(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined;
  const result = value.trim();
  return result || undefined;
}

function normalizeHostname(value: unknown): string | undefined {
  const hostname = normalizeText(value)?.replace(/\.$/, '').toLowerCase();
  return hostname || undefined;
}

function validHostname(hostname: string): boolean {
  return hostname.length <= 253
    && hostname.split('.').every((label) => FQDN_LABEL.test(label));
}

function isLoopbackHost(host: string | undefined): boolean {
  const normalized = host?.trim().toLowerCase();
  return normalized === 'localhost'
    || normalized === '::1'
    || normalized === '0:0:0:0:0:0:0:1'
    || normalized === '127.0.0.1'
    || Boolean(normalized?.startsWith('127.'));
}

function parsePort(value: unknown): number | undefined {
  if (typeof value === 'number' && Number.isInteger(value)) {
    return value >= 1 && value <= 65535 ? value : undefined;
  }
  if (typeof value !== 'string' || !/^\d+$/.test(value.trim())) return undefined;
  const port = Number(value.trim());
  return port >= 1 && port <= 65535 ? port : undefined;
}

function normalizePath(value: unknown): string {
  const path = normalizeText(value) || '/';
  return path.startsWith('/') ? path : `/${path}`;
}

function normalizeProtocol(value: unknown, fallback: AccessProtocol): AccessProtocol | undefined {
  const protocol = normalizeText(value)?.toLowerCase();
  if (!protocol) return fallback;
  return protocol === 'http' || protocol === 'https' ? protocol : undefined;
}

function normalizeTxt(input: AccessProfileDeclaration['txt']): Record<string, string> {
  if (!input) return {};
  return Object.fromEntries(
    Object.entries(input)
      .filter(([key, value]) => FQDN_LABEL.test(key) && value !== undefined && value !== null)
      .map(([key, value]) => [key, String(value)]),
  );
}

function profileHostnameValid(profile: AccessProfile, hostname: string): boolean {
  if (profile === 'tailscale') {
    const labels = hostname.split('.');
    return labels.length === 4 && labels[2] === 'ts' && labels[3] === 'net' && validHostname(hostname);
  }
  if (profile === 'tailscale-custom-domain') {
    return hostname.split('.').length >= 2
      && validHostname(hostname)
      && !hostname.endsWith('.local')
      && !hostname.endsWith('.ts.net');
  }
  return hostname.endsWith('.local')
    && hostname.split('.').length === 2
    && validHostname(hostname);
}

function expectedAdapter(
  profile: AccessProfile,
  service: AccessServiceInfo,
  explicit: string | undefined,
): AccessAdapter | undefined {
  if (profile === 'tailscale') return (explicit || 'tailscale-serve') as AccessAdapter;
  if (profile === 'tailscale-custom-domain') return (explicit || 'caddy') as AccessAdapter;
  if (explicit) return explicit as AccessAdapter;
  return service.loopbackOnly === true || isLoopbackHost(service.listenHost) ? 'caddy' : 'direct';
}

function addAvailabilityDiagnostic(
  diagnostics: AccessPrerequisiteDiagnostic[],
  id: string,
  label: string,
  available: boolean | undefined,
  owner: AccessDiagnosticOwner,
  detail: string,
): void {
  if (available === true) {
    diagnostics.push(diagnostic(id, label, 'ok', owner, `${label} is available.`));
  } else if (available === false) {
    diagnostics.push(diagnostic(id, label, 'error', owner, detail));
  } else {
    diagnostics.push(diagnostic(
      id,
      label,
      'warning',
      owner,
      `${label} availability was not provided; verify it before applying this plan. ${detail}`,
      true,
      true,
    ));
  }
}

function makePlan(
  service: AccessServiceInfo,
  declaration: AccessProfileDeclaration,
  runtime: AccessRuntimeInfo,
): AccessProfilePlan {
  const declarationId = normalizeText(declaration.id) || `${service.id}-${String(declaration.profile).trim() || 'profile'}`;
  const prerequisites: AccessPrerequisiteDiagnostic[] = [];
  const profileValue = normalizeText(declaration.profile)?.toLowerCase();
  if (!profileValue || !PROFILE_SET.has(profileValue)) {
    prerequisites.push(diagnostic(
      'profile',
      'Supported access profile',
      'error',
      'user',
      `Unknown profile ${JSON.stringify(declaration.profile)}. Choose tailscale, tailscale-custom-domain, or lan-mdns.`,
    ));
    return { declarationId, prerequisites, ready: false, sideEffects: 'none' };
  }

  const profile = profileValue as AccessProfile;
  const servicePort = parsePort(declaration.port ?? service.port);
  if (!servicePort) {
    prerequisites.push(diagnostic(
      'service-port',
      'Usable service port',
      'error',
      'service',
      `Service ${service.id} must provide a TCP port from 1 to 65535.`,
    ));
  }

  const hostname = normalizeHostname(declaration.hostname
    ?? (profile === 'lan-mdns' ? `${service.id}.local` : profile === 'tailscale' ? runtime.tailscaleHostname : undefined));
  if (!hostname) {
    prerequisites.push(diagnostic(
      'hostname',
      'Profile hostname',
      'error',
      'user',
      `${profile} requires an explicit hostname${profile === 'lan-mdns' ? ' or a valid service id for <host>.local' : ''}.`,
    ));
  } else if (!profileHostnameValid(profile, hostname)) {
    const pattern = profile === 'tailscale'
      ? 'machine.tailnet.ts.net'
      : profile === 'tailscale-custom-domain'
        ? 'service.example.com'
        : '<host>.local';
    prerequisites.push(diagnostic('hostname', 'Profile hostname', 'error', 'user', `${hostname} does not match ${pattern}.`));
  }

  const adapterValue = normalizeText(declaration.adapter)?.toLowerCase();
  const adapter = expectedAdapter(profile, service, adapterValue);
  if (!adapter || !['tailscale-serve', 'tailscale-caddy', 'caddy', 'direct'].includes(adapter)) {
    prerequisites.push(diagnostic('adapter', 'Profile adapter', 'error', 'user', `Unsupported adapter ${JSON.stringify(declaration.adapter)}.`));
  }

  const profileAdapter = adapter as AccessAdapter | undefined;
  if (profile === 'tailscale' && profileAdapter !== 'tailscale-serve' && profileAdapter !== 'tailscale-caddy') {
    prerequisites.push(diagnostic('adapter', 'Tailscale adapter', 'error', 'user', 'The tailscale profile uses tailscale-serve directly or tailscale-caddy when a Caddy compatibility proxy is needed.'));
  }
  if (profile === 'tailscale-custom-domain' && profileAdapter !== 'caddy') {
    prerequisites.push(diagnostic('adapter', 'Custom-domain adapter', 'error', 'user', 'The tailscale-custom-domain profile requires the caddy adapter.'));
  }
  if (profile === 'lan-mdns' && profileAdapter !== 'direct' && profileAdapter !== 'caddy') {
    prerequisites.push(diagnostic('adapter', 'LAN discovery adapter', 'error', 'user', 'The lan-mdns profile supports only direct or caddy.'));
  }

  if (profile === 'tailscale') {
    addAvailabilityDiagnostic(
      prerequisites,
      'tailscale-runtime',
      'Tailscale',
      runtime.tailscaleAvailable,
      'locallink',
      'Start or enable Tailscale before publishing the tailscale-serve listener.',
    );
  }
  if (profileAdapter === 'caddy' || profileAdapter === 'tailscale-caddy') {
    addAvailabilityDiagnostic(
      prerequisites,
      'caddy-runtime',
      'Caddy',
      runtime.caddyAvailable,
      'locallink',
      'Caddy must be running and owned by the shared configuration manager before applying this listener.',
    );
  }
  if (profile === 'tailscale-custom-domain') {
    if (runtime.customDnsConfigured === true) {
      prerequisites.push(diagnostic('custom-dns', 'Custom DNS record', 'ok', 'external', 'The caller reports that the custom DNS prerequisite is configured.'));
    } else if (runtime.customDnsConfigured === false) {
      prerequisites.push(diagnostic('custom-dns', 'Custom DNS record', 'error', 'external', 'Create the custom DNS record outside LocalLink before publishing the Caddy route.'));
    } else {
      prerequisites.push(diagnostic('custom-dns', 'Custom DNS record', 'warning', 'external', 'Create or verify the custom DNS record outside LocalLink before publishing the Caddy route.', true, true));
    }
  }
  if (profile === 'lan-mdns' && runtime.mdnsAvailable === false) {
    prerequisites.push(diagnostic('mdns-runtime', 'mDNS socket', 'error', 'locallink', 'The host cannot currently provide the multicast DNS socket needed for DNS-SD.'));
  } else if (profile === 'lan-mdns' && runtime.mdnsAvailable === undefined) {
    prerequisites.push(diagnostic('mdns-runtime', 'mDNS socket', 'warning', 'locallink', 'mDNS availability was not provided; verify multicast access before starting the advertiser.', true, false));
  } else if (profile === 'lan-mdns') {
    prerequisites.push(diagnostic('mdns-runtime', 'mDNS socket', 'ok', 'locallink', 'The caller reports that mDNS is available.'));
  }

  const loopbackOnly = service.loopbackOnly === true || isLoopbackHost(service.listenHost);
  if (profile === 'lan-mdns' && profileAdapter === 'direct' && (loopbackOnly || service.lanReachable === false)) {
    prerequisites.push(diagnostic('lan-listener', 'LAN-reachable service listener', 'error', 'service', 'The direct LAN adapter cannot expose a loopback-only service. Use the caddy adapter or bind the service to a LAN-reachable address.'));
  }

  const protocol = normalizeProtocol(
    declaration.protocol,
    profile === 'lan-mdns' ? 'http' : 'https',
  );
  if (!protocol) prerequisites.push(diagnostic('protocol', 'Endpoint protocol', 'error', 'user', 'Protocol must be http or https.'));

  const path = normalizePath(declaration.path);
  const listenerPort = parsePort(declaration.listenerPort)
    || (profile === 'tailscale' || profile === 'tailscale-custom-domain' ? 443 : profileAdapter === 'caddy' ? 80 : servicePort || 0);
  if (!listenerPort) prerequisites.push(diagnostic('listener-port', 'Listener port', 'error', 'user', 'Listener port must be between 1 and 65535.'));

  const serviceType = normalizeText(declaration.serviceType) || DEFAULT_MDNS_SERVICE_TYPE;
  if (profile === 'lan-mdns' && !/^_[a-z0-9-]+\._(tcp|udp)$/.test(serviceType)) {
    prerequisites.push(diagnostic('service-type', 'DNS-SD service type', 'error', 'user', 'DNS-SD serviceType must look like _service._tcp or _service._udp.'));
  }

  const instanceName = normalizeText(declaration.instanceName) || service.name;
  const targetHost = normalizeHostname(declaration.targetHost ?? (profileAdapter === 'direct' ? service.listenHost : undefined));
  const txt = normalizeTxt(declaration.txt);
  if (profile === 'lan-mdns') {
    txt.id ??= service.id;
    txt.profile ??= profile;
    txt.path ??= path;
    txt.protocol ??= protocol || 'http';
  }

  const ready = prerequisites.every((item) => !item.blocking);
  // Keep structurally valid intents available even when an external or
  // runtime prerequisite is pending. Consumers can show the plan and its
  // blocking diagnostics without guessing what would be applied later.
  if (!hostname || !servicePort || !profileAdapter || !protocol || !listenerPort) {
    return { declarationId, profile, prerequisites, ready: false, sideEffects: 'none' };
  }

  const normalized: NormalizedAccessProfileDeclaration = {
    id: declarationId,
    profile,
    adapter: profileAdapter,
    hostname,
    port: servicePort,
    protocol,
    path,
    listenerPort,
    ...(profile === 'lan-mdns' ? { instanceName, serviceType, targetHost } : {}),
    txt,
  };
  const upstream: AccessUpstreamIntent = {
    host: normalizeText(service.upstreamHost) || '127.0.0.1',
    port: servicePort,
    protocol: service.upstreamProtocol === 'https' ? 'https' : 'http',
    path,
  };
  const route: AccessRouteIntent = {
    adapter: profileAdapter,
    hostname,
    protocol,
    path,
    upstream,
    caddyRequired: profileAdapter === 'caddy' || profileAdapter === 'tailscale-caddy',
    tailscaleServe: profileAdapter === 'tailscale-serve' || profileAdapter === 'tailscale-caddy',
  };
  const listener: AccessListenerIntent = {
    adapter: profileAdapter,
    hostname,
    protocol,
    port: listenerPort,
    bind: profileAdapter === 'tailscale-serve' || profileAdapter === 'tailscale-caddy' ? 'tailscale' : profileAdapter === 'caddy' ? 'caddy' : 'lan',
    owner: profileAdapter === 'tailscale-serve' ? 'tailscale' : profileAdapter === 'caddy' || profileAdapter === 'tailscale-caddy' ? 'caddy' : 'service',
  };
  const discovery: AccessDiscoveryIntent = profile === 'tailscale'
    ? { kind: 'tailscale-dns', hostname, mechanism: 'tailscale-serve' }
    : profile === 'tailscale-custom-domain'
      ? { kind: 'custom-dns', hostname, mechanism: 'external-dns', externalPrerequisite: 'dns-record' }
      : {
          kind: 'mdns-dns-sd',
          hostname,
          serviceType,
          instanceName,
          ...(targetHost ? { targetHost } : {}),
          port: listenerPort,
          protocol,
          path,
          txt,
        };

  return { declarationId, profile, normalized, prerequisites, route, listener, discovery, ready, sideEffects: 'none' };
}

/**
 * Build side-effect-free route, listener, and discovery intents for all
 * declarations belonging to one service.
 */
export function planAccessProfiles(input: AccessProfilePlannerInput): AccessProfilePlanResult {
  const runtime = input.runtime || {};
  const servicePort = parsePort(input.service.port);
  const profiles = input.declarations.map((declaration) => makePlan(input.service, declaration, runtime));
  const diagnostics = profiles.flatMap((profile) => profile.prerequisites);
  return {
    service: {
      id: input.service.id,
      name: input.service.name,
      upstreamHost: normalizeText(input.service.upstreamHost) || '127.0.0.1',
      ...(servicePort ? { port: servicePort } : {}),
    },
    profiles,
    diagnostics,
    ready: profiles.length > 0 && profiles.every((profile) => profile.ready),
    sideEffects: 'none',
  };
}

/** Convenience form for callers planning one endpoint declaration. */
export function planAccessProfile(
  service: AccessServiceInfo,
  declaration: AccessProfileDeclaration,
  runtime?: AccessRuntimeInfo,
): AccessProfilePlan {
  return planAccessProfiles({ service, declarations: [declaration], runtime }).profiles[0];
}

function caddyRouteBlock(plan: AccessProfilePlan): string | undefined {
  if (!plan.normalized || !plan.route?.caddyRequired) return undefined;
  const address = plan.profile === 'lan-mdns'
    ? `http://${plan.normalized.hostname}:${plan.normalized.listenerPort}`
    : plan.normalized.hostname;
  return [
    `${address} {`,
    ...(plan.profile === 'lan-mdns' ? ['  bind 0.0.0.0'] : []),
    `  reverse_proxy ${plan.route.upstream.protocol}://${plan.route.upstream.host}:${plan.route.upstream.port}`,
    '}',
  ].join('\n');
}

/** Render sections that the single Caddy writer can merge independently by marker. */
export function renderAccessProfileCaddyfile(plans: readonly AccessProfilePlan[]): string {
  const blocksFor = (profile: AccessProfile) => plans
    .filter((plan) => plan.profile === profile)
    .flatMap((plan) => {
      const block = caddyRouteBlock(plan);
      return block ? [block] : [];
    });
  const custom = blocksFor('tailscale-custom-domain');
  const lan = blocksFor('lan-mdns');
  return [
    '# BEGIN LOCALLINK MANAGED CUSTOM DOMAIN ROUTES',
    ...custom,
    '# END LOCALLINK MANAGED CUSTOM DOMAIN ROUTES',
    '',
    '# BEGIN LOCALLINK MANAGED LAN MDNS ROUTES',
    ...lan,
    '# END LOCALLINK MANAGED LAN MDNS ROUTES',
    '',
  ].join('\n');
}
