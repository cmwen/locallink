import fs from 'node:fs/promises';
import path from 'node:path';

import { parseDocument } from 'yaml';

import { isCommandMissingResult, parseJsonOutput, type CommandRunner } from '../shared/utils';

type ComposeService = {
  image?: unknown;
  labels?: unknown;
  environment?: unknown;
  volumes?: unknown;
};

type ComposeDocument = {
  services?: Record<string, ComposeService>;
};

type ComposePsRecord = {
  State?: string;
  Status?: string;
};

export interface TailscaleRuntimeDetection {
  available: boolean;
  running: boolean;
  manageable: boolean;
  source: 'docker-compose' | 'host-cli' | 'missing';
  detail: string;
  serviceName?: string;
  image?: string;
  serveConfigPath?: string;
  serveConfigTarget?: string;
  serveConfigMount?: 'file' | 'directory';
}

export interface TailscaleRuntimeCommand {
  command: string;
  argsPrefix: string[];
}

const COMPOSE_FILES = ['compose.yaml', 'compose.yml', 'docker-compose.yaml', 'docker-compose.yml'];

function normalizeLabels(value: unknown): Record<string, string> {
  if (Array.isArray(value)) {
    return Object.fromEntries(value.flatMap((entry) => {
      const [key, ...rest] = String(entry).split('=');
      return key ? [[key, rest.join('=')]] : [];
    }));
  }
  if (!value || typeof value !== 'object') return {};
  return Object.fromEntries(Object.entries(value).map(([key, entry]) => [key, String(entry ?? '')]));
}

function normalizeEnvironment(value: unknown): Record<string, string> {
  if (Array.isArray(value)) {
    return Object.fromEntries(value.flatMap((entry) => {
      const [key, ...rest] = String(entry).split('=');
      return key ? [[key, rest.join('=')]] : [];
    }));
  }
  if (!value || typeof value !== 'object') return {};
  return Object.fromEntries(Object.entries(value).map(([key, entry]) => [key, String(entry ?? '')]));
}

function isTailscaleImage(value: unknown): value is string {
  if (typeof value !== 'string') return false;
  const imageName = value.split('@', 1)[0]?.split('/').at(-1)?.split(':', 1)[0]?.toLowerCase();
  return imageName === 'tailscale';
}

function isTailscaleComposeService(service: ComposeService): boolean {
  const labels = normalizeLabels(service.labels);
  return isTailscaleImage(service.image)
    || labels['locallink.provider']?.toLowerCase() === 'tailscale';
}

function isInsideWorkspace(workspaceRoot: string, candidate: string): boolean {
  const relative = path.relative(path.resolve(workspaceRoot), path.resolve(candidate));
  return relative === '' || (relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative));
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

function resolveServeConfigMount(
  workspaceRoot: string,
  service: ComposeService,
): Pick<TailscaleRuntimeDetection, 'serveConfigPath' | 'serveConfigTarget' | 'serveConfigMount'> | undefined {
  const environment = normalizeEnvironment(service.environment);
  const configTarget = environment.TS_SERVE_CONFIG?.trim();
  if (!configTarget?.startsWith('/') || !Array.isArray(service.volumes)) return undefined;

  for (const volume of service.volumes) {
    const { source, target } = volumeParts(volume);
    if (!source || !target || (!source.startsWith('.') && !path.isAbsolute(source))) continue;

    let candidate: string | undefined;
    let mount: 'file' | 'directory' | undefined;
    if (target === configTarget) {
      candidate = path.resolve(workspaceRoot, source);
      mount = 'file';
    } else {
      const relativeTarget = path.relative(path.posix.resolve(target), path.posix.resolve(configTarget));
      if (relativeTarget && relativeTarget !== '..' && !relativeTarget.startsWith('../') && !path.posix.isAbsolute(relativeTarget)) {
        candidate = path.resolve(workspaceRoot, source, relativeTarget);
        mount = 'directory';
      }
    }
    if (candidate && isInsideWorkspace(workspaceRoot, candidate)) {
      return {
        serveConfigPath: candidate,
        serveConfigTarget: configTarget,
        serveConfigMount: mount,
      };
    }
  }
  return undefined;
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

function composeServiceRunning(raw: string): boolean {
  return parseJsonOutput<ComposePsRecord>(raw).some((record) => {
    const state = record.State?.trim().toLowerCase();
    const status = record.Status?.trim().toLowerCase();
    return state === 'running' || Boolean(status?.startsWith('up'));
  });
}

export async function detectTailscaleRuntime(
  workspaceRoot: string | undefined,
  commandRunner: CommandRunner,
  tailscaleCommand = 'tailscale',
): Promise<TailscaleRuntimeDetection> {
  if (workspaceRoot) {
    const compose = await readComposeDocument(workspaceRoot);
    const declared = Object.entries(compose?.services || {}).find(([, service]) => isTailscaleComposeService(service));
    if (declared) {
      const [serviceName, service] = declared;
      const image = typeof service.image === 'string' ? service.image : undefined;
      const serveConfig = resolveServeConfigMount(workspaceRoot, service);
      const psResult = await commandRunner(
        'docker',
        ['compose', '--profile', '*', 'ps', '--all', '--format', 'json', serviceName],
        { cwd: workspaceRoot, timeoutMs: 3_000 },
      );
      const running = psResult.ok && composeServiceRunning(psResult.stdout);
      return {
        available: true,
        running,
        manageable: Boolean(serveConfig),
        source: 'docker-compose',
        serviceName,
        image,
        ...serveConfig,
        detail: [
          `Docker Compose service "${serviceName}" is declared${image ? ` with image ${image}` : ''}`,
          running ? 'and running.' : 'but is not running.',
          serveConfig
            ? `Its TS_SERVE_CONFIG is workspace-owned at ${serveConfig.serveConfigPath}.`
            : 'Its TS_SERVE_CONFIG is not mounted from a file or directory inside this workspace.',
        ].join(' '),
      };
    }
  }

  const hostResult = await commandRunner(tailscaleCommand, ['status', '--json'], { timeoutMs: 2_000 });
  if (hostResult.ok) {
    return {
      available: true,
      running: true,
      manageable: false,
      source: 'host-cli',
      detail: `${tailscaleCommand} is connected on the host.`,
    };
  }

  return {
    available: false,
    running: false,
    manageable: false,
    source: 'missing',
    detail: isCommandMissingResult(hostResult)
      ? 'No Tailscale Docker Compose service is declared in this workspace, and the tailscale command is not available on PATH.'
      : 'No Tailscale Docker Compose service is declared in this workspace, and the host tailscale command is not connected.',
  };
}

export function tailscaleRuntimeCommand(
  runtime: Pick<TailscaleRuntimeDetection, 'source' | 'serviceName'>,
  hostCommand = 'tailscale',
): TailscaleRuntimeCommand | undefined {
  if (runtime.source === 'docker-compose' && runtime.serviceName) {
    return {
      command: 'docker',
      argsPrefix: ['compose', '--profile', '*', 'exec', '-T', runtime.serviceName, 'tailscale'],
    };
  }
  if (runtime.source === 'host-cli') return { command: hostCommand, argsPrefix: [] };
  return undefined;
}

export function tailscaleStartCommand(
  runtime: Pick<TailscaleRuntimeDetection, 'source' | 'serviceName'>,
): { command: string; args: string[] } | undefined {
  if (runtime.source !== 'docker-compose' || !runtime.serviceName) return undefined;
  return {
    command: 'docker',
    args: ['compose', '--profile', '*', 'up', '-d', runtime.serviceName],
  };
}

export function tailscaleStopCommand(
  runtime: Pick<TailscaleRuntimeDetection, 'source' | 'serviceName'>,
): { command: string; args: string[] } | undefined {
  if (runtime.source !== 'docker-compose' || !runtime.serviceName) return undefined;
  return {
    command: 'docker',
    args: ['compose', '--profile', '*', 'stop', runtime.serviceName],
  };
}
