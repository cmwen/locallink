import { ConfigRepository } from './config/files';
import { createHttpServer } from './http/server';
import { LogBroker } from './logs/broker';
import { PortAllocator } from './ports/allocator';
import { verifyBlueprintCompliance } from './runtime/lego';
import { buildExtensionWorkspace } from './runtime/extensions';
import { inspectProcess, terminateProcess } from './runtime/resources';
import { RuntimeResolver } from './runtime/snapshot';
import { readWorkspaceRuntimeState } from './runtime/workspace-state';
import { StartupDiagnosticsService } from './startup/diagnostics';
import { resolvePaths } from './shared/paths';
import { logDebug, logInfo, mirrorBrokerEntry } from './shared/logger';
import { normalizeLoopbackBindHost } from './shared/network';
import { startStreamingCommand, type StreamingCommandHandle } from './shared/utils';
import { TaskExecutor } from './tasks/executor';
import { ToolManager, type ToolTrialInput } from './tools/manager';
import type {
  DashboardState,
  ExecuteTaskInput,
  ExtensionWorkspace,
  InfraConfigView,
  ProcessInspection,
  ProcessTerminationResult,
  PortResolution,
  ServiceCompliance,
  StartupDiagnostics,
  TaskExecutionResult,
  ToolWorkspace,
  WorkspaceStatus,
  WorkspaceLifecycleResult,
  WriteInfraConfigInput,
  WriteInfraConfigResult,
} from './shared/contracts';
import { AppError } from './shared/errors';

export class AppContext {
  readonly paths;

  readonly configRepository;

  readonly logs;

  readonly portAllocator;

  readonly runtimeResolver;

  readonly taskExecutor;

  readonly toolManager;

  readonly startupDiagnosticsService;

  private liveLogSubscribers = 0;

  private dockerTail?: StreamingCommandHandle;

  private pm2Tail?: StreamingCommandHandle;

  private startupDiagnostics?: StartupDiagnostics;

  constructor(root = process.cwd()) {
    this.paths = resolvePaths(root);
    this.configRepository = new ConfigRepository(this.paths.root);
    this.logs = new LogBroker(mirrorBrokerEntry);
    this.portAllocator = new PortAllocator();
    this.runtimeResolver = new RuntimeResolver(
      this.paths.root,
      this.paths.publicDir,
      this.configRepository,
      this.portAllocator,
      this.logs,
    );
    this.taskExecutor = new TaskExecutor(this.paths.root, this.configRepository, this.logs, undefined, this.paths.appRoot);
    this.toolManager = new ToolManager(this.paths.root, this.configRepository);
    this.startupDiagnosticsService = new StartupDiagnosticsService({
      workspaceRoot: this.paths.root,
      appRoot: this.paths.appRoot,
      publicDir: this.paths.publicDir,
    });
  }

  async initialize(): Promise<void> {
    logInfo('Initializing LocalLink context.', {
      workspaceRoot: this.paths.root,
      appRoot: this.paths.appRoot,
      publicDir: this.paths.publicDir,
    });
    await this.configRepository.hydrateProcessEnv();
    this.startupDiagnostics = await this.startupDiagnosticsService.inspect();
    const pwaCheck = this.startupDiagnostics.checks.find((check) => check.id === 'pwa-assets');
    this.logs.seed([
      {
        stream: 'Runtime',
        level: 'info',
        message: 'LocalLink initialized with local-only loopback defaults.',
      },
      {
        stream: 'Runtime',
        level: pwaCheck?.status === 'error' ? 'error' : 'info',
        message:
          pwaCheck?.status === 'error'
            ? pwaCheck.detail
            : 'Manifest and service worker are ready for the dashboard shell.',
      },
      ...this.startupDiagnostics.checks
        .filter((check) => check.status !== 'ok')
        .map((check) => ({
          stream: 'Alerts',
          level: check.status === 'error' ? ('error' as const) : ('warn' as const),
          message: `${check.label}: ${check.detail}`,
        })),
    ]);
  }

  async readState(): Promise<DashboardState> {
    logDebug('Reading dashboard state.', { workspaceRoot: this.paths.root });
    const state = await this.runtimeResolver.buildDashboardState(await this.getStartupDiagnostics());
    logInfo('Dashboard state ready.', {
      workspaceRoot: this.paths.root,
      services: state.services.length,
      healthy: state.services.filter((service) => service.status === 'running').length,
      alerts: state.services.filter((service) => service.status !== 'running').length,
    });
    return state;
  }

  async readInfraConfig(): Promise<InfraConfigView> {
    return this.configRepository.readInfraConfig();
  }

  async readToolWorkspace(): Promise<ToolWorkspace> {
    return this.toolManager.readWorkspace();
  }

  async readExtensionWorkspace(): Promise<ExtensionWorkspace> {
    await this.configRepository.hydrateProcessEnv();
    const model = await this.configRepository.loadProjectModel();
    return buildExtensionWorkspace(this.paths.root, model.env);
  }

  async checkToolVersion(serviceName: string) {
    const result = await this.toolManager.checkLatestVersion(serviceName);
    this.logs.append(`${serviceName}: latest version check completed.`, 'Lifecycle');
    return result;
  }

  async updateToolVersion(serviceName: string, targetVersion: string, dryRun = true) {
    const result = await this.toolManager.updateVersion(serviceName, targetVersion, dryRun);
    this.logs.append(result.summary, 'Lifecycle', dryRun ? 'info' : 'warn');
    return result;
  }

  planToolTrial(input: ToolTrialInput) {
    const result = this.toolManager.planTrial(input);
    this.logs.append(`${result.serviceName}: trial plan ${result.planId} prepared.`, 'Lifecycle');
    return result;
  }

  async provisionToolTrial(planId: string) {
    const result = await this.toolManager.provisionTrial(planId);
    this.logs.append(`${result.trial.serviceName}: trial ${result.trial.trialId} provisioned.`, 'Lifecycle', 'warn');
    return {
      ...result,
      snapshot: await this.readState(),
    };
  }

  async promoteToolTrial(trialId: string, serviceName?: string) {
    const result = await this.toolManager.promoteTrial(trialId, serviceName);
    this.logs.append(`${result.serviceName}: trial ${trialId} promoted to persistent service.`, 'Lifecycle', 'warn');
    return {
      ...result,
      snapshot: await this.readState(),
    };
  }

  async removeToolService(serviceName: string, mode: 'trial' | 'persistent', dryRun = true) {
    const result = await this.toolManager.removeService(serviceName, mode, dryRun);
    this.logs.append(result.summary, 'Lifecycle', dryRun ? 'info' : 'warn');
    return {
      ...result,
      snapshot: dryRun ? undefined : await this.readState(),
    };
  }

  async writeInfraConfig(input: WriteInfraConfigInput): Promise<WriteInfraConfigResult> {
    const result = await this.configRepository.writeInfraConfig(input);
    this.logs.append(`${input.targetFile} updated.`, 'Lifecycle');
    return result;
  }

  async getAvailablePort(startFrom?: number): Promise<PortResolution> {
    const state = await this.readState();
    if (!startFrom || startFrom === state.ports.startFrom) {
      return state.ports;
    }

    const scan = await this.portAllocator.findNextAvailablePort(startFrom);
    const recent = this.portAllocator.buildRecentEntries(state.services, scan);
    return {
      startFrom,
      nextFree: scan.nextFree,
      busy: scan.busy,
      busyText: scan.busy.length > 0 ? scan.busy.join(', ') : 'None',
      rule: `First free port above ${startFrom}`,
      recent,
    };
  }

  async executeTask(input: ExecuteTaskInput): Promise<{ result: TaskExecutionResult; snapshot: DashboardState }> {
    const result = await this.taskExecutor.execute(input);
    const snapshot = await this.readState();
    return { result, snapshot };
  }

  async executeWorkspaceLifecycle(action: 'up' | 'down'): Promise<WorkspaceLifecycleResult> {
    const result = await this.taskExecutor.executeWorkspaceLifecycle(action);
    for (const step of result.steps) {
      this.logs.append(`${step.name}: ${step.detail}`, step.ok ? 'Lifecycle' : 'Alerts', step.ok ? 'info' : 'error');
    }
    return result;
  }

  async readWorkspaceStatus(): Promise<WorkspaceStatus> {
    await this.configRepository.hydrateProcessEnv();
    const model = await this.configRepository.loadProjectModel();
    const runtime = await readWorkspaceRuntimeState(this.paths.root);
    const snapshot = await this.readState();
    return {
      workspaceRoot: this.paths.root,
      appRoot: this.paths.appRoot,
      systemId: model.env.LOCALLINK_SYSTEM_ID || runtime?.systemId || this.paths.root.split('/').pop() || 'system',
      api: runtime?.processes.api,
      dashboard: runtime?.processes.dashboard,
      services: {
        total: snapshot.services.length,
        running: snapshot.services.filter((service) => service.status === 'running').length,
        stopped: snapshot.services.filter((service) => service.status === 'stopped').length,
        unknown: snapshot.services.filter((service) => service.status === 'unknown').length,
      },
      ports: snapshot.ports,
    };
  }

  async readAiManifest() {
    const status = await this.readWorkspaceStatus();
    return {
      name: 'LocalLink',
      purpose: 'Local-first control plane for workspace services, ports, extensions, versions, and trials.',
      workspaceRoot: this.paths.root,
      runtimeStateFile: `${this.paths.root}/.locallink/runtime.json`,
      jsonOutput: {
        flag: '--json',
        env: 'LOCALLINK_JSON=true',
      },
      recommendedWorkflow: ['status --json', 'up --json', 'snapshot', 'down --json'],
      commands: [
        { command: 'ai --json', purpose: 'Describe agent-facing CLI capabilities.' },
        { command: 'status --json', purpose: 'Read assigned ports, URLs, and service counts.' },
        { command: 'up --json', purpose: 'Start API, active services, and enabled extensions.' },
        { command: 'down --json', purpose: 'Stop enabled extensions, active services, and API.' },
        { command: 'snapshot', purpose: 'Return full dashboard state as JSON.' },
        { command: 'doctor --json', purpose: 'Return startup diagnostics.' },
      ],
      currentStatus: status,
    };
  }

  async verifyServiceCompliance(serviceName: string): Promise<{ serviceName: string; compliance: ServiceCompliance; dockerfilePath?: string }> {
    await this.configRepository.hydrateProcessEnv();
    const model = await this.configRepository.loadProjectModel();
    const definition = model.definitions.find((candidate) => candidate.name === serviceName);
    if (!definition) {
      throw new AppError('UNKNOWN_SERVICE', `Service "${serviceName}" is not declared in the current workspace.`, 404);
    }

    return {
      serviceName: definition.name,
      dockerfilePath: definition.dockerfilePath,
      compliance: await verifyBlueprintCompliance(definition),
    };
  }

  async inspectProcess(pid: number): Promise<ProcessInspection> {
    return inspectProcess(pid);
  }

  async terminateProcess(pid: number, signal?: string): Promise<{ result: ProcessTerminationResult; snapshot: DashboardState }> {
    const result = await terminateProcess(pid, signal);
    this.logs.append(result.message, 'Lifecycle', result.ok ? 'warn' : 'error');
    const snapshot = await this.readState();
    return { result, snapshot };
  }

  async getBinding(surface: 'api' | 'dashboard' = 'api'): Promise<{ host: string; port: number }> {
    const model = await this.configRepository.loadProjectModel();
    const apiPort = model.env.LOCALLINK_API_PORT || model.env.LOCALLINK_WEB_PORT || '4010';
    const dashboardPort = model.env.LOCALLINK_DASHBOARD_PORT || model.env.LOCALLINK_WEB_PORT || apiPort;
    return {
      host: normalizeLoopbackBindHost(model.env.LOCALLINK_BIND_HOST),
      port: Number(surface === 'dashboard' ? dashboardPort : apiPort),
    };
  }

  async getStartupDiagnostics(refresh = false): Promise<StartupDiagnostics> {
    if (!this.startupDiagnostics || refresh) {
      this.startupDiagnostics = await this.startupDiagnosticsService.inspect();
    }

    return this.startupDiagnostics;
  }

  async attachLiveLogs(): Promise<void> {
    this.liveLogSubscribers += 1;
    if (this.liveLogSubscribers > 1) {
      return;
    }

    this.dockerTail = startStreamingCommand('docker', ['compose', 'logs', '--tail', '20', '-f'], {
      cwd: this.paths.root,
      captureOutput: false,
      onStdoutLine: (line) => this.logs.append(line, 'Docker'),
      onStderrLine: (line) => this.logs.append(line, 'Docker', 'warn'),
    });
    this.dockerTail.done.then((result) => {
      if (!result.ok && !result.signal && result.stderr) {
        this.logs.append('Docker log tail is unavailable in the current environment.', 'Alerts', 'warn');
      }
    });

    this.pm2Tail = startStreamingCommand('pm2', ['logs', '--lines', '20', '--raw'], {
      cwd: this.paths.root,
      captureOutput: false,
      onStdoutLine: (line) => this.logs.append(line, 'PM2'),
      onStderrLine: (line) => this.logs.append(line, 'PM2', 'warn'),
    });
    this.pm2Tail.done.then((result) => {
      if (!result.ok && !result.signal && result.stderr) {
        this.logs.append('PM2 log tail is unavailable in the current environment.', 'Alerts', 'warn');
      }
    });
  }

  detachLiveLogs(): void {
    this.liveLogSubscribers = Math.max(0, this.liveLogSubscribers - 1);
    if (this.liveLogSubscribers > 0) {
      return;
    }

    this.dockerTail?.stop();
    this.pm2Tail?.stop();
    this.dockerTail = undefined;
    this.pm2Tail = undefined;
  }

  createServer(options?: { dashboardEnabled?: boolean }) {
    return createHttpServer(this, options);
  }
}
