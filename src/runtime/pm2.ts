import fs from 'node:fs/promises';

import type { ServiceDefinition } from '../shared/contracts';

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

interface ProcessIdentity {
  pid: number;
  parentPid: number;
  startTime: string;
}

async function readProcessIdentity(pid: number): Promise<ProcessIdentity | undefined> {
  try {
    const raw = await fs.readFile(`/proc/${pid}/stat`, 'utf8');
    const closingParenthesis = raw.lastIndexOf(')');
    const fields = raw.slice(closingParenthesis + 2).split(/\s+/);
    return {
      pid,
      parentPid: Number(fields[1]),
      startTime: fields[19] || '',
    };
  } catch {
    return undefined;
  }
}

async function captureProcessTree(rootPids: number[]): Promise<ProcessIdentity[]> {
  if (process.platform !== 'linux') {
    return (await Promise.all(rootPids.map(readProcessIdentity))).filter(
      (identity): identity is ProcessIdentity => identity !== undefined,
    );
  }

  const entries = await fs.readdir('/proc').catch(() => []);
  const identities = (await Promise.all(
    entries.filter((entry) => /^\d+$/.test(entry)).map((entry) => readProcessIdentity(Number(entry))),
  )).filter((identity): identity is ProcessIdentity => identity !== undefined);
  const selected = new Set(rootPids);
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

async function identityIsCurrent(identity: ProcessIdentity): Promise<boolean> {
  const current = await readProcessIdentity(identity.pid);
  return current?.startTime === identity.startTime;
}

async function waitForProcessTreeExit(identities: ProcessIdentity[], timeoutMs: number): Promise<ProcessIdentity[]> {
  const deadline = Date.now() + timeoutMs;
  let remaining = identities;
  while (remaining.length > 0 && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 50));
    remaining = (await Promise.all(remaining.map(async (identity) => (
      await identityIsCurrent(identity) ? identity : undefined
    )))).filter((identity): identity is ProcessIdentity => identity !== undefined);
  }
  return remaining;
}

export async function stopObsoletePm2ProcessTree(rootPids: number[]): Promise<void> {
  const safeRootPids = [...new Set(rootPids)].filter(
    (pid) => Number.isInteger(pid) && pid > 1 && pid !== process.pid,
  );
  if (safeRootPids.length === 0) {
    return;
  }

  const captured = await captureProcessTree(safeRootPids);
  let remaining = await waitForProcessTreeExit(captured, 500);
  for (const identity of remaining.sort((left, right) => right.pid - left.pid)) {
    if (await identityIsCurrent(identity)) {
      try {
        process.kill(identity.pid, 'SIGTERM');
      } catch {
        // The process exited between identity verification and the signal.
      }
    }
  }
  remaining = await waitForProcessTreeExit(remaining, 1_000);
  for (const identity of remaining.sort((left, right) => right.pid - left.pid)) {
    if (await identityIsCurrent(identity)) {
      try {
        process.kill(identity.pid, 'SIGKILL');
      } catch {
        // The process exited between identity verification and the signal.
      }
    }
  }
}
