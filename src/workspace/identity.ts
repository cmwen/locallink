import { createHash } from 'node:crypto';
import path from 'node:path';

import type { PortAllocator } from '../ports/allocator';
import { AppError } from '../shared/errors';
import { slugify } from '../shared/utils';

export interface WorkspaceIdentity {
  id: string;
  name: string;
  root: string;
}

export interface WorkspaceBinding {
  host: string;
  port: number;
  automatic: boolean;
}

export interface WorkspaceRuntimeDescriptor extends WorkspaceIdentity, WorkspaceBinding {
  pid: number;
  url: string;
  startedAt: string;
}

function shortPathHash(root: string): string {
  return createHash('sha256').update(path.resolve(root)).digest('hex').slice(0, 8);
}

export function normalizeWorkspaceId(value: string): string {
  return slugify(value).slice(0, 48);
}

export function deriveWorkspaceIdentity(root: string, configuredId?: string): WorkspaceIdentity {
  const resolvedRoot = path.resolve(root);
  const name = path.basename(resolvedRoot) || 'workspace';
  const configured = configuredId ? normalizeWorkspaceId(configuredId) : '';
  const base = normalizeWorkspaceId(name) || 'workspace';
  return {
    id: configured || `${base}-${shortPathHash(resolvedRoot)}`,
    name,
    root: resolvedRoot,
  };
}

export function composeProjectName(workspaceId: string): string {
  return `locallink_${normalizeWorkspaceId(workspaceId).replace(/-/g, '_') || 'workspace'}`;
}

export function buildWorkspaceProcessEnv(
  root: string,
  env: Record<string, string>,
): NodeJS.ProcessEnv {
  const identity = deriveWorkspaceIdentity(root, env.LOCALLINK_WORKSPACE_ID);
  const merged: NodeJS.ProcessEnv = {
    ...process.env,
    ...env,
    LOCALLINK_WORKSPACE_ID: identity.id,
    COMPOSE_PROJECT_NAME: env.COMPOSE_PROJECT_NAME?.trim() || composeProjectName(identity.id),
  };
  const pm2Home = env.PM2_HOME?.trim() || '.locallink/pm2';
  merged.PM2_HOME = path.isAbsolute(pm2Home) ? pm2Home : path.resolve(root, pm2Home);
  return merged;
}

function parsePort(value: string | undefined, fallback: number): number {
  const port = Number(value || fallback);
  if (!Number.isInteger(port) || port < 1024 || port > 65535) {
    throw new AppError(
      'INVALID_WEB_PORT',
      `LocalLink web ports must be integers between 1024 and 65535; received "${value}".`,
      400,
    );
  }
  return port;
}

export async function resolveWorkspaceBinding(
  env: Record<string, string>,
  host: string,
  portAllocator: PortAllocator,
): Promise<WorkspaceBinding> {
  const configured = env.LOCALLINK_WEB_PORT?.trim().toLowerCase();
  if (configured && configured !== 'auto') {
    return {
      host,
      port: parsePort(configured, 4010),
      automatic: false,
    };
  }

  const startFrom = parsePort(env.LOCALLINK_WEB_PORT_START, 4010);
  const scan = await portAllocator.findNextAvailablePort(startFrom);
  return {
    host,
    port: scan.nextFree,
    automatic: true,
  };
}
