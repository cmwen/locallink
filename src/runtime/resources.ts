import os from 'node:os';

import type {
  ProcessInspection,
  ProcessTerminationResult,
  ProcessTerminationReview,
  ResourceDashboard,
  ResourceProcess,
  ServiceDefinition,
} from '../shared/contracts';
import { AppError } from '../shared/errors';
import { formatDurationFromSeconds, parseJsonOutput, runCommand, type CommandRunner } from '../shared/utils';

interface ParsedProcessRow {
  pid: number;
  parentPid: number;
  cpuPercent: number;
  memoryMb: number;
  elapsedSeconds: number;
  name: string;
  command: string;
}

interface Pm2ResourceRow {
  name?: string;
  pid?: number;
  pm_id?: number;
  pm2_env?: { name?: string; pm_exec_path?: string; pm_cwd?: string };
}

const PROCESS_SIGNALS = ['SIGTERM', 'SIGKILL'] as const;
const RESOURCE_HISTORY_LIMIT = 36;
const RESOURCE_SAMPLE_INTERVAL_SECONDS = 5;

interface CpuTimes {
  idle: number;
  total: number;
}

interface PressureSnapshot {
  cpuPercent: number;
  cpuCores: number;
  loadAverage: number[];
  memoryUsedMb: number;
  memoryTotalMb: number;
  memoryPercent: number;
  updatedAt: string;
}

let previousCpuTimes: CpuTimes | undefined;
let latestPressure: PressureSnapshot | undefined;
const resourceHistory: ResourceDashboard['history'] = [];

function clampPercent(value: number): number {
  return Math.min(100, Math.max(0, value));
}

function roundToOne(value: number): number {
  return Math.round(value * 10) / 10;
}

function readCpuTimes(): CpuTimes {
  return os.cpus().reduce<CpuTimes>(
    (totals, cpu) => {
      const values = Object.values(cpu.times);
      return {
        idle: totals.idle + cpu.times.idle,
        total: totals.total + values.reduce((sum, value) => sum + value, 0),
      };
    },
    { idle: 0, total: 0 },
  );
}

function sampleCpuPercent(cpuCores: number, loadAverage: number[]): number {
  const current = readCpuTimes();
  const previous = previousCpuTimes;
  previousCpuTimes = current;

  if (previous) {
    const idleDelta = current.idle - previous.idle;
    const totalDelta = current.total - previous.total;
    if (totalDelta > 0) {
      return roundToOne(clampPercent(100 - (idleDelta / totalDelta) * 100));
    }
  }

  return roundToOne(clampPercent((loadAverage[0] / Math.max(1, cpuCores)) * 100));
}

function formatMemoryTotal(memoryMb: number): string {
  if (memoryMb >= 1024) {
    return `${(memoryMb / 1024).toFixed(1)} GB`;
  }
  return `${memoryMb} MB`;
}

function collectPressureSample(): PressureSnapshot {
  const cpuCores = Math.max(1, os.cpus().length);
  const loadAverage = os.loadavg().map(roundToOne);
  const memoryTotalMb = Math.max(1, Math.round(os.totalmem() / 1024 / 1024));
  const memoryUsedMb = Math.max(0, memoryTotalMb - Math.round(os.freemem() / 1024 / 1024));
  const cpuPercent = sampleCpuPercent(cpuCores, loadAverage);
  const memoryPercent = roundToOne(clampPercent((memoryUsedMb / memoryTotalMb) * 100));
  const previousTimestamp = Date.parse(resourceHistory.at(-1)?.timestamp || '');
  const updatedAt = new Date(Math.max(Date.now(), Number.isFinite(previousTimestamp) ? previousTimestamp + 1 : 0)).toISOString();

  latestPressure = {
    cpuPercent,
    cpuCores,
    loadAverage,
    memoryUsedMb,
    memoryTotalMb,
    memoryPercent,
    updatedAt,
  };
  resourceHistory.push({
    timestamp: updatedAt,
    cpuPercent,
    memoryPercent,
  });
  if (resourceHistory.length > RESOURCE_HISTORY_LIMIT) {
    resourceHistory.splice(0, resourceHistory.length - RESOURCE_HISTORY_LIMIT);
  }

  return latestPressure;
}

function uniqueProcesses(processes: ResourceProcess[]): ResourceProcess[] {
  const seen = new Set<number>();
  return processes.filter((process) => {
    if (seen.has(process.pid)) {
      return false;
    }
    seen.add(process.pid);
    return true;
  });
}

collectPressureSample();
const pressureTimer = setInterval(collectPressureSample, RESOURCE_SAMPLE_INTERVAL_SECONDS * 1000);
pressureTimer.unref();

function parseProcessRow(line: string): ParsedProcessRow | null {
  const match = line.trim().match(/^(\d+)\s+(\d+)\s+([\d.]+)\s+(\d+)\s+(\d+)\s+(\S+)\s+(.+)$/);
  if (!match) {
    return null;
  }

  const [, pid, parentPid, cpuPercent, rssKb, elapsedSeconds, name, command] = match;
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

function buildResourceProcess(row: ParsedProcessRow, attribution?: Partial<ResourceProcess>): ResourceProcess {
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
    runtime: 'system',
    workspaceOwned: false,
    attributionConfidence: 'unknown',
    ...attribution,
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
  definitions: ServiceDefinition[] = [],
): Promise<ResourceDashboard> {
  const result = await commandRunner(
    'ps',
    ['-eo', 'pid=,ppid=,pcpu=,rss=,etimes=,comm=,args=', '--sort=-pcpu'],
    { timeoutMs: 1_500 },
  );

  const allRows = result.ok
    ? result.stdout
        .split(/\r?\n/)
        .map((line) => parseProcessRow(line))
        .filter((row): row is ParsedProcessRow => row !== null)
        .filter((row) => row.name !== 'ps' && !row.command.startsWith('ps -eo '))
    : [];
  const pm2Result = definitions.some((definition) => definition.runtime === 'pm2')
    ? await commandRunner('pm2', ['jlist'], { timeoutMs: 1_200 })
    : undefined;
  const pm2Rows = pm2Result?.ok ? parseJsonOutput<Pm2ResourceRow>(pm2Result.stdout) : [];
  const attributed = allRows.map((row) => {
    const command = row.command.toLowerCase();
    const matchingPm2 = pm2Rows.find((candidate) => Number(candidate.pid) === row.pid);
    const pm2Definition = matchingPm2
      ? definitions.find((candidate) => candidate.runtime === 'pm2' && [candidate.name, candidate.runtimeName, candidate.taskName]
        .filter(Boolean)
        .some((needle) => needle!.toLowerCase() === String(matchingPm2.name || matchingPm2.pm2_env?.name || '').toLowerCase()))
      : undefined;
    const definition = pm2Definition || definitions.find((candidate) => {
      const needles = [candidate.name, candidate.runtimeName, candidate.taskName, candidate.windowsProcessName, candidate.script, candidate.cwd]
        .filter(Boolean)
        .map((value) => value!.toLowerCase());
      return needles.some((needle) => needle.length > 2 && command.includes(needle));
    });
    return definition
      ? buildResourceProcess(row, {
            serviceId: definition.id,
            serviceName: definition.name,
            runtime: definition.runtime || 'system',
            workspaceOwned: true,
            attributionConfidence: pm2Definition ? 'exact' : 'heuristic',
          })
      : buildResourceProcess(row);
  });
  const workspaceProcesses = definitions.length === 0
    ? attributed.map((process) => ({ ...process, workspaceOwned: true, attributionConfidence: 'unknown' as const }))
    : attributed.filter((process) => process.workspaceOwned);
  const topCpu = [...attributed].sort((left, right) => right.cpuPercent - left.cpuPercent).slice(0, 5);
  const topMemory = [...attributed].sort((left, right) => right.memoryMb - left.memoryMb).slice(0, 5);
  const processes = uniqueProcesses([...topCpu, ...topMemory]);
  const flagged = attributed.filter((process) => process.tone === 'warn').length;
  const pressure = latestPressure || collectPressureSample();

  return {
    scope: 'host',
    scopeNote: 'Host-wide pressure includes all visible processes. Workspace attribution is retained on matching processes so local services can still be identified in the rankings.',
    summary: [
      {
        label: 'Host CPU',
        value: `${pressure.cpuPercent.toFixed(1)}%`,
        detail: `${pressure.cpuCores} logical cores / load ${pressure.loadAverage[0]?.toFixed(1) || '0.0'}`,
      },
      {
        label: 'Host memory',
        value: `${pressure.memoryPercent.toFixed(1)}%`,
        detail: `${formatMemoryTotal(pressure.memoryUsedMb)} of ${formatMemoryTotal(pressure.memoryTotalMb)}`,
      },
      {
        label: 'Processes',
        value: String(attributed.length),
        detail: 'Visible to the LocalLink host',
      },
      {
        label: 'Review',
        value: String(flagged),
        detail: 'Above 40% CPU or 512 MB RAM',
      },
    ],
    system: {
      ...pressure,
      processCount: attributed.length,
      flaggedCount: flagged,
      sampleIntervalSeconds: RESOURCE_SAMPLE_INTERVAL_SECONDS,
    },
    history: [...resourceHistory],
    topCpu,
    topMemory,
    processes,
    workspaceProcesses,
    hostProcesses: attributed,
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
    // ps exposes elapsed runtime here; minute granularity keeps the token stable while a modal is open.
    identityToken: `${row.pid}:${row.name}:${Math.floor(row.elapsedSeconds / 60)}:${row.command}`,
  };
}

export async function reviewProcessTermination(
  pid: number,
  commandRunner: CommandRunner = runCommand,
): Promise<ProcessTerminationReview> {
  const inspection = await inspectProcess(pid, commandRunner);
  const protectedProcess = pid <= 1 || pid === process.pid;
  const warnings: string[] = [];
  if (protectedProcess) warnings.push('This process is protected by LocalLink.');
  if (!inspection.workspaceOwned) warnings.push('This process is not confidently attributed to the current workspace.');
  if (inspection.parentPid > 1) warnings.push(`Parent process ${inspection.parentPid} may restart or replace it.`);

  const processTable = await commandRunner(
    'ps',
    ['-eo', 'pid=,ppid=,pcpu=,rss=,etimes=,comm=,args='],
    { timeoutMs: 1_500 },
  );
  const dependents = processTable.ok
    ? processTable.stdout
        .split(/\r?\n/)
        .map((line) => parseProcessRow(line))
        .filter((row): row is ParsedProcessRow => row !== null)
        .filter((process) => process.pid !== pid && process.parentPid === pid)
        .map((process) => `${process.name} (PID ${process.pid})`)
    : [];
  if (dependents.length > 0) warnings.push(`${dependents.length} child process${dependents.length === 1 ? '' : 'es'} will remain running.`);

  const portResult = await commandRunner('lsof', ['-nP', '-a', '-p', String(pid), '-i'], { timeoutMs: 1_000 });
  const ports = portResult.ok
    ? [...portResult.stdout.matchAll(/(?:TCP|UDP)\s+\S+?:(\d+)(?:->|\s)/g)].map((match) => match[1]).filter(Boolean).map((port) => `:${port}`)
    : [];
  if (ports.length > 0) warnings.push(`Open network bindings detected: ${ports.join(', ')}.`);

  return {
    pid,
    identityToken: inspection.identityToken,
    name: inspection.name,
    command: inspection.command,
    parentPid: inspection.parentPid,
    started: inspection.started,
    workspaceOwned: Boolean(inspection.workspaceOwned),
    protected: protectedProcess,
    canTerminate: !protectedProcess,
    requiresConfirmation: true,
    warnings,
    dependents,
    ports,
    reviewedAt: new Date().toISOString(),
  };
}

export async function terminateProcess(
  pid: number,
  signal: string = 'SIGTERM',
  identityToken?: string,
  commandRunner: CommandRunner = runCommand,
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

  const review = await reviewProcessTermination(pid, commandRunner);
  if (identityToken && review.identityToken !== identityToken) {
    throw new AppError('PROCESS_CHANGED', `Process ${pid} changed since it was reviewed. Inspect it again before terminating.`, 409);
  }
  if (!review.canTerminate) {
    throw new AppError('PROTECTED_PROCESS', `Process ${pid} is protected and cannot be terminated from LocalLink.`, 400);
  }

  try {
    process.kill(pid, signal as NodeJS.Signals);
    return {
      pid,
      signal,
      ok: true,
      message: `Process ${pid} was sent ${signal}.`,
      identityToken: review.identityToken,
      reviewedAt: review.reviewedAt,
    };
  } catch (error) {
    throw new AppError(
      'PROCESS_TERMINATE_FAILED',
      error instanceof Error ? error.message : `Process ${pid} could not be terminated.`,
      500,
    );
  }
}
