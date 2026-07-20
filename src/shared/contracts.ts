export const TARGET_FILES = [
  '.env',
  '.env.example',
  'docker-compose.yml',
  'locallink.services.yml',
  'locallink.extensions.yml',
  'ecosystem.config.js',
  'mcp-registry.json',
] as const;

export type TargetFile = (typeof TARGET_FILES)[number];
export type ServiceGroup = 'docker' | 'pm2' | 'windows' | 'pwa';
export type TaskRuntime = 'docker' | 'pm2' | 'taskfile';
export type TaskAction = 'start' | 'stop' | 'restart' | 'up';
export type StatusTone = 'healthy' | 'warn' | 'off';
export type LogLevel = 'info' | 'warn' | 'error';
export type DiagnosticStatus = 'ok' | 'warn' | 'error';
export type ResourceScope = 'workspace' | 'host';
export type AttributionConfidence = 'exact' | 'heuristic' | 'unknown';
export type ExtensionKind = 'dashboard' | 'reverse-proxy' | 'network-edge' | 'identity-provider' | 'observability' | 'custom';
export type ExtensionStatus = 'ready' | 'setup' | 'disabled';
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
export type ExtensionAutomation = 'automatic' | 'guided' | 'manual';
export type ExtensionCheckStatus = 'ok' | 'warning' | 'missing';

export interface FilterOption {
  label: string;
  value: string;
}

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

export interface ToolSummary {
  name: string;
  input: string;
  detail: string;
}

export interface InfoCard {
  title: string;
  detail: string;
}

export interface DiagnosticCheck {
  id: string;
  label: string;
  status: DiagnosticStatus;
  summary: string;
  detail: string;
}

export interface StartupDiagnostics {
  status: DiagnosticStatus;
  summary: string;
  checks: DiagnosticCheck[];
}

export interface ServiceDefinition {
  id: string;
  name: string;
  kind: string;
  group: ServiceGroup;
  definitionSource?: 'compose' | 'services' | 'ecosystem';
  runtime?: TaskRuntime;
  runtimeName?: string;
  taskName?: string;
  cwd?: string;
  script?: string;
  args?: string | string[];
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
  blueprint?: ServiceBlueprint;
  compliance?: ServiceCompliance;
  windowsProcessName?: string;
}

export interface ServiceRecord extends ServiceDefinition {
  edgeUrls?: string[];
  status: 'running' | 'stopped' | 'degraded' | 'unknown';
  statusLabel: 'Up' | 'Down' | 'Restarting' | 'Unknown';
  statusTone: StatusTone;
  cpu: string;
  memory: string;
  uptime: string;
  reviewReasons?: string[];
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
  filters: FilterOption[];
  services: ServiceRecord[];
  tools: ToolSummary[];
  logs: LogEntry[];
  ports: PortResolution;
  resources: ResourceDashboard;
  constraints: InfoCard[];
  timeline: InfoCard[];
}

export interface WorkspaceExtension {
  id: string;
  name: string;
  kind: ExtensionKind;
  enabled: boolean;
  detail: string;
  status: ExtensionStatus;
  command?: string;
  exposedPorts: string[];
  requiredEnv: string[];
  missingEnv: string[];
  dependsOn: string[];
  docsUrl?: string;
}

export interface ExtensionLifecycleCheck {
  id: string;
  label: string;
  status: ExtensionCheckStatus;
  detail: string;
  owner: 'locallink' | 'user' | 'system';
}

export interface ExtensionLifecycleRecord {
  id: string;
  declarationId?: string;
  name: string;
  kind: ExtensionKind;
  declared: boolean;
  enabled: boolean;
  state: ExtensionLifecycleState;
  automation: ExtensionAutomation;
  summary: string;
  nextStep?: string;
  docsUrl?: string;
  checks: ExtensionLifecycleCheck[];
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

export interface ProcessTerminationResult {
  pid: number;
  signal: string;
  ok: boolean;
  message: string;
  identityToken: string;
  reviewedAt: string;
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

export interface InfraConfigFileView {
  targetFile: TargetFile;
  path: string;
  exists: boolean;
  content: string;
}

export interface InfraConfigView {
  root: string;
  files: InfraConfigFileView[];
  services: ServiceDefinition[];
}

export type EnvPatchValue = string | { sourceEnv: string } | null;

export interface EnvPatch {
  kind: 'env';
  set?: Record<string, string>;
  unset?: string[];
}

export interface ComposePatch {
  kind: 'compose';
  serviceName: string;
  updates: {
    image?: string;
    restart?: string;
    ports?: string[];
    environment?: Record<string, string>;
    labels?: Record<string, string>;
  };
}

export interface EcosystemPatch {
  kind: 'ecosystem';
  appName: string;
  updates: {
    script?: string;
    cwd?: string;
    args?: string | string[];
    env?: Record<string, EnvPatchValue>;
    locallink?: Record<string, unknown>;
  };
}

export interface ExtensionPatch {
  kind: 'extension';
  extensionId: string;
  updates: {
    name?: string;
    kind?: ExtensionKind;
    enabled?: boolean;
    detail?: string;
    command?: string;
    exposedPorts?: string[];
    requiredEnv?: string[];
    dependsOn?: string[];
    docsUrl?: string;
  };
}

export type InfraPatch = EnvPatch | ComposePatch | EcosystemPatch | ExtensionPatch;

export interface WriteInfraConfigInput {
  targetFile: TargetFile;
  content?: string;
  patch?: InfraPatch;
}

export interface WriteInfraConfigResult {
  targetFile: TargetFile;
  path: string;
  content: string;
}

export interface ExecuteTaskInput {
  runtime: TaskRuntime;
  serviceName: string;
  action: TaskAction;
}

export interface TaskExecutionResult {
  ok: boolean;
  runtime: TaskRuntime;
  serviceName: string;
  action: TaskAction;
  command: string;
  exitCode: number | null;
  stdout: string;
  stderr: string;
}

export interface ProjectModel {
  env: Record<string, string>;
  definitions: ServiceDefinition[];
  extensions: WorkspaceExtension[];
}
