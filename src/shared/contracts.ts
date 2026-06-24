export const TARGET_FILES = [
  '.env',
  '.env.example',
  'docker-compose.yml',
  'locallink.services.yml',
  'locallink.lock.json',
  'locallink.extensions.yml',
  'ecosystem.config.js',
  'mcp-registry.json',
] as const;

export type TargetFile = (typeof TARGET_FILES)[number];
export type ServiceGroup = 'docker' | 'pm2' | 'windows' | 'pwa';
export type TaskRuntime = 'docker' | 'pm2' | 'taskfile';
export type TaskAction = 'start' | 'stop' | 'restart' | 'up';
export type WorkspaceLifecycleAction = 'up' | 'down';
export type StatusTone = 'healthy' | 'warn' | 'off';
export type LogLevel = 'info' | 'warn' | 'error';
export type DiagnosticStatus = 'ok' | 'warn' | 'error';

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
  definitionSource?: 'compose' | 'services' | 'ecosystem' | 'trial';
  runtime?: TaskRuntime;
  runtimeName?: string;
  taskName?: string;
  cwd?: string;
  script?: string;
  args?: string | string[];
  toolSource?: ToolSource;
  version?: ToolVersionRequest;
  lifecycleState?: ToolLifecycleState;
  trialId?: string;
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
  status: 'running' | 'stopped' | 'degraded' | 'unknown';
  statusLabel: 'Up' | 'Down' | 'Restarting' | 'Unknown';
  statusTone: StatusTone;
  cpu: string;
  memory: string;
  uptime: string;
}

export type ToolLifecycleState = 'active' | 'trial' | 'disabled' | 'retired';
export type ToolSourceType = 'docker-image' | 'npm' | 'git' | 'local-binary' | 'taskfile' | 'manual';

export interface ToolSource {
  type: ToolSourceType;
  ref: string;
}

export interface ToolVersionRequest {
  desired?: string;
  policy?: 'manual' | 'notify' | 'auto-minor';
}

export interface ToolLockEntry {
  source?: ToolSource;
  resolvedVersion?: string;
  latestVersion?: string;
  resolvedAt?: string;
  artifact?: {
    kind?: string;
    ref?: string;
    integrity?: string;
    checksum?: string;
  };
  ports?: string[];
  trialId?: string;
}

export interface ToolVersionStatus {
  serviceName: string;
  runtime?: TaskRuntime;
  lifecycleState: ToolLifecycleState;
  source?: ToolSource;
  desiredVersion: string;
  resolvedVersion: string;
  latestVersion: string;
  policy: string;
  status: 'current' | 'update_available' | 'unlocked' | 'unknown' | 'trial' | 'error';
  detail: string;
  checkedAt?: string;
}

export interface ToolTrialRecord {
  trialId: string;
  serviceName: string;
  runtime?: TaskRuntime;
  source?: ToolSource;
  desiredVersion: string;
  port?: string;
  status: 'planned' | 'provisioned' | 'promoted' | 'removed';
  manifestPath?: string;
  createdAt?: string;
  expiresAt?: string;
}

export interface ToolWorkspace {
  summary: StatCard[];
  versions: ToolVersionStatus[];
  trials: ToolTrialRecord[];
}

export type ExtensionKind = 'dashboard' | 'reverse-proxy' | 'network-edge' | 'observability' | 'custom';
export type ExtensionStatus = 'enabled' | 'available' | 'disabled' | 'missing' | 'needs_config';

export interface ExtensionRecord {
  id: string;
  name: string;
  kind: ExtensionKind;
  enabled: boolean;
  status: ExtensionStatus;
  statusLabel: string;
  detail: string;
  docsUrl?: string;
  command?: string;
  detectedValue?: string;
  requiredEnv?: string[];
  missingEnv?: string[];
  urls?: string[];
  exposedPorts?: string[];
}

export interface ExtensionWorkspace {
  summary: StatCard[];
  extensions: ExtensionRecord[];
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
  filters: FilterOption[];
  services: ServiceRecord[];
  tools: ToolSummary[];
  logs: LogEntry[];
  ports: PortResolution;
  resources: ResourceDashboard;
  toolWorkspace?: ToolWorkspace;
  extensions?: ExtensionWorkspace;
  constraints: InfoCard[];
  timeline: InfoCard[];
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
}

export interface ResourceDashboard {
  summary: StatCard[];
  processes: ResourceProcess[];
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
}

export interface ProcessTerminationResult {
  pid: number;
  signal: string;
  ok: boolean;
  message: string;
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

export type InfraPatch = EnvPatch | ComposePatch | EcosystemPatch;

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

export interface WorkspaceLifecycleStep {
  id: string;
  name: string;
  kind: 'core' | 'service' | 'extension';
  action: WorkspaceLifecycleAction;
  ok: boolean;
  skipped?: boolean;
  command?: string;
  stdout?: string;
  stderr?: string;
  detail: string;
}

export interface WorkspaceLifecycleResult {
  action: WorkspaceLifecycleAction;
  workspaceRoot: string;
  ok: boolean;
  steps: WorkspaceLifecycleStep[];
}

export interface WorkspaceStatus {
  workspaceRoot: string;
  appRoot: string;
  systemId: string;
  api?: ManagedSurfaceStatus;
  dashboard?: ManagedSurfaceStatus;
  services: {
    total: number;
    running: number;
    stopped: number;
    unknown: number;
  };
  ports: PortResolution;
}

export interface ManagedSurfaceStatus {
  name: string;
  port?: number;
  url?: string;
}

export interface ProjectModel {
  env: Record<string, string>;
  definitions: ServiceDefinition[];
}
