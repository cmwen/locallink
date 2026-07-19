import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { ConfigRepository } from '../config/files';
import { LogBroker } from '../logs/broker';
import { enrichServiceDefinition } from './lego';
import { PortAllocator } from '../ports/allocator';
import { buildPhase2Advisor } from './phase2';
import { discoverServiceEdgeUrls } from './network-edge';
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

export class RuntimeResolver {
  constructor(
    private readonly root: string,
    private readonly publicDir: string,
    private readonly configRepository: ConfigRepository,
    private readonly portAllocator: PortAllocator,
    private readonly logs: LogBroker,
    private readonly commandRunner: CommandRunner = runCommand,
  ) {}

  async buildDashboardState(diagnostics: StartupDiagnostics): Promise<DashboardState> {
    await this.configRepository.hydrateProcessEnv();
    const model = await this.configRepository.loadProjectModel();
    const definitions = await Promise.all(model.definitions.map((definition) => enrichServiceDefinition(definition)));
    const [dockerStates, pm2States, windowsStates, phase2, resources, edgeUrlsByService] = await Promise.all([
      collectDockerStates(this.root, definitions, this.commandRunner),
      collectPm2States(definitions, this.commandRunner),
      collectWindowsStates(definitions, this.commandRunner),
      buildPhase2Advisor(model.env, this.commandRunner),
      buildResourceDashboard(this.commandRunner, definitions),
      discoverServiceEdgeUrls(model.extensions, definitions, this.commandRunner, model.env),
    ]);

    const services = definitions.map<ServiceRecord>((definition) => {
      const runtimeState =
        dockerStates.get(definition.id) ??
        pm2States.get(definition.id) ??
        windowsStates.get(definition.id) ??
        unknownRuntimeState();

      const reviewReasons = [
        runtimeState.status === 'unknown' ? 'Runtime status could not be verified' : null,
        runtimeState.status === 'degraded' ? 'Runtime is restarting or degraded' : null,
        definition.compliance?.status === 'warn' ? definition.compliance.summary : null,
        !definition.docsUrl ? 'No service documentation link' : null,
      ].filter((reason): reason is string => Boolean(reason));

      return {
        ...definition,
        port: definition.port || '—',
        edgeUrls: edgeUrlsByService.get(definition.id),
        ...runtimeState,
        reviewReasons,
      };
    });

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
    const bindHost = normalizeLoopbackBindHost(model.env.LOCALLINK_BIND_HOST);

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
        title: 'One dashboard for local runtimes, ports, and logs.',
        body: 'Monitor hybrid services, trigger lifecycle actions, and hand the whole workspace to AI through the same compact surface.',
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
      extensions: model.extensions,
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
          detail: 'Reads environment, service, extension, runtime, and MCP declarations as a structural snapshot.',
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
