import { execFile } from 'node:child_process';
import fs from 'node:fs/promises';
import { promisify } from 'node:util';

import type { ServiceDefinition } from '../shared/contracts';

const execFileAsync = promisify(execFile);

export interface Pm2Row {
  name?: string;
  pid?: number;
  monit?: {
    cpu?: number;
    memory?: number;
  };
  pm2_env?: {
    name?: string;
    status?: string;
    pm_uptime?: number;
  };
}

export function selectPm2Row(definition: ServiceDefinition, rows: Pm2Row[]): Pm2Row | undefined {
  const candidateNames = [definition.runtimeName, definition.name].filter(
    (value, index, values): value is string => !!value && values.indexOf(value) === index,
  );

  for (const candidateName of candidateNames) {
    const row = rows.find((entry) => entry.name === candidateName);
    if (row) {
      return row;
    }
  }

  return undefined;
}

export interface Pm2ProcessIdentity {
  pid: number;
  parentPid: number;
  state: string;
  startTime: string;
}

export interface Pm2ProcessTreeStopResult {
  capturedPids: number[];
  remainingPids: number[];
}

async function readProcessIdentity(pid: number): Promise<Pm2ProcessIdentity | undefined> {
  if (process.platform === 'win32') {
    try {
      const command = [
        `$p=Get-CimInstance Win32_Process -Filter "ProcessId=${pid}"`,
        'if($p){$p|Select-Object ProcessId,ParentProcessId,CreationDate|ConvertTo-Json -Compress}',
      ].join(';');
      const { stdout } = await execFileAsync(
        'powershell.exe',
        ['-NoProfile', '-NonInteractive', '-Command', command],
        { timeout: 1_000 },
      );
      const row = JSON.parse(stdout.trim()) as {
        ProcessId?: number;
        ParentProcessId?: number;
        CreationDate?: string;
      };
      return row.ProcessId
        ? {
            pid: row.ProcessId,
            parentPid: Number(row.ParentProcessId) || 0,
            state: 'R',
            startTime: row.CreationDate || '',
          }
        : undefined;
    } catch {
      return undefined;
    }
  }
  if (process.platform !== 'linux') {
    try {
      const { stdout } = await execFileAsync(
        'ps',
        ['-o', 'ppid=,state=,lstart=', '-p', String(pid)],
        { timeout: 1_000 },
      );
      const match = stdout.trim().match(/^(\d+)\s+(\S+)\s+(.+)$/);
      return match
        ? {
            pid,
            parentPid: Number(match[1]),
            state: match[2],
            startTime: match[3],
          }
        : undefined;
    } catch {
      return undefined;
    }
  }
  try {
    const raw = await fs.readFile(`/proc/${pid}/stat`, 'utf8');
    const closingParenthesis = raw.lastIndexOf(')');
    const fields = raw.slice(closingParenthesis + 2).split(/\s+/);
    return {
      pid,
      parentPid: Number(fields[1]),
      state: fields[0] || '',
      startTime: fields[19] || '',
    };
  } catch {
    return undefined;
  }
}

export async function captureObsoletePm2ProcessTree(rootPids: number[]): Promise<Pm2ProcessIdentity[]> {
  const safeRootPids = [...new Set(rootPids)].filter(
    (pid) => Number.isInteger(pid) && pid > 1 && pid !== process.pid,
  );
  if (safeRootPids.length === 0) {
    return [];
  }

  let identities: Pm2ProcessIdentity[];
  if (process.platform === 'linux') {
    const entries = await fs.readdir('/proc').catch(() => []);
    identities = (await Promise.all(
      entries.filter((entry) => /^\d+$/.test(entry)).map((entry) => readProcessIdentity(Number(entry))),
    )).filter((identity): identity is Pm2ProcessIdentity => identity !== undefined);
  } else if (process.platform === 'win32') {
    try {
      const command = [
        'Get-CimInstance Win32_Process',
        'Select-Object ProcessId,ParentProcessId,CreationDate',
        'ConvertTo-Json -Compress',
      ].join('|');
      const { stdout } = await execFileAsync(
        'powershell.exe',
        ['-NoProfile', '-NonInteractive', '-Command', command],
        { timeout: 2_000, maxBuffer: 4 * 1024 * 1024 },
      );
      const parsed = JSON.parse(stdout.trim()) as {
        ProcessId?: number;
        ParentProcessId?: number;
        CreationDate?: string;
      } | Array<{
        ProcessId?: number;
        ParentProcessId?: number;
        CreationDate?: string;
      }>;
      identities = (Array.isArray(parsed) ? parsed : [parsed]).flatMap((row) => row.ProcessId
        ? [{
            pid: row.ProcessId,
            parentPid: Number(row.ParentProcessId) || 0,
            state: 'R',
            startTime: row.CreationDate || '',
          }]
        : []);
    } catch {
      identities = [];
    }
  } else {
    try {
      const { stdout } = await execFileAsync(
        'ps',
        ['-axo', 'pid=,ppid=,state=,lstart='],
        { timeout: 2_000, maxBuffer: 4 * 1024 * 1024 },
      );
      identities = stdout.split(/\r?\n/).flatMap((line) => {
        const match = line.trim().match(/^(\d+)\s+(\d+)\s+(\S+)\s+(.+)$/);
        return match
          ? [{
              pid: Number(match[1]),
              parentPid: Number(match[2]),
              state: match[3],
              startTime: match[4],
            }]
          : [];
      });
    } catch {
      identities = [];
    }
  }

  const selected = new Set(safeRootPids);
  let changed = true;
  while (changed) {
    changed = false;
    for (const identity of identities) {
      if (selected.has(identity.parentPid) && !selected.has(identity.pid)) {
        selected.add(identity.pid);
        changed = true;
      }
    }
  }
  return identities.filter((identity) => selected.has(identity.pid) && identity.pid !== process.pid);
}

async function identityIsCurrent(identity: Pm2ProcessIdentity): Promise<boolean> {
  const current = await readProcessIdentity(identity.pid);
  return current?.startTime === identity.startTime && current.state !== 'Z';
}

async function waitForProcessTreeExit(
  identities: Pm2ProcessIdentity[],
  timeoutMs: number,
): Promise<Pm2ProcessIdentity[]> {
  const deadline = Date.now() + timeoutMs;
  let remaining = identities;
  while (remaining.length > 0 && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 50));
    remaining = (await Promise.all(remaining.map(async (identity) => (
      await identityIsCurrent(identity) ? identity : undefined
    )))).filter((identity): identity is Pm2ProcessIdentity => identity !== undefined);
  }
  return remaining;
}

export async function stopObsoletePm2ProcessTree(
  captured: Pm2ProcessIdentity[],
): Promise<Pm2ProcessTreeStopResult> {
  if (captured.length === 0) {
    return { capturedPids: [], remainingPids: [] };
  }

  let remaining = await waitForProcessTreeExit(captured, 500);
  const depths = new Map<number, number>();
  const identitiesByPid = new Map(captured.map((identity) => [identity.pid, identity]));
  const depthOf = (identity: Pm2ProcessIdentity): number => {
    const known = depths.get(identity.pid);
    if (known !== undefined) {
      return known;
    }
    const parent = identitiesByPid.get(identity.parentPid);
    const depth = parent ? depthOf(parent) + 1 : 0;
    depths.set(identity.pid, depth);
    return depth;
  };
  const deepestFirst = (left: Pm2ProcessIdentity, right: Pm2ProcessIdentity) => (
    depthOf(right) - depthOf(left) || right.pid - left.pid
  );

  for (const identity of remaining.sort(deepestFirst)) {
    if (await identityIsCurrent(identity)) {
      try {
        process.kill(identity.pid, 'SIGTERM');
      } catch {
        // The process exited between identity verification and the signal.
      }
    }
  }
  remaining = await waitForProcessTreeExit(remaining, 1_000);
  for (const identity of remaining.sort(deepestFirst)) {
    if (await identityIsCurrent(identity)) {
      try {
        process.kill(identity.pid, 'SIGKILL');
      } catch {
        // The process exited between identity verification and the signal.
      }
    }
  }
  remaining = await waitForProcessTreeExit(remaining, 500);
  return {
    capturedPids: captured.map((identity) => identity.pid),
    remainingPids: remaining.map((identity) => identity.pid),
  };
}
