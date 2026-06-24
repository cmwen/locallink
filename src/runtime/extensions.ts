import fs from 'node:fs/promises';
import path from 'node:path';

import { parseDocument } from 'yaml';

import type {
  ExtensionKind,
  ExtensionRecord,
  ExtensionStatus,
  ExtensionWorkspace,
  StatCard,
} from '../shared/contracts';
import {
  type CommandRunner,
  parseJsonOutput,
  runCommand,
} from '../shared/utils';

export interface ExtensionDefinition {
  id: string;
  name?: string;
  kind?: ExtensionKind;
  enabled?: boolean;
  command?: string;
  docsUrl?: string;
  requiredEnv?: string[];
  urls?: string[];
  exposedPorts?: string[];
}

interface TailscaleStatus {
  Self?: {
    DNSName?: string;
    TailscaleIPs?: string[];
  };
  MagicDNSSuffix?: string;
}

const BUILTIN_EXTENSIONS: ExtensionDefinition[] = [
  {
    id: 'dashboard',
    name: 'Dashboard',
    kind: 'dashboard',
    enabled: false,
    docsUrl: 'https://github.com/cmwen/locallink',
  },
  {
    id: 'caddy',
    name: 'Caddy Reverse Proxy',
    kind: 'reverse-proxy',
    enabled: false,
    command: 'caddy',
    docsUrl: 'https://caddyserver.com/docs/',
  },
  {
    id: 'tailscale',
    name: 'Tailscale Network Edge',
    kind: 'network-edge',
    enabled: false,
    command: 'tailscale',
    docsUrl: 'https://tailscale.com/kb',
  },
  {
    id: 'openobserve',
    name: 'OpenObserve OTEL',
    kind: 'observability',
    enabled: false,
    docsUrl: 'https://openobserve.ai/docs/',
    requiredEnv: [
      'OPENOBSERVE_ENDPOINT',
      'OPENOBSERVE_ORGANIZATION',
      'OPENOBSERVE_STREAM',
      'OPENOBSERVE_TOKEN',
    ],
  },
];

async function readFileOrEmpty(filePath: string): Promise<string> {
  try {
    return await fs.readFile(filePath, 'utf8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      return '';
    }
    throw error;
  }
}

function parseExtensionDefinitions(raw: string): ExtensionDefinition[] {
  if (!raw.trim()) {
    return [];
  }

  const document = parseDocument(raw);
  const parsed = document.toJS() as { extensions?: unknown };
  if (!Array.isArray(parsed?.extensions)) {
    return [];
  }

  return parsed.extensions
    .filter((item): item is Record<string, unknown> => !!item && typeof item === 'object')
    .map((item) => ({
      id: String(item.id ?? '').trim(),
      name: typeof item.name === 'string' ? item.name : undefined,
      kind: isExtensionKind(item.kind) ? item.kind : undefined,
      enabled: typeof item.enabled === 'boolean' ? item.enabled : undefined,
      command: typeof item.command === 'string' ? item.command : undefined,
      docsUrl: typeof item.docsUrl === 'string' ? item.docsUrl : undefined,
      requiredEnv: normalizeStringList(item.requiredEnv),
      urls: normalizeStringList(item.urls),
      exposedPorts: normalizeStringList(item.exposedPorts),
    }))
    .filter((item) => item.id);
}

function isExtensionKind(value: unknown): value is ExtensionKind {
  return (
    value === 'dashboard' ||
    value === 'reverse-proxy' ||
    value === 'network-edge' ||
    value === 'observability' ||
    value === 'custom'
  );
}

function normalizeStringList(value: unknown): string[] | undefined {
  if (!Array.isArray(value)) {
    return undefined;
  }

  const normalized = value.map((item) => String(item).trim()).filter(Boolean);
  return normalized.length > 0 ? normalized : undefined;
}

function mergeDefinitions(configured: ExtensionDefinition[]): ExtensionDefinition[] {
  const byId = new Map<string, ExtensionDefinition>();
  for (const extension of BUILTIN_EXTENSIONS) {
    byId.set(extension.id, extension);
  }
  for (const extension of configured) {
    byId.set(extension.id, {
      ...byId.get(extension.id),
      ...extension,
      enabled: extension.enabled ?? byId.get(extension.id)?.enabled ?? false,
    });
  }

  return [...byId.values()];
}

export async function loadExtensionDefinitions(root: string): Promise<ExtensionDefinition[]> {
  const configured = parseExtensionDefinitions(await readFileOrEmpty(path.join(root, 'locallink.extensions.yml')));
  return mergeDefinitions(configured);
}

function boolEnv(value: string | undefined): boolean {
  return /^(1|true|yes|on)$/i.test(value ?? '');
}

function statusLabel(status: ExtensionStatus): string {
  switch (status) {
    case 'enabled':
      return 'Enabled';
    case 'available':
      return 'Available';
    case 'needs_config':
      return 'Needs config';
    case 'missing':
      return 'Missing';
    case 'disabled':
    default:
      return 'Disabled';
  }
}

function baseRecord(definition: ExtensionDefinition, status: ExtensionStatus, detail: string): ExtensionRecord {
  return {
    id: definition.id,
    name: definition.name || definition.id,
    kind: definition.kind || 'custom',
    enabled: definition.enabled === true,
    status,
    statusLabel: statusLabel(status),
    detail,
    docsUrl: definition.docsUrl,
    command: definition.command,
    requiredEnv: definition.requiredEnv,
    urls: definition.urls,
    exposedPorts: definition.exposedPorts,
  };
}

async function commandVersion(
  commandRunner: CommandRunner,
  command: string,
  args: string[],
): Promise<string | undefined> {
  const result = await commandRunner(command, args, {
    timeoutMs: 1200,
  });
  if (!result.ok) {
    return undefined;
  }

  return (result.stdout || result.stderr).trim().split(/\r?\n/)[0]?.trim() || undefined;
}

async function readCaddyfileHints(root: string): Promise<{ urls: string[]; exposedPorts: string[] }> {
  const raw = await readFileOrEmpty(path.join(root, 'Caddyfile'));
  if (!raw.trim()) {
    return { urls: [], exposedPorts: [] };
  }

  const urls = new Set<string>();
  const exposedPorts = new Set<string>();
  for (const line of raw.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) {
      continue;
    }

    const firstToken = trimmed.split(/\s+/)[0] ?? '';
    if (/^[A-Za-z0-9*_.:-]+$/.test(firstToken) && !['reverse_proxy', 'handle', 'route'].includes(firstToken)) {
      urls.add(firstToken);
    }
    const proxyMatch = trimmed.match(/reverse_proxy\s+(?:https?:\/\/)?[^:}\s]+:(\d+)/);
    if (proxyMatch) {
      exposedPorts.add(proxyMatch[1]);
    }
  }

  return {
    urls: [...urls].slice(0, 8),
    exposedPorts: [...exposedPorts].slice(0, 8),
  };
}

async function buildDashboardExtension(definition: ExtensionDefinition, env: Record<string, string>): Promise<ExtensionRecord> {
  const enabled = definition.enabled === true || boolEnv(env.LOCALLINK_DASHBOARD_ENABLED);
  const apiPort = env.LOCALLINK_API_PORT || env.LOCALLINK_WEB_PORT || '4010';
  const dashboardPort = env.LOCALLINK_DASHBOARD_PORT || env.LOCALLINK_WEB_PORT || apiPort;
  const host = env.LOCALLINK_BIND_HOST || '127.0.0.1';
  return {
    ...baseRecord(
      { ...definition, enabled },
      enabled ? 'enabled' : 'disabled',
      enabled
        ? 'Dashboard can be launched as the optional UI surface on top of the LocalLink API.'
        : 'Dashboard is kept out of the default control-plane process. Run locallink dashboard or enable this extension.',
    ),
    urls: [`http://${host}:${dashboardPort}`],
    exposedPorts: [dashboardPort],
  };
}

async function buildCaddyExtension(
  root: string,
  definition: ExtensionDefinition,
  commandRunner: CommandRunner,
): Promise<ExtensionRecord> {
  const detectedValue = definition.command
    ? await commandVersion(commandRunner, definition.command, ['version'])
    : undefined;
  const hints = await readCaddyfileHints(root);
  const enabled = definition.enabled === true;
  const status: ExtensionStatus = enabled ? (detectedValue ? 'enabled' : 'missing') : detectedValue ? 'available' : 'disabled';
  return {
    ...baseRecord(
      { ...definition, enabled },
      status,
      enabled
        ? detectedValue
          ? 'Caddy is configured as an optional workspace extension for exported service routes.'
          : 'Caddy is enabled in the extension registry, but the caddy command was not detected.'
        : detectedValue
          ? 'Caddy is installed and can be enabled as a reverse-proxy extension.'
          : 'Caddy is optional and not enabled for this workspace.',
    ),
    detectedValue,
    urls: [...(definition.urls ?? []), ...hints.urls],
    exposedPorts: [...(definition.exposedPorts ?? []), ...hints.exposedPorts],
  };
}

async function buildTailscaleExtension(
  definition: ExtensionDefinition,
  commandRunner: CommandRunner,
): Promise<ExtensionRecord> {
  const detectedValue = definition.command
    ? await commandVersion(commandRunner, definition.command, ['version'])
    : undefined;
  const enabled = definition.enabled === true;
  let urls = definition.urls ?? [];
  let detail = enabled
    ? 'Tailscale is configured as the optional private network edge.'
    : detectedValue
      ? 'Tailscale is installed and can be enabled as a network-edge extension.'
      : 'Tailscale is optional and not enabled for this workspace.';

  if (enabled && detectedValue && definition.command) {
    const statusResult = await commandRunner(definition.command, ['status', '--json'], {
      timeoutMs: 1200,
    });
    if (statusResult.ok) {
      const [status] = parseJsonOutput<TailscaleStatus>(statusResult.stdout);
      const dnsName = status?.Self?.DNSName?.replace(/\.$/, '');
      const ips = status?.Self?.TailscaleIPs ?? [];
      urls = [...urls, ...(dnsName ? [`https://${dnsName}`] : []), ...ips.map((ip) => `http://${ip}`)];
      detail = dnsName ? `Tailscale is active on ${dnsName}.` : 'Tailscale is enabled and reachable through the local tailscale command.';
    }
  }

  const status: ExtensionStatus = enabled ? (detectedValue ? 'enabled' : 'missing') : detectedValue ? 'available' : 'disabled';
  return {
    ...baseRecord({ ...definition, enabled }, status, detail),
    detectedValue,
    urls,
  };
}

function buildOpenObserveExtension(definition: ExtensionDefinition, env: Record<string, string>): ExtensionRecord {
  const enabled = definition.enabled === true || boolEnv(env.LOCALLINK_OTEL_ENABLED);
  const requiredEnv = definition.requiredEnv ?? [];
  const missingEnv = requiredEnv.filter((key) => !env[key]);
  const status: ExtensionStatus = enabled ? (missingEnv.length > 0 ? 'needs_config' : 'enabled') : 'disabled';
  return {
    ...baseRecord(
      { ...definition, enabled },
      status,
      enabled
        ? missingEnv.length > 0
          ? 'OpenObserve OTEL is enabled, but required environment variables are missing.'
          : 'OpenObserve OTEL variables are present and can be injected into managed services.'
        : 'OpenObserve OTEL is optional. Enable it when central logs and traces are wanted.',
    ),
    missingEnv,
    requiredEnv,
    urls: env.OPENOBSERVE_ENDPOINT ? [env.OPENOBSERVE_ENDPOINT] : definition.urls,
  };
}

async function buildExtensionRecord(
  root: string,
  definition: ExtensionDefinition,
  env: Record<string, string>,
  commandRunner: CommandRunner,
): Promise<ExtensionRecord> {
  switch (definition.id) {
    case 'dashboard':
      return buildDashboardExtension(definition, env);
    case 'caddy':
      return buildCaddyExtension(root, definition, commandRunner);
    case 'tailscale':
      return buildTailscaleExtension(definition, commandRunner);
    case 'openobserve':
      return buildOpenObserveExtension(definition, env);
    default:
      return baseRecord(
        definition,
        definition.enabled ? 'enabled' : 'disabled',
        definition.enabled
          ? 'Custom workspace extension is enabled.'
          : 'Custom workspace extension is declared but disabled.',
      );
  }
}

export async function buildExtensionWorkspace(
  root: string,
  env: Record<string, string>,
  commandRunner: CommandRunner = runCommand,
): Promise<ExtensionWorkspace> {
  const extensions = await Promise.all(
    (await loadExtensionDefinitions(root)).map((definition) =>
      buildExtensionRecord(root, definition, env, commandRunner),
    ),
  );
  const enabled = extensions.filter((extension) => extension.status === 'enabled').length;
  const needsConfig = extensions.filter((extension) => extension.status === 'needs_config' || extension.status === 'missing').length;
  const available = extensions.filter((extension) => extension.status === 'available').length;
  const summary: StatCard[] = [
    {
      label: 'Enabled extensions',
      value: String(enabled),
      detail: 'Active optional capabilities',
    },
    {
      label: 'Available',
      value: String(available),
      detail: 'Detected but not enabled',
    },
    {
      label: 'Needs attention',
      value: String(needsConfig),
      detail: 'Missing command or config',
    },
  ];

  return {
    summary,
    extensions,
  };
}
