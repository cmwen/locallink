import fs from 'node:fs/promises';
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

export interface PocketIdRuntimeDetection {
  available: boolean;
  running: boolean;
  healthy: boolean;
  manageable: boolean;
  configured: boolean;
  encryptionConfigured: boolean;
  persistent: boolean;
  source: 'docker-compose' | 'missing';
  detail: string;
  serviceName?: string;
  image?: string;
  port?: string;
  appUrl?: string;
  encryptionSource?: 'environment' | 'file';
  encryptionFilePath?: string;
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

function isPocketIdImage(value: unknown): value is string {
  if (typeof value !== 'string') return false;
  const imageName = value.split('@', 1)[0]?.split('/').at(-1)?.split(':', 1)[0]?.toLowerCase();
  return imageName === 'pocket-id';
}

function isPocketIdService(service: ComposeService): boolean {
  const labels = normalizeMap(service.labels);
  return isPocketIdImage(service.image)
    || labels['locallink.provider']?.toLowerCase() === 'pocket-id';
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

function resolvePort(service: ComposeService, env: Record<string, string>): string | undefined {
  const labels = normalizeMap(service.labels);
  const portEnv = labels['locallink.portEnv'];
  if (portEnv && env[portEnv]) return env[portEnv];
  if (!Array.isArray(service.ports)) return env.POCKET_ID_PORT || '1411';
  const first = service.ports[0];
  if (typeof first !== 'string') return env.POCKET_ID_PORT || '1411';
  const parts = splitPortSegments(first);
  const published = parts.length >= 3 ? parts.at(-2) : parts[0];
  return interpolate(published, env) || env.POCKET_ID_PORT || '1411';
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

function encryptionConfiguration(
  workspaceRoot: string,
  service: ComposeService,
  env: Record<string, string>,
): Pick<PocketIdRuntimeDetection, 'configured' | 'encryptionSource' | 'encryptionFilePath'> {
  const environment = normalizeMap(service.environment);
  const directKey = interpolate(environment.ENCRYPTION_KEY, env);
  if (directKey) return { configured: true, encryptionSource: 'environment' };

  const target = interpolate(environment.ENCRYPTION_KEY_FILE, env);
  if (!target || !Array.isArray(service.volumes)) return { configured: false };
  for (const volume of service.volumes) {
    const parts = volumeParts(volume);
    if (!parts.source || parts.target !== target) continue;
    if (!parts.source.startsWith('.') && !path.isAbsolute(parts.source)) return { configured: false };
    const filePath = path.resolve(workspaceRoot, parts.source);
    const relative = path.relative(path.resolve(workspaceRoot), filePath);
    if (relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
      return { configured: false };
    }
    return {
      configured: true,
      encryptionSource: 'file',
      encryptionFilePath: filePath,
    };
  }
  return { configured: false };
}

export async function detectPocketIdRuntime(
  workspaceRoot: string,
  commandRunner: CommandRunner,
  env: Record<string, string> = {},
): Promise<PocketIdRuntimeDetection> {
  const compose = await readComposeDocument(workspaceRoot);
  const declared = Object.entries(compose?.services || {}).find(([, service]) => isPocketIdService(service));
  if (!declared) {
    return {
      available: false,
      running: false,
      healthy: false,
      manageable: false,
      configured: false,
      encryptionConfigured: false,
      persistent: false,
      source: 'missing',
      detail: 'No Pocket ID Docker Compose service is declared in this workspace.',
    };
  }

  const [serviceName, service] = declared;
  const image = typeof service.image === 'string' ? service.image : undefined;
  const environment = normalizeMap(service.environment);
  const appUrl = interpolate(environment.APP_URL, env) || env.POCKET_ID_APP_URL;
  const encryption = encryptionConfiguration(workspaceRoot, service, env);
  if (encryption.encryptionFilePath) {
    try {
      const key = await fs.readFile(encryption.encryptionFilePath);
      encryption.configured = key.length >= 16;
    } catch {
      encryption.configured = false;
    }
  }
  const persistent = Array.isArray(service.volumes)
    && service.volumes.some((volume) => volumeParts(volume).target === '/app/data');
  const psResult = await commandRunner(
    'docker',
    ['compose', '--profile', '*', 'ps', '--all', '--format', 'json', serviceName],
    { cwd: workspaceRoot, timeoutMs: 3_000 },
  );
  const state = psResult.ok ? composeState(psResult.stdout) : { running: false, healthy: false };
  let healthy = state.healthy;
  if (state.running && !healthy) {
    const healthResult = await commandRunner(
      'docker',
      ['compose', '--profile', '*', 'exec', '-T', serviceName, '/app/pocket-id', 'healthcheck'],
      { cwd: workspaceRoot, timeoutMs: 5_000 },
    );
    healthy = healthResult.ok;
  }

  const configured = encryption.configured && Boolean(appUrl?.startsWith('https://'));
  return {
    available: true,
    running: state.running,
    healthy,
    manageable: true,
    configured,
    encryptionConfigured: encryption.configured,
    persistent,
    source: 'docker-compose',
    serviceName,
    image,
    port: resolvePort(service, env),
    appUrl,
    encryptionSource: encryption.encryptionSource,
    encryptionFilePath: encryption.encryptionFilePath,
    detail: [
      `Docker Compose service "${serviceName}" is declared${image ? ` with image ${image}` : ''}.`,
      state.running ? (healthy ? 'It is running and healthy.' : 'It is running but its healthcheck is failing.') : 'It is not running.',
      persistent ? 'Its /app/data directory is persistent.' : 'Its /app/data directory is not backed by a declared volume.',
      configured ? `Its HTTPS issuer is ${appUrl}.` : 'Its HTTPS issuer or encryption key is not configured.',
    ].join(' '),
  };
}

export function pocketIdStartCommand(
  runtime: Pick<PocketIdRuntimeDetection, 'source' | 'serviceName'>,
): { command: string; args: string[] } | undefined {
  if (runtime.source !== 'docker-compose' || !runtime.serviceName) return undefined;
  return {
    command: 'docker',
    args: ['compose', '--profile', '*', 'up', '-d', runtime.serviceName],
  };
}

export function pocketIdStopCommand(
  runtime: Pick<PocketIdRuntimeDetection, 'source' | 'serviceName'>,
): { command: string; args: string[] } | undefined {
  if (runtime.source !== 'docker-compose' || !runtime.serviceName) return undefined;
  return {
    command: 'docker',
    args: ['compose', '--profile', '*', 'stop', runtime.serviceName],
  };
}
