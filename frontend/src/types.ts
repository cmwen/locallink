export type TaskRuntime = 'docker' | 'pm2' | 'taskfile';
export type TaskAction = 'start' | 'stop' | 'restart' | 'up';
export type StatusTone = 'healthy' | 'warn' | 'off';
export type LogLevel = 'info' | 'warn' | 'error';
export type ResourceScope = 'workspace' | 'host';
export type AttributionConfidence = 'exact' | 'heuristic' | 'unknown';

export interface StatCard {
  label: string;
  value: string;
  detail: string;
}

export interface LogEntry {
  timestamp: string;
  time: string;
  stream: string;
  level: LogLevel;
  message: string;
  serviceId?: string;
  serviceName?: string;
}

export interface PortAllocationEntry {
  service: string;
  port: string;
  status: string;
}

export interface PortResolution {
  startFrom: number;
  nextFree: number;
  busy: number[];
  busyText: string;
  rule: string;
  recent: PortAllocationEntry[];
}

export interface ServiceBlueprint {
  dockerfilePath: string;
  expose: string[];
  envVars: string[];
  command: string;
}

export interface ServiceCompliance {
  status: 'pass' | 'warn' | 'skipped';
  summary: string;
  issues: string[];
}

export interface ServiceRecord {
  id: string;
  name: string;
  kind: string;
  group: 'docker' | 'pm2' | 'windows' | 'pwa';
  runtime?: TaskRuntime;
  runtimeName?: string;
  taskName?: string;
  cwd?: string;
  script?: string;
  dockerfilePath?: string;
  portEnv?: string;
  port?: string;
  notes: string;
  detail: string;
  tags: string;
  dependsOn?: string[];
  downstream?: string[];
  envVars?: string[];
  docsUrl?: string;
  edgeUrls?: string[];
  blueprint?: ServiceBlueprint;
  compliance?: ServiceCompliance;
  windowsProcessName?: string;
  status: 'running' | 'stopped' | 'degraded' | 'unknown';
  statusLabel: 'Up' | 'Down' | 'Restarting' | 'Unknown';
  statusTone: StatusTone;
  cpu: string;
  memory: string;
  uptime: string;
  reviewReasons?: string[];
}

export interface DiagnosticCheck {
  id: string;
  label: string;
  status: 'ok' | 'warn' | 'error';
  summary: string;
  detail: string;
}

export interface StartupDiagnostics {
  status: 'ok' | 'warn' | 'error';
  summary: string;
  checks: DiagnosticCheck[];
}

export interface Phase2Option {
  id: string;
  title: string;
  detail: string;
  status: 'available' | 'optional' | 'unavailable' | 'disabled';
  recommended?: boolean;
  docsUrl?: string;
  detectedValue?: string;
}

export interface Phase2Advisor {
  enabled: boolean;
  summary: string;
  options: Phase2Option[];
}

export interface WorkspaceExtension {
  id: string;
  name: string;
  kind: 'dashboard' | 'reverse-proxy' | 'network-edge' | 'identity-provider' | 'observability' | 'custom';
  enabled: boolean;
  detail: string;
  status: 'ready' | 'setup' | 'disabled';
  command?: string;
  exposedPorts: string[];
  requiredEnv: string[];
  missingEnv: string[];
  dependsOn: string[];
  docsUrl?: string;
}

export type ExtensionLifecycleState =
  | 'available'
  | 'declared'
  | 'disabled'
  | 'waiting-external'
  | 'waiting-user'
  | 'waiting-configuration'
  | 'installed'
  | 'healthy'
  | 'error';

export interface ExtensionLifecycleCheck {
  id: string;
  label: string;
  status: 'ok' | 'warning' | 'missing';
  detail: string;
  owner: 'locallink' | 'user' | 'system';
}

export interface ExtensionLifecycleRecord {
  id: string;
  declarationId?: string;
  name: string;
  kind: WorkspaceExtension['kind'];
  declared: boolean;
  enabled: boolean;
  state: ExtensionLifecycleState;
  automation: 'automatic' | 'guided' | 'manual';
  summary: string;
  nextStep?: string;
  docsUrl?: string;
  checks: ExtensionLifecycleCheck[];
}

export interface ExtensionPlanStep {
  id: string;
  label: string;
  owner: 'locallink' | 'user' | 'system';
  status: 'complete' | 'pending' | 'blocked';
  automatic: boolean;
  detail: string;
  targetFile?: string;
}

export interface ExtensionInstallPlan {
  capability: 'private-edge';
  state: 'ready-to-apply' | 'ready-to-route' | 'waiting-user' | 'complete';
  summary: string;
  canApply: boolean;
  selection: {
    requested: boolean;
    selected: Array<{ id: string; name: string; port: string }>;
    available: Array<{ id: string; name: string; port: string }>;
  };
  routePlan: {
    state: 'waiting-tailscale' | 'waiting-selection' | 'ready' | 'in-sync' | 'conflict';
    summary: string;
    mutatesHost: false;
    routes: Array<{
      serviceId: string;
      serviceName: string;
      targetPort: string;
      httpsPort: string;
      url?: string;
      status: 'active' | 'missing' | 'conflict';
      detail: string;
      apply: { command: string; args: string[] };
      rollback: { command: string; args: string[] };
    }>;
  };
  steps: ExtensionPlanStep[];
}

export interface ExtensionApplyResult {
  capability: 'private-edge';
  applied: boolean;
  changedFiles: string[];
  plan: ExtensionInstallPlan;
}

export interface ResourceProcess {
  pid: number;
  name: string;
  command: string;
  cpu: string;
  cpuPercent: number;
  memory: string;
  memoryMb: number;
  uptime: string;
  tone: StatusTone;
  reason: string;
  serviceId?: string;
  serviceName?: string;
  runtime?: TaskRuntime | 'system';
  workspaceOwned?: boolean;
  attributionConfidence?: AttributionConfidence;
}

export interface ResourceSample {
  timestamp: string;
  cpuPercent: number;
  memoryPercent: number;
}

export interface SystemPressure {
  cpuPercent: number;
  cpuCores: number;
  loadAverage: number[];
  memoryUsedMb: number;
  memoryTotalMb: number;
  memoryPercent: number;
  processCount: number;
  flaggedCount: number;
  updatedAt: string;
  sampleIntervalSeconds: number;
}

export interface ResourceDashboard {
  scope: ResourceScope;
  scopeNote: string;
  summary: StatCard[];
  system: SystemPressure;
  history: ResourceSample[];
  topCpu: ResourceProcess[];
  topMemory: ResourceProcess[];
  processes: ResourceProcess[];
  workspaceProcesses: ResourceProcess[];
  hostProcesses: ResourceProcess[];
}

export interface ProcessInspection {
  pid: number;
  parentPid: number;
  name: string;
  command: string;
  cpu: string;
  cpuPercent: number;
  memory: string;
  memoryMb: number;
  uptime: string;
  started: string;
  identityToken: string;
  workspaceOwned?: boolean;
  serviceId?: string;
  serviceName?: string;
}

export interface ProcessTerminationReview {
  pid: number;
  identityToken: string;
  name: string;
  command: string;
  parentPid: number;
  started: string;
  workspaceOwned: boolean;
  protected: boolean;
  canTerminate: boolean;
  requiresConfirmation: boolean;
  warnings: string[];
  dependents: string[];
  ports: string[];
  reviewedAt: string;
}

export interface DashboardState {
  app: {
    name: string;
    subtitle: string;
    scope: string;
  };
  hero: {
    eyebrow: string;
    title: string;
    body: string;
  };
  snapshot: {
    value: string;
    detail: string;
  };
  stats: StatCard[];
  pwa: {
    manifest: string;
    serviceWorker: string;
    offline: string;
    install: string;
    scope: string;
  };
  diagnostics: StartupDiagnostics;
  phase2: Phase2Advisor;
  extensions: WorkspaceExtension[];
  extensionLifecycle: ExtensionLifecycleRecord[];
  services: ServiceRecord[];
  logs: LogEntry[];
  ports: PortResolution;
  resources: ResourceDashboard;
}

export interface TaskExecutionResponse {
  result?: {
    ok: boolean;
    runtime: TaskRuntime;
    serviceName: string;
    action: TaskAction;
    command: string;
    exitCode: number | null;
    stdout: string;
    stderr: string;
  };
  snapshot?: DashboardState;
}

export interface ProcessTerminationResponse {
  result?: {
    pid: number;
    signal: string;
    ok: boolean;
    message: string;
    identityToken: string;
    reviewedAt: string;
  };
  snapshot?: DashboardState;
}

export interface TemporaryRuntimeRecord {
  id: string;
  name: string;
  type: string;
  port: number;
  command: string;
  createdAt: string;
  status: 'planned' | 'running' | 'stopped';
}

export interface VersionUpdateRecord {
  id: string;
  from: string;
  to: string;
  status: 'queued' | 'cancelled' | 'applied';
  createdAt: string;
}

export interface PortReservation {
  id: string;
  service: string;
  port: number;
  status: 'reserved' | 'released' | 'conflict';
  createdAt: string;
}

export interface WorkspacePreferences {
  dashboardEnabled: boolean;
  proxyEnabled: boolean;
  pocketIdEnabled: boolean;
  edgeEnabled: boolean;
}

export interface WorkspaceState {
  preferences: WorkspacePreferences;
  temporaryRuntimes: TemporaryRuntimeRecord[];
  versionUpdates: VersionUpdateRecord[];
  portReservations: PortReservation[];
}
