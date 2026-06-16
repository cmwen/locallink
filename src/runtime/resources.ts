import type { ProcessInspection, ProcessTerminationResult, ResourceDashboard, ResourceProcess } from '../shared/contracts';
import { AppError } from '../shared/errors';
import { formatDurationFromSeconds, runCommand, type CommandRunner } from '../shared/utils';

interface ParsedProcessRow {
  pid: number;
  parentPid: number;
  cpuPercent: number;
  memoryMb: number;
  elapsedSeconds: number;
  name: string;
  command: string;
}

const PROCESS_SIGNALS = ['SIGTERM', 'SIGKILL'] as const;

function parseProcessRow(line: string): ParsedProcessRow | null {
  const parts = line.trim().split(/\s+/, 7);
  if (parts.length < 7) {
    return null;
  }

  const [pid, parentPid, cpuPercent, rssKb, elapsedSeconds, name, command] = parts;
  const parsedPid = Number(pid);
  const parsedParentPid = Number(parentPid);
  const parsedCpu = Number(cpuPercent);
  const parsedRssKb = Number(rssKb);
  const parsedElapsedSeconds = Number(elapsedSeconds);

  if (
    !Number.isFinite(parsedPid) ||
    !Number.isFinite(parsedParentPid) ||
    !Number.isFinite(parsedCpu) ||
    !Number.isFinite(parsedRssKb) ||
    !Number.isFinite(parsedElapsedSeconds)
  ) {
    return null;
  }

  return {
    pid: parsedPid,
    parentPid: parsedParentPid,
    cpuPercent: parsedCpu,
    memoryMb: Math.max(0, Math.round(parsedRssKb / 1024)),
    elapsedSeconds: parsedElapsedSeconds,
    name,
    command,
  };
}

function buildResourceProcess(row: ParsedProcessRow): ResourceProcess {
  const reasons: string[] = [];
  if (row.cpuPercent >= 40) {
    reasons.push('High CPU');
  }
  if (row.memoryMb >= 512) {
    reasons.push('High RAM');
  }

  return {
    pid: row.pid,
    name: row.name,
    command: row.command,
    cpu: `${row.cpuPercent.toFixed(1)}%`,
    cpuPercent: row.cpuPercent,
    memory: `${row.memoryMb} MB`,
    memoryMb: row.memoryMb,
    uptime: formatDurationFromSeconds(row.elapsedSeconds),
    tone: reasons.length > 0 ? 'warn' : 'healthy',
    reason: reasons.join(' · ') || 'Normal',
  };
}

export function parseProcessTable(stdout: string): ResourceProcess[] {
  return stdout
    .split(/\r?\n/)
    .map((line) => parseProcessRow(line))
    .filter((row): row is ParsedProcessRow => row !== null)
    .map((row) => buildResourceProcess(row));
}

export async function buildResourceDashboard(
  commandRunner: CommandRunner = runCommand,
): Promise<ResourceDashboard> {
  const result = await commandRunner(
    'ps',
    ['-eo', 'pid=,ppid=,pcpu=,rss=,etimes=,comm=,args=', '--sort=-pcpu'],
    { timeoutMs: 1_500 },
  );

  const processes = result.ok ? parseProcessTable(result.stdout).slice(0, 12) : [];
  const topCpu = [...processes].sort((left, right) => right.cpuPercent - left.cpuPercent)[0];
  const topMemory = [...processes].sort((left, right) => right.memoryMb - left.memoryMb)[0];
  const flagged = processes.filter((process) => process.tone === 'warn').length;

  return {
    summary: [
      {
        label: 'Tracked processes',
        value: String(processes.length),
        detail: 'Top CPU consumers right now',
      },
      {
        label: 'Top CPU',
        value: topCpu?.cpu || '—',
        detail: topCpu ? `${topCpu.name} (PID ${topCpu.pid})` : 'No process data',
      },
      {
        label: 'Top RAM',
        value: topMemory?.memory || '—',
        detail: topMemory ? `${topMemory.name} (PID ${topMemory.pid})` : 'No process data',
      },
      {
        label: 'Flagged',
        value: String(flagged),
        detail: 'Processes above CPU or RAM thresholds',
      },
    ],
    processes,
  };
}

export async function inspectProcess(
  pid: number,
  commandRunner: CommandRunner = runCommand,
): Promise<ProcessInspection> {
  if (!Number.isInteger(pid) || pid <= 0) {
    throw new AppError('INVALID_PID', 'A valid positive PID is required.', 400);
  }

  const result = await commandRunner(
    'ps',
    ['-p', String(pid), '-o', 'pid=,ppid=,pcpu=,rss=,etimes=,comm=,args='],
    { timeoutMs: 1_500 },
  );
  if (!result.ok) {
    throw new AppError('PROCESS_NOT_FOUND', `Process ${pid} could not be inspected.`, 404);
  }

  const row = result.stdout
    .split(/\r?\n/)
    .map((line) => parseProcessRow(line))
    .find((entry): entry is ParsedProcessRow => entry !== null);
  if (!row) {
    throw new AppError('PROCESS_NOT_FOUND', `Process ${pid} could not be inspected.`, 404);
  }

  return {
    pid: row.pid,
    parentPid: row.parentPid,
    name: row.name,
    command: row.command,
    cpu: `${row.cpuPercent.toFixed(1)}%`,
    cpuPercent: row.cpuPercent,
    memory: `${row.memoryMb} MB`,
    memoryMb: row.memoryMb,
    uptime: formatDurationFromSeconds(row.elapsedSeconds),
    started: new Date(Date.now() - row.elapsedSeconds * 1000).toLocaleString(),
  };
}

export async function terminateProcess(
  pid: number,
  signal: string = 'SIGTERM',
): Promise<ProcessTerminationResult> {
  if (!Number.isInteger(pid) || pid <= 0) {
    throw new AppError('INVALID_PID', 'A valid positive PID is required.', 400);
  }

  if (!PROCESS_SIGNALS.includes(signal as (typeof PROCESS_SIGNALS)[number])) {
    throw new AppError('INVALID_SIGNAL', `Unsupported signal "${signal}".`, 400);
  }

  if (pid <= 1 || pid === process.pid) {
    throw new AppError('PROTECTED_PROCESS', `Process ${pid} is protected and cannot be terminated from LocalLink.`, 400);
  }

  try {
    process.kill(pid, signal as NodeJS.Signals);
    return {
      pid,
      signal,
      ok: true,
      message: `Process ${pid} was sent ${signal}.`,
    };
  } catch (error) {
    throw new AppError(
      'PROCESS_TERMINATE_FAILED',
      error instanceof Error ? error.message : `Process ${pid} could not be terminated.`,
      500,
    );
  }
}
