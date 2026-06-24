import fs from 'node:fs/promises';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';

import { ConfigRepository } from '../config/files';
import { LogBroker } from '../logs/broker';
import { enrichServiceDefinition } from './lego';
import { PortAllocator } from '../ports/allocator';
import { ToolManager } from '../tools/manager';
import { buildExtensionWorkspace } from './extensions';
import { buildPhase2Advisor } from './phase2';
import { selectPm2Row, type Pm2Row } from './pm2';
import { buildResourceDashboard } from './resources';
import { normalizeLoopbackBindHost } from '../shared/network';
import type {
  DashboardState,
  LogEntry,
  ServiceDefinition,
  ServiceRecord,
  StartupDiagnostics,
} from '../shared/contracts';
import { formatFatalError } from '../shared/errors';
import {
  type CommandRunner,
  formatDurationFromTimestamp,
  formatMemory,
  parseCsvLine,
  parseJsonOutput,
  runCommand,
} from '../shared/utils';
import { logDebug, logWarn } from '../shared/logger';

interface DockerPsRow {
  ID?: string;
  Name?: string;
  Names?: string;
  Service?: string;
  State?: string;
  Status?: string;
  RunningFor?: string;
}

interface DockerStatsRow {
  Name?: string;
  CPUPerc?: string;
  MemUsage?: string;
}

type RuntimeState = Pick<ServiceRecord, 'status' | 'statusLabel' | 'statusTone' | 'cpu' | 'memory' | 'uptime'>;

function stoppedRuntimeState(group: ServiceDefinition['group']): RuntimeState {
  return {
    status: 'stopped',
    statusLabel: 'Down',
    statusTone: 'off',
    cpu: group === 'windows' ? '—' : '0%',
    memory: group === 'windows' ? '—' : '0 MB',
    uptime: '—',
  };
}

function unknownRuntimeState(): RuntimeState {
  return {
    status: 'unknown',
    statusLabel: 'Unknown',
    statusTone: 'warn',
    cpu: '—',
    memory: '—',
    uptime: '—',
  };
}

function restartingRuntimeState(cpu: string, memory: string, uptime: string): RuntimeState {
  return {
    status: 'degraded',
    statusLabel: 'Restarting',
    statusTone: 'warn',
    cpu,
    memory,
    uptime,
  };
}

function runningRuntimeState(cpu: string, memory: string, uptime: string): RuntimeState {
  return {
    status: 'running',
    statusLabel: 'Up',
    statusTone: 'healthy',
    cpu,
    memory,
    uptime,
  };
}

function portReachableRuntimeState(current: RuntimeState): RuntimeState {
  return {
    ...current,
    status: 'running',
    statusLabel: 'Up',
    statusTone: 'healthy',
  };
}

async function fileExists(filePath: string): Promise<boolean> {
  try {
    await fs.access(filePath);
    return true;
  } catch {
    return false;
  }
}

function lineOrDefault(value: string | undefined, fallback: string): string {
  return value && value.trim() ? value.trim() : fallback;
}

function isRestartingState(value: string | undefined): boolean {
  return /restart|launch|starting|stopping|initializing/i.test(value ?? '');
}

function parsePort(value: string | undefined): number | undefined {
  if (!value || value === '—') {
    return undefined;
  }

  const port = Number(value);
  if (!Number.isInteger(port) || port < 1 || port > 65_535) {
    return undefined;
  }

  return port;
}

function isTcpPortReachable(host: string, port: number, timeoutMs = 350): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = net.createConnection({ host, port });
    let settled = false;
    const finish = (reachable: boolean) => {
      if (settled) {
        return;
      }
      settled = true;
      socket.destroy();
      resolve(reachable);
    };

    socket.setTimeout(timeoutMs);
    socket.once('connect', () => finish(true));
    socket.once('timeout', () => finish(false));
    socket.once('error', () => finish(false));
  });
}

async function collectDockerStates(
  root: string,
  definitions: ServiceDefinition[],
  commandRunner: CommandRunner,
): Promise<Map<string, RuntimeState>> {
  const dockerDefinitions = definitions.filter((definition) => definition.group === 'docker');
  const stateMap = new Map<string, RuntimeState>();
  if (dockerDefinitions.length === 0) {
    return stateMap;
  }

  const [psResult, statsResult] = await Promise.all([
    commandRunner('docker', ['compose', 'ps', '--all', '--format', 'json'], {
      cwd: root,
      timeoutMs: 1200,
    }),
    commandRunner('docker', ['stats', '--no-stream', '--format', '{{json .}}'], {
      cwd: root,
      timeoutMs: 1200,
    }),
  ]);

  if (!psResult.ok) {
    logWarn('Docker state probe failed; marking Docker services unknown.', {
      workspaceRoot: root,
      stderr: psResult.stderr || psResult.error || 'No docker compose output',
    });
    for (const definition of dockerDefinitions) {
      stateMap.set(definition.id, unknownRuntimeState());
    }
    return stateMap;
  }

  const psOutput = psResult.stdout.trim();
  const psRows = parseJsonOutput<DockerPsRow>(psResult.stdout);
  if (psOutput && psOutput !== '[]' && psRows.length === 0) {
    logWarn('Docker state probe returned unreadable output; marking Docker services unknown.', {
      workspaceRoot: root,
    });
    for (const definition of dockerDefinitions) {
      stateMap.set(definition.id, unknownRuntimeState());
    }
    return stateMap;
  }

  const statsRows = statsResult.ok ? parseJsonOutput<DockerStatsRow>(statsResult.stdout) : [];

  for (const definition of dockerDefinitions) {
    const runtimeName = definition.runtimeName?.toLowerCase() ?? definition.name.toLowerCase();
    const psRow = psRows.find((row) => {
      const service = row.Service?.toLowerCase();
      const name = row.Name?.toLowerCase() || row.Names?.toLowerCase();
      return service === runtimeName || name?.includes(runtimeName) || name?.includes(definition.name.toLowerCase());
    });

    if (!psRow) {
      stateMap.set(definition.id, stoppedRuntimeState(definition.group));
      continue;
    }

    const statsRow = statsRows.find((row) => {
      const name = row.Name?.toLowerCase();
      return !!name && ((psRow.Name || psRow.Names) ? name.includes((psRow.Name || psRow.Names || '').toLowerCase()) : false);
    });

    const rawState = (psRow.State || psRow.Status || '').toLowerCase();
    const running = rawState.includes('running');
    stateMap.set(
      definition.id,
      running
        ? runningRuntimeState(
            lineOrDefault(statsRow?.CPUPerc, '—'),
            lineOrDefault(statsRow?.MemUsage?.split('/')[0], '—'),
            lineOrDefault(psRow.RunningFor, '—'),
          )
        : isRestartingState(rawState)
          ? restartingRuntimeState(
              lineOrDefault(statsRow?.CPUPerc, '—'),
              lineOrDefault(statsRow?.MemUsage?.split('/')[0], '—'),
              lineOrDefault(psRow.RunningFor, '—'),
            )
          : stoppedRuntimeState(definition.group),
    );
  }

  return stateMap;
}

async function collectPm2States(
  definitions: ServiceDefinition[],
  commandRunner: CommandRunner,
): Promise<Map<string, RuntimeState>> {
  const pm2Definitions = definitions.filter(
    (definition) => definition.runtime === 'pm2' && (definition.group === 'pm2' || definition.group === 'pwa'),
  );
  const stateMap = new Map<string, RuntimeState>();
  if (pm2Definitions.length === 0) {
    return stateMap;
  }

  const result = await commandRunner('pm2', ['jlist'], {
    timeoutMs: 1200,
  });
  if (!result.ok) {
    logWarn('PM2 state probe failed; marking PM2 services unknown.', {
      stderr: result.stderr || result.error || 'No PM2 output',
    });
    for (const definition of pm2Definitions) {
      stateMap.set(definition.id, unknownRuntimeState());
    }
    return stateMap;
  }

  const resultOutput = result.stdout.trim();
  const rows = parseJsonOutput<Pm2Row>(result.stdout);
  if (resultOutput && resultOutput !== '[]' && rows.length === 0) {
    logWarn('PM2 state probe returned unreadable output; marking PM2 services unknown.', {});
    for (const definition of pm2Definitions) {
      stateMap.set(definition.id, unknownRuntimeState());
    }
    return stateMap;
  }

  for (const definition of pm2Definitions) {
    const row = selectPm2Row(definition, rows);
    if (!row) {
      stateMap.set(definition.id, stoppedRuntimeState(definition.group));
      continue;
    }

    const status = row.pm2_env?.status ?? 'stopped';
    const cpu = `${row.monit?.cpu ?? 0}%`;
    const memory = formatMemory(row.monit?.memory ?? 0);
    const uptime = formatDurationFromTimestamp(row.pm2_env?.pm_uptime);
    if (status === 'online') {
      stateMap.set(
        definition.id,
        runningRuntimeState(cpu, memory, uptime),
      );
      continue;
    }

    stateMap.set(
      definition.id,
      isRestartingState(status) ? restartingRuntimeState(cpu, memory, uptime) : stoppedRuntimeState(definition.group),
    );
  }

  return stateMap;
}

async function collectWindowsStates(
  definitions: ServiceDefinition[],
  commandRunner: CommandRunner,
): Promise<Map<string, RuntimeState>> {
  const windowsDefinitions = definitions.filter((definition) => definition.group === 'windows');
  const stateMap = new Map<string, RuntimeState>();
  if (windowsDefinitions.length === 0) {
    return stateMap;
  }

  const isWsl = Boolean(process.env.WSL_INTEROP) || os.release().toLowerCase().includes('microsoft');
  if (!isWsl) {
    logDebug('Windows process probing is unavailable outside WSL; marking Windows services unknown.');
    for (const definition of windowsDefinitions) {
      stateMap.set(definition.id, unknownRuntimeState());
    }
    return stateMap;
  }

  const result = await commandRunner('tasklist.exe', ['/FO', 'CSV', '/NH'], {
    timeoutMs: 1200,
  });
  if (!result.ok) {
    logWarn('Windows process probe failed; marking Windows services unknown.', {
      stderr: result.stderr || result.error || 'No tasklist output',
    });
    for (const definition of windowsDefinitions) {
      stateMap.set(definition.id, unknownRuntimeState());
    }
    return stateMap;
  }

  const processes = new Map<string, string[]>();
  for (const line of result.stdout.split(/\r?\n/).filter(Boolean)) {
    const values = parseCsvLine(line);
    if (values.length > 0) {
      processes.set(values[0].toLowerCase(), values);
    }
  }

  if (result.stdout.trim() && processes.size === 0) {
    logWarn('Windows process probe returned unreadable output; marking Windows services unknown.');
    for (const definition of windowsDefinitions) {
      stateMap.set(definition.id, unknownRuntimeState());
    }
    return stateMap;
  }

  for (const definition of windowsDefinitions) {
    const processName = definition.windowsProcessName?.toLowerCase();
    if (!processName) {
      stateMap.set(definition.id, unknownRuntimeState());
      continue;
    }

    const processRow = processes.get(processName);

    if (!processRow) {
      stateMap.set(definition.id, stoppedRuntimeState(definition.group));
      continue;
    }

    stateMap.set(
      definition.id,
      runningRuntimeState('—', lineOrDefault(processRow[4], '—'), '—'),
    );
  }

  return stateMap;
}

async function applyPortReachability(
  services: ServiceRecord[],
  bindHost: string,
): Promise<ServiceRecord[]> {
  const candidates = services
    .map((service) => ({ service, port: parsePort(service.port) }))
    .filter((entry): entry is { service: ServiceRecord; port: number } => {
      return (
        entry.port !== undefined &&
        (entry.service.status === 'stopped' || entry.service.status === 'unknown')
      );
    });

  if (candidates.length === 0) {
    return services;
  }

  const reachable = new Set<string>();
  await Promise.all(
    candidates.map(async ({ service, port }) => {
      if (await isTcpPortReachable(bindHost, port)) {
        reachable.add(service.id);
      }
    }),
  );

  if (reachable.size === 0) {
    return services;
  }

  return services.map((service) =>
    reachable.has(service.id)
      ? {
          ...service,
          ...portReachableRuntimeState(service),
        }
      : service,
  );
}

export class RuntimeResolver {
  constructor(
    private readonly root: string,
    private readonly publicDir: string,
    private readonly configRepository: ConfigRepository,
    private readonly portAllocator: PortAllocator,
    private readonly logs: LogBroker,
    private readonly commandRunner: CommandRunner = runCommand,
    private readonly toolManager: ToolManager = new ToolManager(root, configRepository, commandRunner),
  ) {}

  async buildDashboardState(diagnostics: StartupDiagnostics): Promise<DashboardState> {
    await this.configRepository.hydrateProcessEnv();
    const model = await this.configRepository.loadProjectModel();
    const definitions = await Promise.all(model.definitions.map((definition) => enrichServiceDefinition(definition)));
    const [dockerStates, pm2States, windowsStates, phase2, resources, extensions] = await Promise.all([
      collectDockerStates(this.root, definitions, this.commandRunner),
      collectPm2States(definitions, this.commandRunner),
      collectWindowsStates(definitions, this.commandRunner),
      buildPhase2Advisor(model.env),
      buildResourceDashboard(this.commandRunner),
      buildExtensionWorkspace(this.root, model.env, this.commandRunner),
    ]);
    const toolWorkspace = await this.toolManager.readWorkspace();
    const bindHost = normalizeLoopbackBindHost(model.env.LOCALLINK_BIND_HOST);

    const runtimeServices = definitions.map<ServiceRecord>((definition) => {
      const runtimeState =
        dockerStates.get(definition.id) ??
        pm2States.get(definition.id) ??
        windowsStates.get(definition.id) ??
        unknownRuntimeState();

      return {
        ...definition,
        port: definition.port || '—',
        ...runtimeState,
      };
    });
    const services = await applyPortReachability(runtimeServices, bindHost);

    logDebug('Resolved runtime states for services.', {
      workspaceRoot: this.root,
      totalServices: services.length,
      running: services.filter((service) => service.status === 'running').length,
      stopped: services.filter((service) => service.status === 'stopped').length,
      degraded: services.filter((service) => service.status === 'degraded').length,
      unknown: services.filter((service) => service.status === 'unknown').length,
    });

    const startFrom = Number(model.env.LOCALLINK_DEFAULT_PORT_START || '5000');
    let portScanUnavailable = false;
    let portScanError = '';
    let scan;
    try {
      scan = await this.portAllocator.findNextAvailablePort(startFrom);
    } catch (error) {
      portScanUnavailable = true;
      portScanError = formatFatalError(error);
      scan = { startFrom, nextFree: startFrom, busy: [] };
      logWarn('Port scan failed; continuing with degraded port allocation data.', {
        workspaceRoot: this.root,
        error: portScanError,
      });
      this.logs.append(`Port scan unavailable: ${portScanError}`, 'Alerts', 'warn');
    }
    const recent = this.portAllocator.buildRecentEntries(services, scan, !portScanUnavailable);
    const busyText = portScanUnavailable ? 'Unavailable' : scan.busy.length > 0 ? scan.busy.join(', ') : 'None';
    const manifestExists = await fileExists(path.join(this.publicDir, 'manifest.webmanifest'));
    const serviceWorkerExists = await fileExists(path.join(this.publicDir, 'sw.js'));
    const logs = this.logs.list();
    const trackedServices = services.length;
    const healthyServices = services.filter((service) => service.status === 'running').length;
    const alerts = services.filter((service) => service.status !== 'running').length;

    if (logs.length === 0) {
      this.logs.seed([
        { stream: 'Runtime', level: 'info', message: 'LocalLink runtime initialized.' },
        { stream: 'Runtime', level: 'info', message: 'Snapshot captured for the current local workspace state.' },
      ]);
    }

    return {
      app: {
        name: 'LocalLink',
        subtitle: 'Local-first orchestration for Docker, PM2, and dev servers',
        scope: `${bindHost} only`,
      },
      hero: {
        eyebrow: 'Phase 1 control plane',
        title: 'Find the local service you need.',
        body: 'Launch running services, inspect their connection targets, and use Edge extension exports without remembering ports or paths.',
      },
      snapshot: {
        value: `${trackedServices} services`,
        detail: 'rehydrated from Docker, PM2, PWA dev servers, and Windows process probes',
      },
      stats: [
        {
          label: 'Tracked services',
          value: String(trackedServices),
          detail: 'Docker + PM2 + Windows',
        },
        {
          label: 'Healthy',
          value: String(healthyServices),
          detail: 'Up right now',
        },
        {
          label: 'Alerts',
          value: String(alerts),
          detail: 'Needs attention',
        },
        {
          label: 'Next free port',
          value: portScanUnavailable ? 'Unavailable' : String(scan.nextFree),
          detail: portScanUnavailable ? 'Port scan failed' : `Start above ${startFrom}`,
        },
      ],
      pwa: {
        manifest: manifestExists ? 'Valid' : 'Missing',
        serviceWorker: serviceWorkerExists ? 'Registered' : 'Missing',
        offline: serviceWorkerExists ? 'Shell cached' : 'Not cached yet',
        install: 'Desktop install ready',
        scope: bindHost === '127.0.0.1' ? 'localhost' : bindHost,
      },
      diagnostics,
      phase2,
      filters: [
        { label: 'All', value: 'all' },
        { label: 'Docker', value: 'docker' },
        { label: 'PM2', value: 'pm2' },
        { label: 'Windows', value: 'windows' },
      ],
      services,
      tools: [
        {
          name: 'read_workspace_blueprint',
          input: 'None',
          detail: 'Reads .env, docker-compose.yml, locallink.services.yml, locallink.lock.json, locallink.extensions.yml, optional ecosystem.config.js, and mcp-registry.json as a structural snapshot.',
        },
        {
          name: 'patch_workspace_blueprint',
          input: 'target_file + content or patch_payload',
          detail: 'Safely mutates the selected workspace blueprint without flattening comments or formatting.',
        },
        {
          name: 'allocate_system_port',
          input: 'preferred_start optional',
          detail: 'Scans sequentially for the next completely open local port.',
        },
        {
          name: 'orchestrate_service',
          input: 'runtime + service_name + action',
          detail: 'Runs docker, pm2, or taskfile lifecycle commands and streams the terminal output.',
        },
        {
          name: 'verify_blueprint_compliance',
          input: 'service_name',
          detail: 'Checks whether a declared local service has a readable Dockerfile blueprint.',
        },
        {
          name: 'read_tool_workspace',
          input: 'None',
          detail: 'Returns version lock status, latest-check results, and temporary trial services.',
        },
        {
          name: 'update_tool_version',
          input: 'service_name + target_version + dry_run',
          detail: 'Plans or applies a version change and updates locallink.lock.json.',
        },
        {
          name: 'plan_tool_trial',
          input: 'tool_source + version + runtime',
          detail: 'Creates a dry-run plan for a temporary service before provisioning.',
        },
      ],
      logs: this.logs.list(),
      ports: {
        startFrom,
        nextFree: scan.nextFree,
        busy: scan.busy,
        busyText,
        rule: portScanUnavailable ? `Port scan unavailable: ${portScanError}` : `First free port above ${startFrom}`,
        recent,
      },
      resources,
      toolWorkspace,
      extensions,
      constraints: [
        {
          title: 'Loopback only',
          detail: 'Phase 1 binds the local UI and the control plane to 127.0.0.1.',
        },
        {
          title: 'External runtime truth',
          detail: 'Each snapshot re-queries Docker, PM2, and Windows process probes instead of trusting in-memory state.',
        },
        {
          title: 'Unknown when unverifiable',
          detail: 'Services fall back to Unknown when a runtime manager is unavailable or LocalLink lacks a trustworthy probe.',
        },
      ],
      timeline: [
        {
          title: 'Service matrix',
          detail: 'One glance tells you which containers, PM2 workers, and host processes are live.',
        },
        {
          title: 'Log tailing',
          detail: 'Lifecycle, runtime, and alert events remain readable in a terminal-style pane.',
        },
        {
          title: 'Port allocation',
          detail: 'New services get a deterministic open port before the config is written.',
        },
      ],
    };
  }
}
