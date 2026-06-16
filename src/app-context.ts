import { ConfigRepository } from './config/files';
import { createHttpServer } from './http/server';
import { LogBroker } from './logs/broker';
import { PortAllocator } from './ports/allocator';
import { verifyBlueprintCompliance } from './runtime/lego';
import { inspectProcess, terminateProcess } from './runtime/resources';
import { RuntimeResolver } from './runtime/snapshot';
import { StartupDiagnosticsService } from './startup/diagnostics';
import { resolvePaths } from './shared/paths';
import { logDebug, logInfo, mirrorBrokerEntry } from './shared/logger';
import { startStreamingCommand, type StreamingCommandHandle } from './shared/utils';
import { TaskExecutor } from './tasks/executor';
import type {
  DashboardState,
  ExecuteTaskInput,
  InfraConfigView,
  ProcessInspection,
  ProcessTerminationResult,
  PortResolution,
  ServiceCompliance,
  StartupDiagnostics,
  TaskExecutionResult,
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
    this.taskExecutor = new TaskExecutor(this.paths.root, this.configRepository, this.logs);
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

  async getBinding(): Promise<{ host: string; port: number }> {
    const model = await this.configRepository.loadProjectModel();
    return {
      host: model.env.LOCALLINK_BIND_HOST || '127.0.0.1',
      port: Number(model.env.LOCALLINK_WEB_PORT || '4010'),
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

  createServer() {
    return createHttpServer(this);
  }
}
