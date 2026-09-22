import fsSync, { type FSWatcher } from 'node:fs';
import fs from 'node:fs/promises';
import path from 'node:path';

import { ConfigRepository } from './config/files';
import { buildExtensionLifecycles } from './extensions/lifecycle';
import {
  IdentityPlanner,
  type IdentityApplyResult,
  type IdentityInstallPlan,
} from './extensions/identity-planner';
import {
  ObservabilityPlanner,
  type ObservabilityApplyResult,
  type ObservabilityInstallPlan,
} from './extensions/observability-planner';
import {
  ExtensionPlanner,
  type ExtensionApplyResult,
  type ExtensionInstallPlan,
  type ExtensionReloadResult,
  type ExtensionRouteApplyResult,
  type ExtensionRouteReconcileResult,
} from './extensions/planner';
import { createHttpServer } from './http/server';
import { LogBroker } from './logs/broker';
import {
  buildWorkspaceOnboardingReport,
  type OnboardingCapability,
  type OnboardingPlan,
  type WorkspaceOnboardingReport,
} from './onboarding/report';
import { PortAllocator } from './ports/allocator';
import { verifyBlueprintCompliance } from './runtime/lego';
import { withPm2WorkspaceLock } from './runtime/pm2-workspace';
import { inspectProcess, reviewProcessTermination, terminateProcess } from './runtime/resources';
import { WorkspaceStateRepository } from './state/workspace-state';
import { RuntimeResolver } from './runtime/snapshot';
import {
  buildApplicationServiceContract,
  resolveService,
  type ApplicationServiceContract,
} from './services/application-contract';
import { buildOidcCheck, type OidcCheckResult } from './services/oidc-check';
import { planAccessProfiles, renderAccessProfileCaddyfile, type AccessProfilePlanResult } from './runtime/access-profiles';
import {
  caddyReloadCommand,
  caddyStartCommand,
  caddyValidationCommand,
  detectCaddyRuntime,
  mergeManagedCaddyfile,
  readWorkspaceFile,
  writeWorkspaceCaddyfile,
} from './runtime/caddy-runtime';
import { detectTailscaleRuntime } from './runtime/tailscale-runtime';
import { MdnsDiscovery } from './runtime/mdns-discovery';
import { StartupDiagnosticsService } from './startup/diagnostics';
import { resolvePaths } from './shared/paths';
import { logDebug, logInfo, logWarn, mirrorBrokerEntry } from './shared/logger';
import { normalizeLoopbackBindHost } from './shared/network';
import { runCommand, startStreamingCommand, type StreamingCommandHandle } from './shared/utils';
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
  Pm2WorkspaceAction,
  Pm2WorkspaceExecutionResult,
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

async function captureReadOnlyPlan<T>(
  operation: Promise<T>,
  fallback: string,
): Promise<{ plan?: T; error?: string }> {
  try {
    return { plan: await operation };
  } catch (error) {
    return {
      error: error instanceof AppError ? error.message : fallback,
    };
  }
}

const AUTOMATIC_EXTENSION_RELOAD_FILES = new Set([
  '.env',
  'compose.yaml',
  'compose.yml',
  'docker-compose.yaml',
  'docker-compose.yml',
  'ecosystem.config.js',
  'locallink.services.yml',
  'locallink.extensions.yml',
]);

export class AppContext {
  readonly paths;

  readonly configRepository;

  readonly logs;

  readonly extensionPlanner;

  readonly identityPlanner;

  readonly observabilityPlanner;

  readonly portAllocator;

  readonly runtimeResolver;

  readonly taskExecutor;

  readonly startupDiagnosticsService;

  readonly workspaceState;

  private liveLogSubscribers = 0;

  private dockerTail?: StreamingCommandHandle;

  private pm2Tail?: StreamingCommandHandle;

  private startupDiagnostics?: StartupDiagnostics;

  private automaticExtensionReloadWatcher?: FSWatcher;

  private automaticExtensionReloadTimer?: NodeJS.Timeout;

  private automaticExtensionReloadPending = false;

  private automaticExtensionReloadInFlight?: Promise<void>;

  private automaticExtensionReloadEnabled = false;

  private localDiscoveries: MdnsDiscovery[] = [];

  constructor(root = process.cwd()) {
    this.paths = resolvePaths(root);
    // A LocalLink control-plane process belongs to exactly one workspace. Its
    // committed/local workspace files must not be shadowed by stale PM2
    // environment values inherited from an earlier restart.
    this.configRepository = new ConfigRepository(this.paths.root, false);
    this.logs = new LogBroker(mirrorBrokerEntry);
    this.workspaceState = new WorkspaceStateRepository(this.paths.workspaceStateFile);
    this.extensionPlanner = new ExtensionPlanner(this.paths.root, this.configRepository, undefined, this.workspaceState);
    this.identityPlanner = new IdentityPlanner(
      this.paths.root,
      this.configRepository,
      undefined,
      this.workspaceState,
      this.extensionPlanner,
    );
    this.observabilityPlanner = new ObservabilityPlanner(
      this.paths.root,
      this.configRepository,
      undefined,
      this.workspaceState,
      this.extensionPlanner,
    );
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
    await this.clearStaleRuntimeBinding();
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

  startAutomaticExtensionReload(): void {
    if (this.automaticExtensionReloadWatcher) return;

    this.automaticExtensionReloadEnabled = true;
    try {
      this.automaticExtensionReloadWatcher = fsSync.watch(
        this.paths.root,
        { persistent: false },
        (_eventType, filename) => {
          const name = filename ? path.basename(String(filename)) : '';
          if (!AUTOMATIC_EXTENSION_RELOAD_FILES.has(name)) return;
          this.automaticExtensionReloadPending = true;
          if (this.automaticExtensionReloadTimer) clearTimeout(this.automaticExtensionReloadTimer);
          this.automaticExtensionReloadTimer = setTimeout(() => {
            this.automaticExtensionReloadTimer = undefined;
            void this.flushAutomaticExtensionReload();
          }, 400);
        },
      );
      this.automaticExtensionReloadWatcher.on('error', (error) => {
        logWarn('Automatic extension reload watcher stopped.', {
          workspaceRoot: this.paths.root,
          error: error instanceof Error ? error.message : String(error),
        });
        this.logs.append('Automatic extension reload is unavailable because workspace configuration watching failed.', 'Alerts', 'warn');
        this.stopAutomaticExtensionReload();
      });
      this.automaticExtensionReloadWatcher.unref();
      logInfo('Automatic extension reload watcher started.', {
        workspaceRoot: this.paths.root,
        files: [...AUTOMATIC_EXTENSION_RELOAD_FILES],
      });
    } catch (error) {
      this.automaticExtensionReloadEnabled = false;
      logWarn('Could not start the automatic extension reload watcher.', {
        workspaceRoot: this.paths.root,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  stopAutomaticExtensionReload(): void {
    this.automaticExtensionReloadEnabled = false;
    this.automaticExtensionReloadPending = false;
    if (this.automaticExtensionReloadTimer) clearTimeout(this.automaticExtensionReloadTimer);
    this.automaticExtensionReloadTimer = undefined;
    this.automaticExtensionReloadWatcher?.close();
    this.automaticExtensionReloadWatcher = undefined;
  }

  private async flushAutomaticExtensionReload(): Promise<void> {
    if (!this.automaticExtensionReloadEnabled || this.automaticExtensionReloadInFlight) return;

    this.automaticExtensionReloadInFlight = (async () => {
      while (this.automaticExtensionReloadEnabled && this.automaticExtensionReloadPending) {
        this.automaticExtensionReloadPending = false;
        await this.reloadChangedPrivateEdge();
      }
    })();
    try {
      await this.automaticExtensionReloadInFlight;
    } finally {
      this.automaticExtensionReloadInFlight = undefined;
      if (this.automaticExtensionReloadEnabled && this.automaticExtensionReloadPending) {
        void this.flushAutomaticExtensionReload();
      }
    }
  }

  private async reloadChangedPrivateEdge(): Promise<void> {
    try {
      await this.configRepository.hydrateProcessEnv();
      const model = await this.configRepository.loadProjectModel();
      const privateEdge = model.extensions.find((extension) => (
        extension.kind === 'network-edge' && extension.enabled && extension.status !== 'disabled'
      ));
      if (!privateEdge) return;

      const result = await this.reloadExtension('private-edge');
      this.logs.append(
        result.reloaded
          ? `Workspace configuration changed; ${result.appliedRoutes.length} Private Edge route${result.appliedRoutes.length === 1 ? '' : 's'} refreshed automatically.`
          : `Workspace configuration changed; Private Edge remains pending: ${result.plan.summary}`,
        'Lifecycle',
        result.reloaded ? 'info' : 'warn',
      );
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.logs.append(`Automatic Private Edge reload failed: ${message}`, 'Alerts', 'error');
      logWarn('Automatic Private Edge reload failed.', {
        workspaceRoot: this.paths.root,
        error: message,
      });
    }
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

  async readApplicationContract(selector: string): Promise<ApplicationServiceContract> {
    await this.configRepository.hydrateProcessEnv();
    const model = await this.configRepository.loadProjectModel();
    const [edgePlan, identityResult, observabilityResult] = await Promise.all([
      this.extensionPlanner.plan('private-edge'),
      captureReadOnlyPlan(
        this.identityPlanner.plan('identity'),
        'The workspace identity plan could not be evaluated.',
      ),
      captureReadOnlyPlan(
        this.observabilityPlanner.plan('observability'),
        'The workspace observability plan could not be evaluated.',
      ),
    ]);
    return buildApplicationServiceContract({
      model,
      edgePlan,
      identityPlan: identityResult.plan,
      identityPlanError: identityResult.error,
      observabilityPlan: observabilityResult.plan,
      observabilityPlanError: observabilityResult.error,
      selector,
    });
  }

  async readOidcCheck(selector: string): Promise<OidcCheckResult> {
    return buildOidcCheck(await this.readApplicationContract(selector));
  }

  async readAccessProfilePlan(selector: string): Promise<AccessProfilePlanResult & { caddyfile?: string }> {
    await this.configRepository.hydrateProcessEnv();
    const model = await this.configRepository.loadProjectModel();
    const service = resolveService(model.definitions, selector);
    const declarations = service.integrations?.access?.endpoints ?? [];
    const [caddy, tailscale, edgePlan] = await Promise.all([
      detectCaddyRuntime(this.paths.root, runCommand),
      detectTailscaleRuntime(this.paths.root, runCommand),
      this.extensionPlanner.plan('private-edge'),
    ]);
    const route = edgePlan.routePlan.routes.find((entry) => entry.serviceId === service.id && entry.url);
    const tailscaleHostname = route?.url ? new URL(route.url).hostname : undefined;
    const directLan = declarations.some((entry) => entry.profile === 'lan-mdns' && entry.adapter === 'direct');
    const plan = planAccessProfiles({
      service: {
        id: service.id,
        name: service.name,
        runtimeName: service.runtimeName,
        runtime: service.runtime,
        port: service.port,
        upstreamHost: caddy.source === 'docker-compose' && caddy.networkMode !== 'host'
          ? 'host.docker.internal'
          : '127.0.0.1',
        listenHost: directLan ? declarations.find((entry) => entry.targetHost)?.targetHost : '127.0.0.1',
        loopbackOnly: !directLan,
        lanReachable: directLan,
      },
      declarations,
      runtime: {
        tailscaleAvailable: tailscale.source !== 'missing' && tailscale.running,
        tailscaleHostname,
        caddyAvailable: caddy.available && caddy.manageable && caddy.hostReachable !== false,
        mdnsAvailable: true,
        customDnsConfigured: declarations.some((entry) => entry.profile === 'tailscale-custom-domain')
          ? declarations.filter((entry) => entry.profile === 'tailscale-custom-domain').every((entry) => entry.dnsReady === true)
          : undefined,
      },
    });
    const caddyfile = renderAccessProfileCaddyfile(plan.profiles);
    return { ...plan, ...(caddyfile ? { caddyfile } : {}) };
  }

  async applyAccessProfileCaddy(): Promise<{ applied: boolean; profiles: number; configPath?: string }> {
    const model = await this.configRepository.loadProjectModel();
    const selectors = model.definitions
      .filter((service) => (service.integrations?.access?.endpoints.length ?? 0) > 0)
      .map((service) => service.id);
    const contracts = await Promise.all(selectors.map((selector) => this.readAccessProfilePlan(selector)));
    const allProfiles = contracts.flatMap((contract) => contract.profiles);
    const blocked = allProfiles.filter((profile) => profile.route?.caddyRequired && !profile.ready);
    if (blocked.length > 0) {
      const details = blocked.flatMap((profile) => profile.prerequisites.filter((item) => item.blocking).map((item) => item.detail));
      throw new AppError('ACCESS_PROFILE_NOT_READY', details.join(' ') || 'A Caddy-backed access profile has unmet prerequisites.', 409);
    }
    const profiles = allProfiles
      .filter((profile) => profile.route?.caddyRequired && profile.ready);
    const generated = renderAccessProfileCaddyfile(profiles);
    const runtime = await detectCaddyRuntime(this.paths.root, runCommand);
    if (!runtime.manageable || !runtime.configPath || !runtime.configTarget || !runtime.serviceName) {
      if (!allProfiles.some((profile) => profile.route?.caddyRequired)) return { applied: false, profiles: 0 };
      throw new AppError('ACCESS_CADDY_NOT_MANAGEABLE', 'Caddy-backed access profiles require a workspace Docker Caddy service with a mounted Caddyfile.', 409);
    }
    const previous = await readWorkspaceFile(runtime.configPath) ?? '';
    const hasManagedAccess = previous.includes('# BEGIN LOCALLINK MANAGED CUSTOM DOMAIN ROUTES')
      || previous.includes('# BEGIN LOCALLINK MANAGED LAN MDNS ROUTES');
    if (!hasManagedAccess && !allProfiles.some((profile) => profile.route?.caddyRequired)) {
      return { applied: false, profiles: 0 };
    }
    const merged = mergeManagedCaddyfile(previous, generated);
    const generatedPath = '.locallink/generated/access-profiles/Caddyfile';
    await writeWorkspaceCaddyfile(this.paths.root, generatedPath, merged);
    const validation = caddyValidationCommand(runtime, generatedPath);
    const valid = await runCommand(validation.command, validation.args, { cwd: this.paths.root, timeoutMs: 15_000 });
    if (!valid.ok) throw new AppError('ACCESS_CADDY_CONFIG_INVALID', valid.stderr || valid.error || 'Caddy rejected the access profile configuration.', 502);
    try {
      await writeWorkspaceCaddyfile(this.paths.root, path.relative(this.paths.root, runtime.configPath), merged);
      const lifecycle = runtime.running ? caddyReloadCommand(runtime) : caddyStartCommand(runtime);
      if (!lifecycle) throw new Error('No safe Caddy lifecycle command is available.');
      const result = await runCommand(lifecycle.command, lifecycle.args, { cwd: this.paths.root, timeoutMs: runtime.running ? 15_000 : 30_000 });
      if (!result.ok) throw new Error(result.stderr || result.error || `Caddy ${runtime.running ? 'reload' : 'start'} failed.`);
    } catch (error) {
      await writeWorkspaceCaddyfile(this.paths.root, path.relative(this.paths.root, runtime.configPath), previous);
      throw new AppError('ACCESS_CADDY_APPLY_FAILED', error instanceof Error ? error.message : String(error), 502);
    }
    return { applied: true, profiles: profiles.length, configPath: path.relative(this.paths.root, runtime.configPath) };
  }

  async startLocalDiscovery(): Promise<void> {
    await this.stopLocalDiscovery();
    const model = await this.configRepository.loadProjectModel();
    const services = model.definitions.filter((entry) => entry.integrations?.access?.endpoints.some((endpoint) => endpoint.profile === 'lan-mdns'));
    for (const service of services) {
      const contract = await this.readAccessProfilePlan(service.id);
      for (const profile of contract.profiles) {
        if (!profile.ready || profile.discovery?.kind !== 'mdns-dns-sd') continue;
        if (profile.route?.caddyRequired) {
          const runtime = await detectCaddyRuntime(this.paths.root, runCommand);
          const active = runtime.configPath ? await readWorkspaceFile(runtime.configPath) : undefined;
          if (!active?.includes(profile.discovery.hostname)) continue;
        }
        const discovery = new MdnsDiscovery({
          hostname: profile.discovery.hostname,
          serviceInstance: profile.discovery.instanceName,
          serviceType: `${profile.discovery.serviceType}.local`,
          port: profile.discovery.port,
          publicTxt: profile.discovery.txt,
        }, { onError: (error) => logWarn('mDNS discovery error.', { serviceId: service.id, error: error.message }) });
        try {
          await discovery.start();
          this.localDiscoveries.push(discovery);
        } catch (error) {
          logWarn('Could not start local mDNS discovery.', { serviceId: service.id, error: error instanceof Error ? error.message : String(error) });
        }
      }
    }
  }

  async stopLocalDiscovery(): Promise<void> {
    const active = this.localDiscoveries.splice(0);
    await Promise.allSettled(active.map((discovery) => discovery.stop()));
  }

  async readOnboardingReport(): Promise<WorkspaceOnboardingReport> {
    const [workspace, diagnostics, lifecycles] = await Promise.all([
      this.getWorkspaceIdentity(),
      this.getStartupDiagnostics(),
      this.readExtensionLifecycle(),
    ]);
    const capabilities: OnboardingCapability[] = ['private-edge', 'identity', 'observability'];
    const planResults = await Promise.all(capabilities.map(async (capability) => (
      captureReadOnlyPlan<OnboardingPlan>(
        this.planExtension(capability),
        `The ${capability} onboarding plan could not be evaluated.`,
      )
    )));
    return buildWorkspaceOnboardingReport({
      workspace,
      diagnostics,
      lifecycles,
      plans: Object.fromEntries(
        capabilities.map((capability, index) => [capability, planResults[index]]),
      ) as Record<OnboardingCapability, (typeof planResults)[number]>,
    });
  }

  async planExtension(
    capability: string,
    services?: string[],
  ): Promise<ExtensionInstallPlan | IdentityInstallPlan | ObservabilityInstallPlan> {
    return capability === 'identity'
      ? this.identityPlanner.plan(capability)
      : capability === 'observability'
        ? this.observabilityPlanner.plan(capability)
        : this.extensionPlanner.plan(capability, services);
  }

  async applyExtension(
    capability: string,
    services?: string[],
  ): Promise<ExtensionApplyResult | IdentityApplyResult | ObservabilityApplyResult> {
    const result = capability === 'identity'
      ? await this.identityPlanner.apply(capability)
      : capability === 'observability'
        ? await this.observabilityPlanner.apply(capability)
        : await this.extensionPlanner.apply(capability, services);
    this.logs.append(
      result.applied
        ? `${capability} workspace plan applied to ${result.changedFiles.join(', ')}.`
        : `${capability} workspace plan required no file changes.`,
      'Lifecycle',
    );
    return result;
  }

  async reloadExtension(capability: string, services?: string[]): Promise<ExtensionReloadResult> {
    const result = await this.extensionPlanner.reload(capability, services);
    this.logs.append(
      result.reloaded
        ? `${capability} extension reloaded; ${result.appliedRoutes.length} route${result.appliedRoutes.length === 1 ? '' : 's'} applied.`
        : `${capability} extension reload is waiting for the next required step: ${result.plan.summary}`,
      'Lifecycle',
      result.reloaded ? 'info' : 'warn',
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

  async executePm2WorkspaceAction(
    action: Pm2WorkspaceAction,
  ): Promise<{ result: Pm2WorkspaceExecutionResult; snapshot: DashboardState }> {
    const result = await this.taskExecutor.executePm2WorkspaceAction(action);
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

  private async clearStaleRuntimeBinding(): Promise<void> {
    try {
      const descriptor = JSON.parse(
        await fs.readFile(this.paths.runtimeStateFile, 'utf8'),
      ) as Partial<WorkspaceRuntimeDescriptor>;
      const pid = Number(descriptor.pid);
      const sameWorkspace = path.resolve(String(descriptor.root || '')) === path.resolve(this.paths.root);
      let alive = Number.isInteger(pid) && pid > 0;
      if (alive) {
        try {
          process.kill(pid, 0);
        } catch (error) {
          alive = (error as NodeJS.ErrnoException).code !== 'ESRCH';
        }
      }
      if (!sameWorkspace || !alive) {
        await fs.unlink(this.paths.runtimeStateFile);
        logInfo('Removed a stale workspace runtime descriptor.', {
          workspaceRoot: this.paths.root,
          stalePid: Number.isInteger(pid) ? pid : undefined,
        });
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
        logDebug('Could not reconcile the workspace runtime descriptor.', {
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
    if (this.liveLogSubscribers > 1 && this.dockerTail && this.pm2Tail) {
      return;
    }

    const model = await this.configRepository.loadProjectModel();
    const processEnv = buildWorkspaceProcessEnv(this.paths.root, model.env);

    if (!this.dockerTail) {
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
    }

    try {
      this.pm2Tail = await withPm2WorkspaceLock(
        this.paths.root,
        model.env,
        { allowSpawn: false },
        (pm2Env) => Promise.resolve(startStreamingCommand('pm2', ['logs', '--lines', '20', '--raw'], {
          cwd: this.paths.root,
          env: pm2Env,
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
        })),
      );
    } catch (error) {
      this.logs.append(
        error instanceof Error ? error.message : 'PM2 workspace isolation check failed.',
        'Alerts',
        'warn',
      );
    }
    if (!this.pm2Tail) {
      return;
    }
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
