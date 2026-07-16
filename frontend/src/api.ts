import type {
  DashboardState,
  LogEntry,
  PortResolution,
  ProcessInspection,
  ProcessTerminationReview,
  ProcessTerminationResponse,
  ServiceRecord,
  TaskAction,
  TaskExecutionResponse,
  TaskRuntime,
  WorkspaceState,
} from './types';

const DEFAULT_STATE: DashboardState = {
  app: {
    name: 'LocalLink',
    subtitle: 'Local-first orchestration for Docker, PM2, and dev servers',
    scope: '127.0.0.1 only',
  },
  hero: {
    eyebrow: 'Workspace',
    title: 'Local runtime control',
    body: 'Operate local services, ports, logs, and resources from one compact workspace.',
  },
  snapshot: {
    value: '0 services',
    detail: 'Waiting for the first runtime snapshot.',
  },
  stats: [],
  pwa: {
    manifest: 'Pending',
    serviceWorker: 'Pending',
    offline: 'Pending',
    install: 'Install readiness unknown',
    scope: 'localhost',
  },
  diagnostics: {
    status: 'ok',
    summary: 'Startup checks are waiting for the first snapshot.',
    checks: [],
  },
  phase2: {
    enabled: true,
    summary: '',
    options: [],
  },
  services: [],
  logs: [],
  ports: {
    startFrom: 5000,
    nextFree: 5000,
    busy: [],
    busyText: 'None',
    rule: 'First free port above 5000',
    recent: [],
  },
  resources: {
    scope: 'host',
    scopeNote: 'Host pressure is waiting for the first live snapshot.',
    summary: [],
    system: {
      cpuPercent: 0,
      cpuCores: 1,
      loadAverage: [0, 0, 0],
      memoryUsedMb: 0,
      memoryTotalMb: 1,
      memoryPercent: 0,
      processCount: 0,
      flaggedCount: 0,
      updatedAt: new Date(0).toISOString(),
      sampleIntervalSeconds: 5,
    },
    history: [],
    topCpu: [],
    topMemory: [],
    processes: [],
    workspaceProcesses: [],
    hostProcesses: [],
  },
};

export function normalizeLog(entry: Partial<LogEntry>): LogEntry {
  const timestamp = Number.isFinite(Date.parse(entry.timestamp || ''))
    ? new Date(entry.timestamp || '').toISOString()
    : new Date().toISOString();
  return {
    timestamp,
    time:
      entry.time ||
      new Date(timestamp).toLocaleTimeString([], {
        hour: '2-digit',
        minute: '2-digit',
      }),
    stream: entry.stream || 'Runtime',
    level: entry.level === 'warn' || entry.level === 'error' ? entry.level : 'info',
    message: entry.message || 'No log message supplied.',
    serviceId: entry.serviceId,
    serviceName: entry.serviceName,
  };
}

function normalizeService(service: Partial<ServiceRecord>, index: number): ServiceRecord {
  const group = service.group || 'pm2';
  const status = service.status || 'unknown';
  const statusLabel = service.statusLabel || (status === 'running' ? 'Up' : status === 'stopped' ? 'Down' : 'Unknown');
  const statusTone = service.statusTone || (status === 'running' ? 'healthy' : status === 'stopped' ? 'off' : 'warn');

  return {
    id: service.id || String(service.name || `service-${index}`).toLowerCase().replace(/[^a-z0-9]+/g, '-'),
    name: service.name || `Service ${index + 1}`,
    kind: service.kind || 'Service',
    group,
    runtime: service.runtime || (group === 'docker' ? 'docker' : group === 'windows' ? 'taskfile' : 'pm2'),
    runtimeName: service.runtimeName,
    taskName: service.taskName,
    cwd: service.cwd,
    script: service.script,
    dockerfilePath: service.dockerfilePath,
    portEnv: service.portEnv,
    port: service.port || '-',
    notes: service.notes || 'Local runtime surface.',
    detail: service.detail || service.notes || 'Runtime details pending.',
    tags: service.tags || `${group} / local`,
    dependsOn: service.dependsOn || [],
    downstream: service.downstream || [],
    envVars: service.envVars || [],
    docsUrl: service.docsUrl,
    blueprint: service.blueprint,
    compliance: service.compliance,
    windowsProcessName: service.windowsProcessName,
    status,
    statusLabel,
    statusTone,
    cpu: service.cpu || '-',
    memory: service.memory || '-',
    uptime: service.uptime || '-',
    reviewReasons: service.reviewReasons || [],
  };
}

export function normalizeState(input: Partial<DashboardState> = {}): DashboardState {
  const services = (input.services || []).map(normalizeService);
  const resourceProcesses = input.resources?.processes || [];
  return {
    ...DEFAULT_STATE,
    ...input,
    app: { ...DEFAULT_STATE.app, ...(input.app || {}) },
    hero: { ...DEFAULT_STATE.hero, ...(input.hero || {}) },
    snapshot: {
      ...DEFAULT_STATE.snapshot,
      ...(input.snapshot || {}),
      value: `${services.length} services`,
    },
    pwa: { ...DEFAULT_STATE.pwa, ...(input.pwa || {}) },
    diagnostics: {
      ...DEFAULT_STATE.diagnostics,
      ...(input.diagnostics || {}),
      checks: input.diagnostics?.checks || [],
    },
    phase2: {
      ...DEFAULT_STATE.phase2,
      ...(input.phase2 || {}),
      options: input.phase2?.options || [],
    },
    services,
    logs: (input.logs || []).map(normalizeLog),
    ports: {
      ...DEFAULT_STATE.ports,
      ...(input.ports || {}),
      recent: input.ports?.recent || [],
      busy: input.ports?.busy || [],
    },
    resources: {
      scope: input.resources?.scope || 'host',
      scopeNote: input.resources?.scopeNote || DEFAULT_STATE.resources.scopeNote,
      summary: input.resources?.summary || [],
      system: {
        ...DEFAULT_STATE.resources.system,
        ...(input.resources?.system || {}),
      },
      history: input.resources?.history || [],
      topCpu:
        input.resources?.topCpu ||
        [...resourceProcesses].sort((left, right) => right.cpuPercent - left.cpuPercent).slice(0, 5),
      topMemory:
        input.resources?.topMemory ||
        [...resourceProcesses].sort((left, right) => right.memoryMb - left.memoryMb).slice(0, 5),
      processes: resourceProcesses,
      workspaceProcesses: input.resources?.workspaceProcesses || resourceProcesses,
      hostProcesses: input.resources?.hostProcesses || resourceProcesses,
    },
  };
}

async function fetchJson<T>(url: string, init?: RequestInit): Promise<T> {
  const response = await fetch(url, {
    cache: 'no-store',
    headers: {
      Accept: 'application/json',
      ...(init?.headers || {}),
    },
    ...init,
  });

  if (!response.ok) {
    throw new Error(`${response.status} ${response.statusText}`.trim());
  }

  return response.json() as Promise<T>;
}

export async function readDashboardState(): Promise<{ state: DashboardState; source: 'api' | 'mock' }> {
  try {
    const state = await fetchJson<DashboardState>('./api/state');
    return { state: normalizeState(state), source: 'api' };
  } catch {
    const state = await fetchJson<DashboardState>('./assets/data/mock-state.json');
    return { state: normalizeState(state), source: 'mock' };
  }
}

export async function requestPort(startFrom: number, service = 'workspace allocation'): Promise<PortResolution> {
  return fetchJson<PortResolution>('./api/ports/next', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ startFrom, reserve: true, service }),
  });
}

export async function readWorkspaceState(): Promise<WorkspaceState> {
  return fetchJson<WorkspaceState>('./api/workspace/settings');
}

export async function updateWorkspacePreferences(patch: Partial<WorkspaceState['preferences']>): Promise<WorkspaceState['preferences']> {
  return fetchJson<WorkspaceState['preferences']>('./api/workspace/settings', {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(patch),
  });
}

export async function persistTemporaryRuntime(input: { name: string; type: string; port: number; command: string }): Promise<WorkspaceState> {
  return fetchJson<WorkspaceState>('./api/workspace/runtimes', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(input),
  });
}

export async function queueVersionUpdate(from: string, to: string): Promise<WorkspaceState> {
  return fetchJson<WorkspaceState>('./api/workspace/updates', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ from, to }),
  });
}

export async function cancelVersionUpdate(id: string): Promise<WorkspaceState> {
  return fetchJson<WorkspaceState>(`./api/workspace/updates/${id}`, { method: 'DELETE' });
}

export async function executeServiceAction(
  serviceName: string,
  runtime: TaskRuntime,
  action: TaskAction,
): Promise<TaskExecutionResponse> {
  return fetchJson<TaskExecutionResponse>('./api/tasks', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ serviceName, runtime, action }),
  });
}

export async function inspectProcess(pid: number): Promise<ProcessInspection> {
  return fetchJson<ProcessInspection>(`./api/processes/${pid}`);
}

export async function reviewProcessTermination(pid: number): Promise<ProcessTerminationReview> {
  return fetchJson<ProcessTerminationReview>(`./api/processes/${pid}/termination-review`);
}

export async function terminateProcess(pid: number, identityToken: string, reason: string): Promise<ProcessTerminationResponse> {
  return fetchJson<ProcessTerminationResponse>(`./api/processes/${pid}/terminate`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ signal: 'SIGTERM', identityToken, reason }),
  });
}
