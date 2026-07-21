import fs from 'node:fs/promises';

import { ConfigRepository } from './config/files';
import { buildExtensionLifecycles } from './extensions/lifecycle';
import {
  ExtensionPlanner,
  type ExtensionApplyResult,
  type ExtensionInstallPlan,
  type ExtensionRouteApplyResult,
  type ExtensionRouteReconcileResult,
} from './extensions/planner';
import { createHttpServer } from './http/server';
import { LogBroker } from './logs/broker';
import { PortAllocator } from './ports/allocator';
import { verifyBlueprintCompliance } from './runtime/lego';
import { inspectProcess, reviewProcessTermination, terminateProcess } from './runtime/resources';
import { WorkspaceStateRepository } from './state/workspace-state';
import { RuntimeResolver } from './runtime/snapshot';
import { StartupDiagnosticsService } from './startup/diagnostics';
import { resolvePaths } from './shared/paths';
import { logDebug, logInfo, mirrorBrokerEntry } from './shared/logger';
import { normalizeLoopbackBindHost } from './shared/network';
import { startStreamingCommand, type StreamingCommandHandle } from './shared/utils';
import { TaskExecutor } from './tasks/executor';
import {
  buildWorkspaceProcessEnv,
  deriveWorkspaceIdentity,
  resolveWorkspaceBinding,
  type WorkspaceBinding,
  type WorkspaceIdentity,
  type WorkspaceRuntimeDescriptor,
} from './workspace/identity';
import type {
  DashboardState,
  ExtensionLifecycleRecord,
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
  WorkspaceState,
} from './shared/contracts';
import { AppError } from './shared/errors';

export class AppContext {
  readonly paths;

  readonly configRepository;

  readonly logs;

  readonly extensionPlanner;

  readonly portAllocator;

  readonly runtimeResolver;

  readonly taskExecutor;

  readonly startupDiagnosticsService;

  readonly workspaceState;

  private liveLogSubscribers = 0;

  private dockerTail?: StreamingCommandHandle;

  private pm2Tail?: StreamingCommandHandle;

  private startupDiagnostics?: StartupDiagnostics;

  constructor(root = process.cwd()) {
    this.paths = resolvePaths(root);
    this.configRepository = new ConfigRepository(this.paths.root);
    this.logs = new LogBroker(mirrorBrokerEntry);
    this.workspaceState = new WorkspaceStateRepository(this.paths.workspaceStateFile);
    this.extensionPlanner = new ExtensionPlanner(this.paths.root, this.configRepository, undefined, this.workspaceState);
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
    await this.workspaceState.load();
    for (const reservation of this.workspaceState.read().portReservations.filter((entry) => entry.status === 'reserved')) {
      try {
        // Reclaim persisted advisory reservations when the control plane restarts.
        await this.portAllocator.reservePort(reservation.port);
      } catch {
        await this.workspaceState.update({
          portReservations: this.workspaceState.read().portReservations.map((entry) => entry.id === reservation.id ? { ...entry, status: 'conflict' } : entry),
        });
      }
    }
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

  async readExtensionLifecycle(): Promise<ExtensionLifecycleRecord[]> {
    await this.configRepository.hydrateProcessEnv();
    const model = await this.configRepository.loadProjectModel();
    return buildExtensionLifecycles(model.extensions, undefined, this.paths.root);
  }

  async planExtension(capability: string, services?: string[]): Promise<ExtensionInstallPlan> {
    return this.extensionPlanner.plan(capability, services);
  }

  async applyExtension(capability: string, services?: string[]): Promise<ExtensionApplyResult> {
    const result = await this.extensionPlanner.apply(capability, services);
    this.logs.append(
      result.applied
        ? `${capability} workspace plan applied to ${result.changedFiles.join(', ')}.`
        : `${capability} workspace plan required no file changes.`,
      'Lifecycle',
    );
    return result;
  }

  async applyExtensionRoutes(capability: string, confirmationToken: string): Promise<ExtensionRouteApplyResult> {
    const result = await this.extensionPlanner.applyRoutes(capability, confirmationToken);
    this.logs.append(
      result.applied
        ? `${result.appliedRoutes.length} ${capability} host route${result.appliedRoutes.length === 1 ? '' : 's'} applied and verified.`
        : `${capability} host routes already matched the generated plan.`,
      'Lifecycle',
    );
    return result;
  }

  async reconcileExtensionRoutes(capability: string, confirmationToken: string): Promise<ExtensionRouteReconcileResult> {
    const result = await this.extensionPlanner.reconcileRoutes(capability, confirmationToken);
    this.logs.append(
      result.reconciled
        ? `${result.removedRoutes.length} owned host route${result.removedRoutes.length === 1 ? '' : 's'} removed; ${result.forgottenRoutes.length} stale ownership record${result.forgottenRoutes.length === 1 ? '' : 's'} forgotten.`
        : `${capability} owned routes already match the workspace selection.`,
      'Lifecycle',
    );
    return result;
  }

  async writeInfraConfig(input: WriteInfraConfigInput): Promise<WriteInfraConfigResult> {
    const result = await this.configRepository.writeInfraConfig(input);
    this.logs.append(`${input.targetFile} updated.`, 'Lifecycle');
    return result;
  }

  async getAvailablePort(startFrom?: number, reserve = false, service = 'workspace allocation'): Promise<PortResolution> {
    const state = await this.readState();
    const requestedStart = startFrom || state.ports.startFrom;
    if (!reserve && (!startFrom || startFrom === state.ports.startFrom)) {
      return state.ports;
    }

    const scan = await this.portAllocator.findNextAvailablePort(requestedStart);
    const recent = this.portAllocator.buildRecentEntries(state.services, scan);
    const resolution = {
      startFrom: requestedStart,
      nextFree: scan.nextFree,
      busy: scan.busy,
      busyText: scan.busy.length > 0 ? scan.busy.join(', ') : 'None',
      rule: `First free port above ${requestedStart}`,
      recent,
    };
    if (reserve) {
      await this.reservePort(service, resolution.nextFree);
      resolution.recent = [{ service, port: String(resolution.nextFree), status: 'reserved' }, ...resolution.recent];
    }
    return resolution;
  }

  async reservePort(service: string, port: number): Promise<WorkspaceState> {
    await this.portAllocator.reservePort(port);
    return this.workspaceState.addPortReservation({
      id: `port-${Date.now()}`,
      service,
      port,
      status: 'reserved',
      createdAt: new Date().toISOString(),
    });
  }

  async releasePortReservation(id: string): Promise<WorkspaceState> {
    const reservation = this.workspaceState.read().portReservations.find((entry) => entry.id === id);
    if (reservation) this.portAllocator.releasePort(reservation.port);
    return this.workspaceState.releasePortReservation(id);
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

  async reviewProcessTermination(pid: number) {
    return reviewProcessTermination(pid);
  }

  async terminateProcess(pid: number, signal?: string, identityToken?: string, reason?: string): Promise<{ result: ProcessTerminationResult; snapshot: DashboardState }> {
    const result = await terminateProcess(pid, signal, identityToken);
    this.logs.append(`${result.message}${reason ? ` Reason: ${reason}` : ''}`, 'Lifecycle', result.ok ? 'warn' : 'error');
    const snapshot = await this.readState();
    return { result, snapshot };
  }

  async getWorkspaceIdentity(): Promise<WorkspaceIdentity> {
    const model = await this.configRepository.loadProjectModel();
    return deriveWorkspaceIdentity(this.paths.root, model.env.LOCALLINK_WORKSPACE_ID);
  }

  async getBinding(): Promise<WorkspaceBinding> {
    const model = await this.configRepository.loadProjectModel();
    return resolveWorkspaceBinding(
      model.env,
      normalizeLoopbackBindHost(model.env.LOCALLINK_BIND_HOST),
      this.portAllocator,
    );
  }

  async recordRuntimeBinding(binding: WorkspaceBinding): Promise<WorkspaceRuntimeDescriptor> {
    const identity = await this.getWorkspaceIdentity();
    const descriptor: WorkspaceRuntimeDescriptor = {
      ...identity,
      ...binding,
      pid: process.pid,
      url: `http://${binding.host}:${binding.port}`,
      startedAt: new Date().toISOString(),
    };
    await fs.mkdir(this.paths.stateDir, { recursive: true });
    const temporaryPath = `${this.paths.runtimeStateFile}.${process.pid}.tmp`;
    await fs.writeFile(temporaryPath, `${JSON.stringify(descriptor, null, 2)}\n`, 'utf8');
    await fs.rename(temporaryPath, this.paths.runtimeStateFile);
    return descriptor;
  }

  async clearRuntimeBinding(pid = process.pid): Promise<void> {
    try {
      const descriptor = JSON.parse(
        await fs.readFile(this.paths.runtimeStateFile, 'utf8'),
      ) as Partial<WorkspaceRuntimeDescriptor>;
      if (descriptor.pid === pid) {
        await fs.unlink(this.paths.runtimeStateFile);
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
        logDebug('Could not clear the workspace runtime descriptor.', {
          workspaceRoot: this.paths.root,
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }
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

    const model = await this.configRepository.loadProjectModel();
    const processEnv = buildWorkspaceProcessEnv(this.paths.root, model.env);

    this.dockerTail = startStreamingCommand('docker', ['compose', 'logs', '--tail', '20', '-f'], {
      cwd: this.paths.root,
      env: processEnv,
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
      env: processEnv,
      onStdoutLine: (line) => {
        if (!isPm2LogEcho(line)) {
          this.logs.append(line, 'PM2');
        }
      },
      onStderrLine: (line) => {
        if (!isPm2LogEcho(line)) {
          this.logs.append(line, 'PM2', 'warn');
        }
      },
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

function isPm2LogEcho(line: string): boolean {
  return /\[WARN\]\s+\[PM2\]/.test(line);
}
