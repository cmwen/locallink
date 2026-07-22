import fs from 'node:fs/promises';
import path from 'node:path';

import { parseDocument } from 'yaml';

import { isCommandMissingResult, parseJsonOutput, type CommandRunner } from '../shared/utils';

type ComposeService = {
  image?: unknown;
  labels?: unknown;
  volumes?: unknown;
};

type ComposeDocument = {
  services?: Record<string, ComposeService>;
};

type ComposePsRecord = {
  State?: string;
  Status?: string;
};

export interface CaddyRuntimeDetection {
  available: boolean;
  running: boolean;
  manageable: boolean;
  source: 'docker-compose' | 'host-cli' | 'missing';
  detail: string;
  serviceName?: string;
  image?: string;
  configPath?: string;
  configTarget?: string;
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

function isCaddyImage(value: unknown): value is string {
  if (typeof value !== 'string') return false;
  const imageName = value.split('@', 1)[0]?.split('/').at(-1)?.split(':', 1)[0]?.toLowerCase();
  return imageName === 'caddy';
}

function isCaddyComposeService(service: ComposeService): boolean {
  const labels = normalizeLabels(service.labels);
  const tags = (labels['locallink.tags'] || '').split(/[,;|]/).map((tag) => tag.trim().toLowerCase());
  return isCaddyImage(service.image)
    || labels['locallink.provider']?.toLowerCase() === 'caddy'
    || tags.includes('caddy');
}

function isInsideWorkspace(workspaceRoot: string, candidate: string): boolean {
  const relative = path.relative(path.resolve(workspaceRoot), path.resolve(candidate));
  return relative === '' || (relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative));
}

function caddyConfigMount(workspaceRoot: string, service: ComposeService): { path: string; target: string } | undefined {
  if (!Array.isArray(service.volumes)) return undefined;
  for (const volume of service.volumes) {
    let source: string | undefined;
    let target: string | undefined;
    if (typeof volume === 'string') {
      const parts = volume.split(':');
      if (parts.length >= 2) [source, target] = parts;
    } else if (volume && typeof volume === 'object') {
      const value = volume as { source?: unknown; target?: unknown };
      source = typeof value.source === 'string' ? value.source : undefined;
      target = typeof value.target === 'string' ? value.target : undefined;
    }
    if (!source || target !== '/etc/caddy/Caddyfile') continue;
    if (!source.startsWith('.') && !path.isAbsolute(source)) return undefined;
    const configPath = path.resolve(workspaceRoot, source);
    return isInsideWorkspace(workspaceRoot, configPath) ? { path: configPath, target } : undefined;
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

export async function detectCaddyRuntime(
  workspaceRoot: string | undefined,
  commandRunner: CommandRunner,
  caddyCommand = 'caddy',
): Promise<CaddyRuntimeDetection> {
  if (workspaceRoot) {
    const compose = await readComposeDocument(workspaceRoot);
    const services = Object.entries(compose?.services || {});
    const declared = services.find(([, service]) => isCaddyComposeService(service));
    if (declared) {
      const [serviceName, service] = declared;
      const image = typeof service.image === 'string' ? service.image : undefined;
      const configMount = caddyConfigMount(workspaceRoot, service);
      const psResult = await commandRunner(
        'docker',
        ['compose', '--profile', '*', 'ps', '--all', '--format', 'json', serviceName],
        { cwd: workspaceRoot, timeoutMs: 3_000 },
      );
      const running = psResult.ok && composeServiceRunning(psResult.stdout);
      return {
        available: true,
        running,
        manageable: Boolean(configMount),
        source: 'docker-compose',
        serviceName,
        image,
        configPath: configMount?.path,
        configTarget: configMount?.target,
        detail: running
          ? `Docker Compose service "${serviceName}" is running${image ? ` with image ${image}` : ''}.`
          : psResult.ok
            ? `Docker Compose service "${serviceName}" is declared${image ? ` with image ${image}` : ''}, but it is not running.`
            : `Docker Compose service "${serviceName}" is declared${image ? ` with image ${image}` : ''}; its runtime state could not be verified.`,
      };
    }
  }

  const hostResult = await commandRunner(caddyCommand, ['version'], { timeoutMs: 2_000 });
  if (hostResult.ok) {
    return {
      available: true,
      running: true,
      manageable: false,
      source: 'host-cli',
      detail: `${caddyCommand} is available on the host${hostResult.stdout.trim() ? ` (${hostResult.stdout.trim()})` : ''}.`,
    };
  }

  return {
    available: false,
    running: false,
    manageable: false,
    source: 'missing',
    detail: isCommandMissingResult(hostResult)
      ? 'No Caddy Docker Compose service is declared in this workspace, and the caddy command is not available on PATH.'
      : 'No Caddy Docker Compose service is declared in this workspace, and the host caddy command did not respond successfully.',
  };
}

export async function writeWorkspaceCaddyfile(workspaceRoot: string, relativePath: string, content: string): Promise<string> {
  const filePath = path.resolve(workspaceRoot, relativePath);
  if (!isInsideWorkspace(workspaceRoot, filePath)) throw new Error('Generated Caddyfile must remain inside the active workspace.');
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  const temporaryPath = `${filePath}.${process.pid}.tmp`;
  await fs.writeFile(temporaryPath, content, 'utf8');
  await fs.rename(temporaryPath, filePath);
  return filePath;
}

export async function readWorkspaceFile(filePath: string): Promise<string | undefined> {
  try {
    return await fs.readFile(filePath, 'utf8');
  } catch (error) {
    const code = error && typeof error === 'object' && 'code' in error ? String(error.code) : '';
    if (code === 'ENOENT') return undefined;
    throw error;
  }
}

export async function removeWorkspaceFile(workspaceRoot: string, relativePath: string): Promise<void> {
  const filePath = path.resolve(workspaceRoot, relativePath);
  if (!isInsideWorkspace(workspaceRoot, filePath)) throw new Error('Caddy runtime files must remain inside the active workspace.');
  try {
    await fs.unlink(filePath);
  } catch (error) {
    const code = error && typeof error === 'object' && 'code' in error ? String(error.code) : '';
    if (code !== 'ENOENT') throw error;
  }
}

const MANAGED_START = '# BEGIN LOCALLINK MANAGED PRIVATE EDGE ROUTES';
const MANAGED_END = '# END LOCALLINK MANAGED PRIVATE EDGE ROUTES';

export function mergeManagedCaddyfile(existing: string | undefined, generated: string): string {
  const generatedStart = generated.indexOf(MANAGED_START);
  const generatedEnd = generated.indexOf(MANAGED_END);
  if (generatedStart < 0 || generatedEnd < generatedStart) return generated;
  const managedBlock = generated.slice(generatedStart, generatedEnd + MANAGED_END.length).trim();
  if (!existing?.trim()) return generated;

  const existingStart = existing.indexOf(MANAGED_START);
  const existingEnd = existing.indexOf(MANAGED_END);
  if (existingStart >= 0 && existingEnd >= existingStart) {
    return `${existing.slice(0, existingStart)}${managedBlock}${existing.slice(existingEnd + MANAGED_END.length)}`.replace(/\n{3,}/g, '\n\n').trimEnd() + '\n';
  }
  return `${existing.trimEnd()}\n\n${managedBlock}\n`;
}

export function caddyReloadCommand(
  runtime: Pick<CaddyRuntimeDetection, 'source' | 'serviceName' | 'configTarget'>,
): { command: string; args: string[] } | undefined {
  if (runtime.source !== 'docker-compose' || !runtime.serviceName || !runtime.configTarget) return undefined;
  return {
    command: 'docker',
    args: [
      'compose', '--profile', '*', 'exec', '-T', runtime.serviceName,
      'caddy', 'reload', '--config', runtime.configTarget, '--adapter', 'caddyfile',
    ],
  };
}

export function caddyStartCommand(
  runtime: Pick<CaddyRuntimeDetection, 'source' | 'serviceName'>,
): { command: string; args: string[] } | undefined {
  if (runtime.source !== 'docker-compose' || !runtime.serviceName) return undefined;
  return {
    command: 'docker',
    args: ['compose', '--profile', '*', 'up', '-d', runtime.serviceName],
  };
}

export function caddyStopCommand(
  runtime: Pick<CaddyRuntimeDetection, 'source' | 'serviceName'>,
): { command: string; args: string[] } | undefined {
  if (runtime.source !== 'docker-compose' || !runtime.serviceName) return undefined;
  return {
    command: 'docker',
    args: ['compose', '--profile', '*', 'stop', runtime.serviceName],
  };
}

export function caddyValidationCommand(
  runtime: CaddyRuntimeDetection,
  generatedPath: string,
  caddyCommand = 'caddy',
): { command: string; args: string[] } {
  if (runtime.source === 'docker-compose' && runtime.serviceName) {
    return {
      command: 'docker',
      args: [
        'compose', '--profile', '*', 'run', '--rm', '--no-deps',
        '-v', `./${generatedPath}:/etc/caddy/Caddyfile:ro`,
        runtime.serviceName,
        'caddy', 'validate', '--config', '/etc/caddy/Caddyfile', '--adapter', 'caddyfile',
      ],
    };
  }
  return { command: caddyCommand, args: ['validate', '--config', generatedPath, '--adapter', 'caddyfile'] };
}
