import fs from 'node:fs/promises';
import http from 'node:http';
import https from 'node:https';
import path from 'node:path';

import { parseDocument } from 'yaml';

import { parseJsonOutput, type CommandRunner } from '../shared/utils';

type ComposeService = {
  image?: unknown;
  labels?: unknown;
  environment?: unknown;
  volumes?: unknown;
  ports?: unknown;
};

type ComposeDocument = {
  services?: Record<string, ComposeService>;
};

type ComposePsRecord = {
  State?: string;
  Status?: string;
  Health?: string;
};

export type OpenObserveCredentialState = 'valid' | 'invalid' | 'unverified' | 'missing';

export interface OpenObserveProbeResult {
  ok: boolean;
  status?: number;
}

export type OpenObserveHttpProbe = (
  url: string,
  authorization?: string,
) => Promise<OpenObserveProbeResult>;

export interface OpenObserveRuntimeDetection {
  available: boolean;
  running: boolean;
  healthy: boolean;
  manageable: boolean;
  configured: boolean;
  credentialsConfigured: boolean;
  credentialState: OpenObserveCredentialState;
  persistent: boolean;
  loopbackOnly: boolean;
  source: 'docker-compose' | 'missing';
  detail: string;
  serviceName?: string;
  image?: string;
  port?: string;
  endpoint?: string;
  healthUrl?: string;
  organization?: string;
  stream?: string;
  otlpBaseUrl?: string;
}

const COMPOSE_FILES = ['compose.yaml', 'compose.yml', 'docker-compose.yaml', 'docker-compose.yml'];

function normalizeMap(value: unknown): Record<string, string> {
  if (Array.isArray(value)) {
    return Object.fromEntries(value.flatMap((entry) => {
      const [key, ...rest] = String(entry).split('=');
      return key ? [[key, rest.join('=')]] : [];
    }));
  }
  if (!value || typeof value !== 'object') return {};
  const node = value as { toJSON?: () => unknown };
  const plain = typeof node.toJSON === 'function' ? node.toJSON() : value;
  if (!plain || typeof plain !== 'object' || Array.isArray(plain)) return {};
  return Object.fromEntries(Object.entries(plain as Record<string, unknown>).map(([key, entry]) => [
    key,
    String(entry ?? ''),
  ]));
}

function isOpenObserveImage(value: unknown): value is string {
  if (typeof value !== 'string') return false;
  const imageName = value.split('@', 1)[0]?.split('/').at(-1)?.split(':', 1)[0]?.toLowerCase();
  return imageName === 'openobserve' || imageName === 'openobserve-enterprise';
}

function isOpenObserveService(service: ComposeService): boolean {
  const labels = normalizeMap(service.labels);
  return isOpenObserveImage(service.image)
    || labels['locallink.provider']?.toLowerCase() === 'openobserve';
}

async function readComposeDocument(workspaceRoot: string): Promise<ComposeDocument | undefined> {
  for (const fileName of COMPOSE_FILES) {
    try {
      const raw = await fs.readFile(path.join(workspaceRoot, fileName), 'utf8');
      const parsed = parseDocument(raw).toJS();
      if (parsed && typeof parsed === 'object') return parsed as ComposeDocument;
    } catch (error) {
      const code = error && typeof error === 'object' && 'code' in error ? String(error.code) : '';
      if (code !== 'ENOENT') return undefined;
    }
  }
  return undefined;
}

function interpolate(value: string | undefined, env: Record<string, string>): string | undefined {
  if (!value) return undefined;
  return value.replace(/\$\{([A-Za-z_][A-Za-z0-9_]*)(?::-([^}]*))?\}/g, (_match, key: string, fallback: string) => (
    env[key] || fallback || ''
  ));
}

function volumeParts(volume: unknown): { source?: string; target?: string } {
  if (typeof volume === 'string') {
    const parts = volume.split(':');
    return parts.length >= 2 ? { source: parts[0], target: parts[1] } : {};
  }
  if (!volume || typeof volume !== 'object') return {};
  const value = volume as { source?: unknown; target?: unknown };
  return {
    source: typeof value.source === 'string' ? value.source : undefined,
    target: typeof value.target === 'string' ? value.target : undefined,
  };
}

function splitPortSegments(value: string): string[] {
  const segments: string[] = [];
  let current = '';
  let braceDepth = 0;
  let bracketDepth = 0;
  for (const character of value) {
    if (character === '{') braceDepth += 1;
    if (character === '}') braceDepth = Math.max(0, braceDepth - 1);
    if (character === '[') bracketDepth += 1;
    if (character === ']') bracketDepth = Math.max(0, bracketDepth - 1);
    if (character === ':' && braceDepth === 0 && bracketDepth === 0) {
      segments.push(current);
      current = '';
    } else {
      current += character;
    }
  }
  segments.push(current);
  return segments;
}

function portBinding(service: ComposeService, env: Record<string, string>): {
  port: string;
  loopbackOnly: boolean;
} {
  const labels = normalizeMap(service.labels);
  const portEnv = labels['locallink.portEnv'];
  const fallback = (portEnv && env[portEnv]) || env.OPENOBSERVE_PORT || '5080';
  if (!Array.isArray(service.ports) || service.ports.length === 0) {
    return { port: fallback, loopbackOnly: false };
  }
  const first = service.ports[0];
  if (typeof first === 'object' && first) {
    const binding = first as { host_ip?: unknown; published?: unknown };
    const hostIp = String(binding.host_ip ?? '');
    return {
      port: interpolate(String(binding.published ?? ''), env) || fallback,
      loopbackOnly: hostIp === '127.0.0.1' || hostIp === '::1',
    };
  }
  if (typeof first !== 'string') return { port: fallback, loopbackOnly: false };
  const parts = splitPortSegments(first);
  const host = parts.length >= 3 ? interpolate(parts.at(-3), env) : undefined;
  const published = parts.length >= 2 ? parts.at(-2) : parts[0];
  return {
    port: interpolate(published, env) || fallback,
    loopbackOnly: host === '127.0.0.1' || host === '[::1]' || host === '::1',
  };
}

function composeState(raw: string): { running: boolean; healthy: boolean } {
  const records = parseJsonOutput<ComposePsRecord>(raw);
  const running = records.some((record) => (
    record.State?.trim().toLowerCase() === 'running'
    || record.Status?.trim().toLowerCase().startsWith('up')
  ));
  const healthValues = records.map((record) => record.Health?.trim().toLowerCase()).filter(Boolean);
  return {
    running,
    healthy: running && healthValues.some((health) => health === 'healthy'),
  };
}

const defaultHttpProbe: OpenObserveHttpProbe = async (url, authorization) => {
  return new Promise((resolve) => {
    const target = new URL(url);
    const client = target.protocol === 'https:' ? https : http;
    const request = client.request(target, {
      method: 'GET',
      headers: authorization ? { Authorization: authorization } : undefined,
      timeout: 3_000,
    }, (response) => {
      response.resume();
      const status = response.statusCode;
      resolve({
        ok: Boolean(status && status >= 200 && status < 300),
        status,
      });
    });
    request.once('timeout', () => request.destroy(new Error('OpenObserve probe timed out.')));
    request.once('error', () => resolve({ ok: false }));
    request.end();
  });
};

function configuredValue(value: string | undefined): boolean {
  return Boolean(value?.trim()) && !/(?:change[-_]?me|example-password|<[^>]+>)/i.test(value!);
}

export async function detectOpenObserveRuntime(
  workspaceRoot: string,
  commandRunner: CommandRunner,
  env: Record<string, string> = {},
  httpProbe: OpenObserveHttpProbe = defaultHttpProbe,
): Promise<OpenObserveRuntimeDetection> {
  const compose = await readComposeDocument(workspaceRoot);
  const declared = Object.entries(compose?.services || {}).find(([, service]) => isOpenObserveService(service));
  if (!declared) {
    return {
      available: false,
      running: false,
      healthy: false,
      manageable: false,
      configured: false,
      credentialsConfigured: false,
      credentialState: 'missing',
      persistent: false,
      loopbackOnly: false,
      source: 'missing',
      detail: 'No OpenObserve Docker Compose service is declared in this workspace.',
    };
  }

  const [serviceName, service] = declared;
  const image = typeof service.image === 'string' ? service.image : undefined;
  const environment = normalizeMap(service.environment);
  const binding = portBinding(service, env);
  const endpoint = `http://127.0.0.1:${binding.port}`;
  const healthUrl = `${endpoint}/healthz`;
  const organization = env.OPENOBSERVE_ORGANIZATION || 'default';
  const stream = env.OPENOBSERVE_STREAM || 'default';
  const otlpBaseUrl = (env.OPENOBSERVE_OTLP_BASE_URL || `${endpoint}/api/${organization}`).replace(/\/$/, '');
  const username = interpolate(environment.ZO_ROOT_USER_EMAIL, env) || env.OPENOBSERVE_USERNAME;
  const password = interpolate(environment.ZO_ROOT_USER_PASSWORD, env) || env.OPENOBSERVE_PASSWORD;
  const credentialsConfigured = configuredValue(username) && configuredValue(password);
  const dataDir = interpolate(environment.ZO_DATA_DIR, env) || '/data';
  const persistent = Array.isArray(service.volumes)
    && service.volumes.some((volume) => volumeParts(volume).target === dataDir);
  const psResult = await commandRunner(
    'docker',
    ['compose', '--profile', '*', 'ps', '--all', '--format', 'json', serviceName],
    { cwd: workspaceRoot, timeoutMs: 3_000 },
  );
  const state = psResult.ok ? composeState(psResult.stdout) : { running: false, healthy: false };

  let healthy = state.healthy;
  if (state.running && !healthy) {
    healthy = (await httpProbe(healthUrl)).ok;
  }

  let credentialState: OpenObserveCredentialState = credentialsConfigured ? 'unverified' : 'missing';
  if (healthy && credentialsConfigured) {
    const authorization = `Basic ${Buffer.from(`${username}:${password}`, 'utf8').toString('base64')}`;
    const probe = await httpProbe(
      `${endpoint}/api/${encodeURIComponent(organization)}/streams?fetchSchema=false&type=logs`,
      authorization,
    );
    credentialState = probe.ok
      ? 'valid'
      : probe.status === 401 || probe.status === 403
        ? 'invalid'
        : 'unverified';
  }

  const configured = credentialsConfigured && persistent;
  return {
    available: true,
    running: state.running,
    healthy,
    manageable: true,
    configured,
    credentialsConfigured,
    credentialState,
    persistent,
    loopbackOnly: binding.loopbackOnly,
    source: 'docker-compose',
    serviceName,
    image,
    port: binding.port,
    endpoint,
    healthUrl,
    organization,
    stream,
    otlpBaseUrl,
    detail: [
      `Docker Compose service "${serviceName}" is declared${image ? ` with image ${image}` : ''}.`,
      state.running ? (healthy ? 'It is running and healthy.' : 'It is running but /healthz is failing.') : 'It is not running.',
      persistent ? `Its ${dataDir} data directory is persistent.` : `Its ${dataDir} data directory is not backed by a declared volume.`,
      binding.loopbackOnly ? `Its UI is bound to loopback on port ${binding.port}.` : `Its published port ${binding.port} is not explicitly loopback-only.`,
      credentialState === 'valid'
        ? 'The configured credentials authenticate successfully.'
        : credentialState === 'invalid'
          ? 'The configured credentials do not authenticate; existing data was not changed.'
          : credentialState === 'missing'
            ? 'Root credentials are not configured.'
            : 'The configured credentials could not be verified.',
    ].join(' '),
  };
}

export function openObserveStartCommand(
  runtime: Pick<OpenObserveRuntimeDetection, 'source' | 'serviceName'>,
): { command: string; args: string[] } | undefined {
  if (runtime.source !== 'docker-compose' || !runtime.serviceName) return undefined;
  return {
    command: 'docker',
    args: ['compose', '--profile', '*', 'up', '-d', runtime.serviceName],
  };
}

export function openObserveStopCommand(
  runtime: Pick<OpenObserveRuntimeDetection, 'source' | 'serviceName'>,
): { command: string; args: string[] } | undefined {
  if (runtime.source !== 'docker-compose' || !runtime.serviceName) return undefined;
  return {
    command: 'docker',
    args: ['compose', '--profile', '*', 'stop', runtime.serviceName],
  };
}
