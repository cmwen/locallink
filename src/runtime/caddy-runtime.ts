import fs from 'node:fs/promises';
import path from 'node:path';

import { parseDocument } from 'yaml';

import { isCommandMissingResult, parseJsonOutput, type CommandRunner } from '../shared/utils';

type ComposeService = {
  image?: unknown;
  labels?: unknown;
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
  source: 'docker-compose' | 'host-cli' | 'missing';
  detail: string;
  serviceName?: string;
  image?: string;
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
      const psResult = await commandRunner(
        'docker',
        ['compose', '--profile', '*', 'ps', '--all', '--format', 'json', serviceName],
        { cwd: workspaceRoot, timeoutMs: 3_000 },
      );
      const running = psResult.ok && composeServiceRunning(psResult.stdout);
      return {
        available: true,
        running,
        source: 'docker-compose',
        serviceName,
        image,
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
      source: 'host-cli',
      detail: `${caddyCommand} is available on the host${hostResult.stdout.trim() ? ` (${hostResult.stdout.trim()})` : ''}.`,
    };
  }

  return {
    available: false,
    running: false,
    source: 'missing',
    detail: isCommandMissingResult(hostResult)
      ? 'No Caddy Docker Compose service is declared in this workspace, and the caddy command is not available on PATH.'
      : 'No Caddy Docker Compose service is declared in this workspace, and the host caddy command did not respond successfully.',
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
