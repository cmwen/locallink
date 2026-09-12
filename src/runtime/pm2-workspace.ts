import { execFile } from 'node:child_process';
import fs from 'node:fs/promises';
import net from 'node:net';
import path from 'node:path';
import { promisify } from 'node:util';

import { AppError } from '../shared/errors';
import {
  buildWorkspaceProcessEnv,
  canonicalizeWorkspacePath,
  resolveCanonicalPm2Home,
} from '../workspace/identity';

const LOCK_WAIT_MS = 50;
const LOCK_TIMEOUT_MS = 65_000;
const STALE_LOCK_MS = 120_000;
const execFileAsync = promisify(execFile);

export interface Pm2WorkspaceInspection {
  pm2Home: string;
  daemonPids: number[];
  socketPath: string;
  socketAvailable: boolean;
  staleArtifacts: string[];
}

interface LockOwner {
  pid?: number;
  createdAt?: string;
}

function isAlive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) {
    return false;
  }
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'EPERM';
  }
}

async function readText(filePath: string): Promise<string | undefined> {
  try {
    return await fs.readFile(filePath, 'utf8');
  } catch {
    return undefined;
  }
}

async function fileExists(filePath: string): Promise<boolean> {
  try {
    await fs.access(filePath);
    return true;
  } catch {
    return false;
  }
}

async function readProcEnvironment(pid: number): Promise<Record<string, string>> {
  const raw = await readText(`/proc/${pid}/environ`);
  if (!raw) {
    return {};
  }
  return Object.fromEntries(
    raw
      .split('\0')
      .filter(Boolean)
      .map((entry) => {
        const separator = entry.indexOf('=');
        return separator < 0 ? [entry, ''] : [entry.slice(0, separator), entry.slice(separator + 1)];
      }),
  );
}

async function discoverPm2DaemonPids(pm2Home: string): Promise<number[]> {
  if (process.platform !== 'linux') {
    return discoverPm2DaemonPidsFromProcessList(pm2Home);
  }

  const entries = await fs.readdir('/proc').catch(() => []);
  if (entries.length === 0) {
    return discoverPm2DaemonPidsFromProcessList(pm2Home);
  }

  const matches = await Promise.all(entries.filter((entry) => /^\d+$/.test(entry)).map(async (entry) => {
    const pid = Number(entry);
    const command = (await readText(`/proc/${pid}/cmdline`))?.replace(/\0/g, ' ') ?? '';
    if (!/PM2.*God Daemon/i.test(command)) {
      return undefined;
    }

    const environment = await readProcEnvironment(pid);
    const configuredHome = environment.PM2_HOME;
    const titleHome = command.match(/God Daemon\s+\(([^)]+)\)/i)?.[1];
    if (!configuredHome && !titleHome) {
      return undefined;
    }

    let cwd = '/';
    try {
      cwd = await fs.readlink(`/proc/${pid}/cwd`);
    } catch {
      // An absolute PM2_HOME does not need the daemon cwd.
    }
    const candidateHomes = [configuredHome, titleHome]
      .filter((candidate): candidate is string => Boolean(candidate))
      .map((candidate) => canonicalizeWorkspacePath(candidate, cwd));
    return candidateHomes.includes(pm2Home) ? pid : undefined;
  }));

  return matches
    .filter((pid): pid is number => pid !== undefined && isAlive(pid))
    .sort((left, right) => left - right);
}

async function discoverPm2DaemonPidsFromProcessList(pm2Home: string): Promise<number[]> {
  if (process.platform === 'win32') {
    // Windows PM2 ownership still falls back to the workspace pm2.pid below.
    return [];
  }

  try {
    const { stdout } = await execFileAsync('ps', ['-axo', 'pid=,command='], {
      timeout: 1_000,
      maxBuffer: 2 * 1024 * 1024,
    });
    return stdout
      .split(/\r?\n/)
      .flatMap((line) => {
        const match = line.trim().match(/^(\d+)\s+.*PM2.*God Daemon\s+\(([^)]+)\)/i);
        if (!match) {
          return [];
        }
        const pid = Number(match[1]);
        const daemonHome = canonicalizeWorkspacePath(match[2], '/');
        return daemonHome === pm2Home && isAlive(pid) ? [pid] : [];
      })
      .sort((left, right) => left - right);
  } catch {
    return [];
  }
}

async function socketIsAvailable(socketPath: string, timeoutMs = 300): Promise<boolean> {
  if (!(await fileExists(socketPath))) {
    return false;
  }

  return new Promise<boolean>((resolve) => {
    const socket = net.createConnection(socketPath);
    let settled = false;
    const finish = (available: boolean) => {
      if (settled) {
        return;
      }
      settled = true;
      socket.destroy();
      resolve(available);
    };
    socket.once('connect', () => finish(true));
    socket.once('error', () => finish(false));
    socket.setTimeout(timeoutMs, () => finish(false));
  });
}

export async function inspectPm2Workspace(
  root: string,
  env: Record<string, string>,
): Promise<Pm2WorkspaceInspection> {
  const pm2Home = resolveCanonicalPm2Home(root, env.PM2_HOME);
  const pidPath = path.join(pm2Home, 'pm2.pid');
  const socketPath = path.join(pm2Home, 'rpc.sock');
  const pubSocketPath = path.join(pm2Home, 'pub.sock');
  const pidContents = await readText(pidPath);
  const recordedPid = Number(pidContents?.trim());
  const discoveredPids = await discoverPm2DaemonPids(pm2Home);
  if (isAlive(recordedPid) && !discoveredPids.includes(recordedPid)) {
    discoveredPids.push(recordedPid);
    discoveredPids.sort((left, right) => left - right);
  }

  const staleArtifacts: string[] = [];
  if (pidContents !== undefined && !isAlive(recordedPid)) {
    staleArtifacts.push(pidPath);
  }
  const hasRpcSocket = await fileExists(socketPath);
  const hasPubSocket = await fileExists(pubSocketPath);
  const socketAvailable = discoveredPids.length > 0 && await socketIsAvailable(socketPath);
  if (discoveredPids.length === 0 && hasRpcSocket) {
    staleArtifacts.push(socketPath);
  }
  if (discoveredPids.length === 0 && hasPubSocket) {
    staleArtifacts.push(pubSocketPath);
  }

  return {
    pm2Home,
    daemonPids: [...new Set(discoveredPids)],
    socketPath,
    socketAvailable,
    staleArtifacts,
  };
}

async function acquireWorkspaceLock(pm2Home: string): Promise<() => Promise<void>> {
  const lockPath = `${pm2Home}.locallink-init.lock`;
  const ownerPath = path.join(lockPath, 'owner.json');
  await fs.mkdir(path.dirname(lockPath), { recursive: true });
  const startedAt = Date.now();

  while (true) {
    try {
      await fs.mkdir(lockPath);
      await fs.writeFile(
        ownerPath,
        JSON.stringify({ pid: process.pid, createdAt: new Date().toISOString() } satisfies LockOwner),
        'utf8',
      );
      return async () => {
        await fs.rm(lockPath, { recursive: true, force: true });
      };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') {
        throw error;
      }

      const ownerRaw = await readText(ownerPath);
      let owner: LockOwner = {};
      try {
        owner = ownerRaw ? JSON.parse(ownerRaw) as LockOwner : {};
      } catch {
        owner = {};
      }
      const lockStat = await fs.stat(lockPath).catch(() => undefined);
      const lockAge = lockStat ? Date.now() - lockStat.mtimeMs : 0;
      if ((owner.pid && !isAlive(owner.pid)) || (!owner.pid && lockAge > STALE_LOCK_MS)) {
        await fs.rm(lockPath, { recursive: true, force: true });
        continue;
      }
      if (Date.now() - startedAt >= LOCK_TIMEOUT_MS) {
        throw new AppError(
          'PM2_WORKSPACE_LOCK_TIMEOUT',
          `Timed out waiting for the PM2 initialization lock at ${lockPath}.`,
          503,
          { pm2Home, lockPath, owner },
        );
      }
      await new Promise((resolve) => setTimeout(resolve, LOCK_WAIT_MS));
    }
  }
}

export async function withPm2WorkspaceLock<T>(
  root: string,
  env: Record<string, string>,
  options: { allowSpawn: boolean },
  operation: (processEnv: NodeJS.ProcessEnv, inspection: Pm2WorkspaceInspection) => Promise<T>,
): Promise<T | undefined> {
  const processEnv = buildWorkspaceProcessEnv(root, env);
  const pm2Home = String(processEnv.PM2_HOME);
  const release = await acquireWorkspaceLock(pm2Home);
  try {
    const inspection = await inspectPm2Workspace(root, { ...env, PM2_HOME: pm2Home });
    if (inspection.daemonPids.length > 1) {
      throw new AppError(
        'PM2_DUPLICATE_DAEMONS',
        `Multiple PM2 daemons (${inspection.daemonPids.join(', ')}) resolve to ${pm2Home}; LocalLink will not start another.`,
        503,
        inspection,
      );
    }
    if (inspection.daemonPids.length === 1 && !inspection.socketAvailable) {
      throw new AppError(
        'PM2_DAEMON_UNREACHABLE',
        `PM2 daemon ${inspection.daemonPids[0]} owns ${pm2Home}, but its socket is unavailable. LocalLink will not start a replacement daemon.`,
        503,
        inspection,
      );
    }
    if (inspection.daemonPids.length === 0 && inspection.staleArtifacts.length > 0 && options.allowSpawn) {
      throw new AppError(
        'PM2_STALE_DAEMON_STATE',
        `PM2_HOME ${pm2Home} contains stale daemon state. LocalLink will not spawn another daemon until it is reconciled.`,
        503,
        inspection,
      );
    }
    if (inspection.daemonPids.length === 0 && !options.allowSpawn) {
      return undefined;
    }
    const result = await operation(processEnv, inspection);
    const after = await inspectPm2Workspace(root, { ...env, PM2_HOME: pm2Home });
    if (after.daemonPids.length > 1) {
      throw new AppError(
        'PM2_DUPLICATE_DAEMONS',
        `Multiple PM2 daemons (${after.daemonPids.join(', ')}) resolve to ${pm2Home} after initialization.`,
        503,
        after,
      );
    }
    if (after.daemonPids.length === 1 && !after.socketAvailable) {
      throw new AppError(
        'PM2_DAEMON_UNREACHABLE',
        `PM2 daemon ${after.daemonPids[0]} owns ${pm2Home} after initialization, but its socket is unavailable.`,
        503,
        after,
      );
    }
    return result;
  } finally {
    await release();
  }
}
