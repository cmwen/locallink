import path from 'node:path';

import { ConfigRepository } from '../config/files';
import {
  buildManagedTailscaleServeConfig,
  resolvePrivateEdgeRouteAdapter,
  type PrivateEdgeRemovalPlan,
  type PrivateEdgeRoutePlan,
} from '../runtime/network-edge';
import {
  caddyReloadCommand,
  caddyStartCommand,
  caddyStopCommand,
  detectCaddyRuntime,
  mergeManagedCaddyfile,
  removeWorkspaceFile,
  readWorkspaceFile,
  writeWorkspaceCaddyfile,
} from '../runtime/caddy-runtime';
import {
  detectTailscaleRuntime,
  tailscaleStartCommand,
  tailscaleStopCommand,
} from '../runtime/tailscale-runtime';
import type { ExtensionLifecycleRecord, PrivateEdgeRuntimeOwnership, WorkspaceExtension } from '../shared/contracts';
import { AppError } from '../shared/errors';
import type { CommandRunner } from '../shared/utils';
import { runCommand } from '../shared/utils';
import { WorkspaceStateRepository } from '../state/workspace-state';
import { deriveWorkspaceIdentity } from '../workspace/identity';
import { buildExtensionLifecycles } from './lifecycle';

export type InstallableCapabilityId = 'private-edge';
export type ExtensionPlanStepStatus = 'complete' | 'pending' | 'blocked';

export interface ExtensionPlanStep {
  id: string;
  label: string;
  owner: 'locallink' | 'user' | 'system';
  status: ExtensionPlanStepStatus;
  automatic: boolean;
  detail: string;
  targetFile?: string;
}

export interface ExtensionInstallPlan {
  workspace: ReturnType<typeof deriveWorkspaceIdentity>;
  capability: InstallableCapabilityId;
  state: 'ready-to-apply' | 'ready-to-route' | 'ready-to-reconcile' | 'waiting-user' | 'complete';
  summary: string;
  canApply: boolean;
  selection: {
    requested: boolean;
    selected: Array<{ id: string; name: string; port: string }>;
    available: Array<{ id: string; name: string; port: string }>;
  };
  routePlan: PrivateEdgeRoutePlan;
  reconciliation: PrivateEdgeRemovalPlan;
  steps: ExtensionPlanStep[];
}

export interface ExtensionApplyResult {
  capability: InstallableCapabilityId;
  applied: boolean;
  changedFiles: string[];
  plan: ExtensionInstallPlan;
}

export interface ExtensionRouteApplyResult {
  capability: InstallableCapabilityId;
  applied: boolean;
  appliedRoutes: Array<{
    serviceId: string;
    serviceName: string;
    targetPort: string;
    httpsPort: string;
    url?: string;
  }>;
  plan: ExtensionInstallPlan;
}

export interface ExtensionRouteReconcileResult {
  capability: InstallableCapabilityId;
  reconciled: boolean;
  removedRoutes: string[];
  forgottenRoutes: string[];
  plan: ExtensionInstallPlan;
}

function envValue(content: string, key: string): string | undefined {
  const match = content.match(new RegExp(`^\\s*${key}\\s*=\\s*(.*?)\\s*$`, 'm'));
  return match?.[1]?.replace(/^['"]|['"]$/g, '');
}

const CADDY_BACKUP_PATH = '.locallink/backups/private-edge/Caddyfile.original';
const TAILSCALE_SERVE_BACKUP_PATH = '.locallink/backups/private-edge/tailscale-serve.original.json';

function syntheticPrivateEdge(existing?: WorkspaceExtension, inferredAdapter = 'tailscale-serve'): WorkspaceExtension {
  return {
    id: existing?.id || 'private-edge',
    name: existing?.name || 'Private Edge',
    kind: 'network-edge',
    enabled: true,
    detail: existing?.detail || 'Publishes selected workspace services privately through Tailscale Serve.',
    status: 'ready',
    command: existing?.command || 'tailscale',
    adapter: existing?.adapter || inferredAdapter,
    exposedPorts: existing?.exposedPorts || [],
    requiredEnv: existing?.requiredEnv || [],
    missingEnv: existing?.missingEnv || [],
    dependsOn: existing?.dependsOn || [],
    docsUrl: existing?.docsUrl || 'https://tailscale.com/docs/features/tailscale-serve',
  };
}

function runtimeSteps(lifecycle: ExtensionLifecycleRecord, routePlan: PrivateEdgeRoutePlan): ExtensionPlanStep[] {
  if (routePlan.state === 'in-sync') {
    return [{
      id: 'verify-private-edge',
      label: 'Verify workspace routes',
      owner: 'locallink',
      status: 'complete',
      automatic: true,
      detail: routePlan.summary,
    }];
  }

  if (lifecycle.state === 'waiting-external') {
    return [{
      id: 'install-tailscale',
      label: 'Install Tailscale',
      owner: 'user',
      status: 'pending',
      automatic: false,
      detail: 'Install Tailscale for this machine. LocalLink will verify the CLI after installation.',
    }];
  }

  if (lifecycle.state === 'waiting-user') {
    return [{
      id: 'join-tailnet',
      label: 'Join and authorize the tailnet',
      owner: 'user',
      status: 'pending',
      automatic: false,
      detail: 'Authenticate the machine, enable private HTTPS if required, and approve the tailnet access policy.',
    }];
  }

  return [{
    id: 'generate-tailscale-routes',
    label: 'Generate and verify Tailscale Serve routes',
    owner: 'locallink',
    status: routePlan.state === 'ready' ? 'pending' : 'blocked',
    automatic: true,
    detail: routePlan.summary,
  }];
}

function sameValues(left: string[], right: string[]): boolean {
  return [...new Set(left)].sort().join('\n') === [...new Set(right)].sort().join('\n');
}

export class ExtensionPlanner {
  constructor(
    private readonly root: string,
    private readonly configRepository = new ConfigRepository(root),
    private readonly commandRunner: CommandRunner = runCommand,
    private readonly workspaceState = new WorkspaceStateRepository(path.join(root, '.locallink', 'workspace-state.json')),
  ) {}

  async plan(capability: string, serviceSelectors?: string[]): Promise<ExtensionInstallPlan> {
    if (capability !== 'private-edge') {
      throw new AppError(
        'UNSUPPORTED_EXTENSION_CAPABILITY',
        `Extension planning currently supports "private-edge"; received "${capability}".`,
        400,
      );
    }

    await this.configRepository.hydrateProcessEnv();
    const [model, infra] = await Promise.all([
      this.configRepository.loadProjectModel(),
      this.configRepository.readInfraConfig(),
    ]);
    const existing = model.extensions.find((extension) => extension.kind === 'network-edge');
    let inferredAdapter = existing?.adapter;
    if (!inferredAdapter) {
      const [caddyRuntime, tailscaleRuntime] = await Promise.all([
        detectCaddyRuntime(this.root, this.commandRunner),
        detectTailscaleRuntime(this.root, this.commandRunner, existing?.command || 'tailscale'),
      ]);
      inferredAdapter = caddyRuntime.source === 'docker-compose'
        && tailscaleRuntime.source === 'docker-compose'
        && caddyRuntime.networkMode === `service:${tailscaleRuntime.serviceName}`
        ? 'tailscale-caddy'
        : 'tailscale-serve';
    }
    const privateEdge = syntheticPrivateEdge(existing, inferredAdapter);
    const routeAdapter = resolvePrivateEdgeRouteAdapter(privateEdge.adapter, privateEdge.command || 'tailscale');
    const availableServices = model.definitions
      .filter((service) => Boolean(service.port && service.port !== '—'))
      .map((service) => ({ id: service.id, name: service.name, port: service.port! }));
    const requestedSelection = serviceSelectors !== undefined;
    const selectedServices = requestedSelection
      ? serviceSelectors.map((selector) => {
          const normalized = selector.toLowerCase();
          const service = availableServices.find((candidate) => (
            candidate.id.toLowerCase() === normalized || candidate.name.toLowerCase() === normalized
          ));
          if (!service) {
            throw new AppError(
              'UNKNOWN_EDGE_SERVICE',
              `Service "${selector}" does not have a declared workspace port. Available services: ${availableServices.map((candidate) => `${candidate.name} (${candidate.id})`).join(', ') || 'none'}.`,
              400,
            );
          }
          return service;
        }).filter((service, index, values) => values.findIndex((candidate) => candidate.id === service.id) === index)
      : availableServices.filter((service) => privateEdge.exposedPorts.includes(service.port));
    const selectedPorts = selectedServices.map((service) => service.port);
    const workspace = deriveWorkspaceIdentity(this.root, model.env.LOCALLINK_WORKSPACE_ID);
    const lifecycleExtensions = [
      ...model.extensions.filter((extension) => extension.kind !== 'network-edge'),
      privateEdge,
    ];
    const lifecycle = (await buildExtensionLifecycles(
      lifecycleExtensions,
      this.commandRunner,
      this.root,
    )).find((record) => record.id === 'private-edge');
    if (!lifecycle) {
      throw new AppError('EXTENSION_PLAN_FAILED', 'Private Edge lifecycle could not be evaluated.', 500);
    }
    const routePlan = await routeAdapter.planRoutes(
      workspace.id,
      selectedServices,
      this.commandRunner,
      model.env.LOCALLINK_PRIVATE_EDGE_PORT_START,
      this.root,
    );
    await this.workspaceState.load();
    const reconciliation = await routeAdapter.planRemovals(
      workspace.id,
      this.workspaceState.read().privateEdgeRoutes,
      routePlan.routes,
      this.commandRunner,
      this.root,
    );

    const envContent = infra.files.find((file) => file.targetFile === '.env')?.content || '';
    const declarationReady = Boolean(existing?.enabled);
    const preferenceReady = envValue(envContent, 'LOCALLINK_PHASE2_PREFERRED_EDGE') === 'tailscale';
    const selectionReady = selectedServices.length > 0;
    const selectionPersisted = !requestedSelection || sameValues(privateEdge.exposedPorts, selectedPorts);
    const workspaceSteps: ExtensionPlanStep[] = [
      {
        id: 'declare-private-edge',
        label: 'Declare Private Edge for this workspace',
        owner: 'locallink',
        status: declarationReady ? 'complete' : 'pending',
        automatic: true,
        targetFile: 'locallink.extensions.yml',
        detail: declarationReady
          ? `The ${existing?.id} network-edge declaration is enabled.`
          : 'Add an enabled, provider-neutral network-edge declaration using the Tailscale CLI adapter.',
      },
      {
        id: 'prefer-tailscale-edge',
        label: 'Set the workspace edge preference',
        owner: 'locallink',
        status: preferenceReady ? 'complete' : 'pending',
        automatic: true,
        targetFile: '.env',
        detail: preferenceReady
          ? 'LOCALLINK_PHASE2_PREFERRED_EDGE already selects Tailscale.'
          : 'Set LOCALLINK_PHASE2_PREFERRED_EDGE=tailscale in the local workspace environment.',
      },
      {
        id: 'select-edge-services',
        label: 'Select services for private exposure',
        owner: 'user',
        status: selectionReady ? 'complete' : 'pending',
        automatic: false,
        detail: selectionReady
          ? `Selected: ${selectedServices.map((service) => `${service.name} (:${service.port})`).join(', ')}.`
          : 'Choose the declared workspace services that may be reachable through the tailnet. LocalLink will not expose every service implicitly.',
      },
      {
        id: 'persist-edge-selection',
        label: 'Persist the workspace edge selection',
        owner: 'locallink',
        status: selectionPersisted ? 'complete' : 'pending',
        automatic: true,
        targetFile: 'locallink.extensions.yml',
        detail: selectionPersisted
          ? selectionReady ? 'The selected service ports are recorded in the network-edge declaration.' : 'No new service selection was requested.'
          : `Record selected ports ${selectedPorts.join(', ')} in the network-edge declaration.`,
      },
    ];
    const reconciliationStep: ExtensionPlanStep = {
      id: 'reconcile-private-edge-routes',
      label: 'Reconcile LocalLink-owned Private Edge routes',
      owner: 'locallink',
      status: reconciliation.state === 'clean' ? 'complete' : reconciliation.state === 'ready' ? 'pending' : 'blocked',
      automatic: true,
      detail: reconciliation.summary,
    };
    const steps = [...workspaceSteps, ...runtimeSteps(lifecycle, routePlan), reconciliationStep];
    const canApply = workspaceSteps.some((step) => step.owner === 'locallink' && step.status === 'pending');
    const complete = steps.every((step) => step.status === 'complete');

    return {
      workspace,
      capability: 'private-edge',
      state: complete
        ? 'complete'
        : canApply
          ? 'ready-to-apply'
          : reconciliation.state === 'ready'
            ? 'ready-to-reconcile'
            : routePlan.state === 'ready'
              ? 'ready-to-route'
              : 'waiting-user',
      summary: complete
        ? 'Private Edge is declared and healthy for this workspace.'
        : canApply
          ? 'LocalLink can apply the workspace-owned declaration changes. External security decisions remain explicit steps.'
          : reconciliation.state === 'ready' ? reconciliation.summary : routePlan.summary,
      canApply,
      selection: {
        requested: requestedSelection,
        selected: selectedServices,
        available: availableServices,
      },
      routePlan,
      reconciliation,
      steps,
    };
  }

  async apply(capability: string, serviceSelectors?: string[]): Promise<ExtensionApplyResult> {
    const before = await this.plan(capability, serviceSelectors);
    const changedFiles: string[] = [];
    if (!before.canApply) {
      return { capability: before.capability, applied: false, changedFiles, plan: before };
    }

    const declarationStep = before.steps.find((step) => step.id === 'declare-private-edge');
    const selectionStep = before.steps.find((step) => step.id === 'persist-edge-selection');
    if (declarationStep?.status === 'pending' || selectionStep?.status === 'pending') {
      const model = await this.configRepository.loadProjectModel();
      const existing = model.extensions.find((extension) => extension.kind === 'network-edge');
      await this.configRepository.writeInfraConfig({
        targetFile: 'locallink.extensions.yml',
        patch: {
          kind: 'extension',
          extensionId: existing?.id || 'private-edge',
          updates: {
            name: existing?.name || 'Private Edge',
            kind: 'network-edge',
            enabled: true,
            detail: existing?.detail || 'Publishes selected workspace services privately through Tailscale Serve.',
            command: existing?.command || 'tailscale',
            adapter: before.routePlan.adapter,
            docsUrl: existing?.docsUrl || 'https://tailscale.com/docs/features/tailscale-serve',
            ...(before.selection.requested ? { exposedPorts: before.selection.selected.map((service) => service.port) } : {}),
          },
        },
      });
      changedFiles.push('locallink.extensions.yml');
    }

    const preferenceStep = before.steps.find((step) => step.id === 'prefer-tailscale-edge');
    if (preferenceStep?.status === 'pending') {
      await this.configRepository.writeInfraConfig({
        targetFile: '.env',
        patch: {
          kind: 'env',
          set: { LOCALLINK_PHASE2_PREFERRED_EDGE: 'tailscale' },
        },
      });
      changedFiles.push('.env');
    }

    return {
      capability: 'private-edge',
      applied: changedFiles.length > 0,
      changedFiles,
      plan: await this.plan('private-edge'),
    };
  }

  async applyRoutes(capability: string, confirmationToken: string): Promise<ExtensionRouteApplyResult> {
    const before = await this.plan(capability);
    if (before.canApply) {
      throw new AppError(
        'PRIVATE_EDGE_WORKSPACE_PLAN_PENDING',
        'Apply the workspace-owned Private Edge declaration plan before applying host routes.',
        409,
      );
    }
    if (before.reconciliation.state === 'ready') {
      throw new AppError(
        'PRIVATE_EDGE_RECONCILIATION_PENDING',
        'Reconcile stale LocalLink-owned routes before applying new Private Edge routes.',
        409,
      );
    }
    if (!before.routePlan.applySupported) {
      throw new AppError(
        'PRIVATE_EDGE_ADAPTER_APPLY_BLOCKED',
        `${before.routePlan.adapter} cannot be applied yet: ${before.routePlan.summary}`,
        409,
      );
    }
    if (before.routePlan.state === 'in-sync') {
      const pendingRuntime = before.routePlan.adapter === 'tailscale-caddy'
        ? this.workspaceState.read().privateEdgeRuntime
        : undefined;
      if (pendingRuntime && pendingRuntime.status !== 'active') {
        const appliedAt = new Date().toISOString();
        await this.workspaceState.upsertPrivateEdgeRoutes(before.routePlan.routes.map((route) => ({
          serviceId: route.serviceId,
          adapter: before.routePlan.adapter,
          serviceName: route.serviceName,
          targetPort: route.targetPort,
          proxyPort: route.proxyPort,
          httpsPort: route.httpsPort,
          url: route.url,
          command: route.apply.command,
          applyArgs: route.apply.args,
          rollbackArgs: route.rollback.args,
          appliedAt,
          status: 'active',
        })));
        await this.workspaceState.setPrivateEdgeRuntime({
          ...pendingRuntime,
          status: 'active',
          updatedAt: appliedAt,
        });
      }
      return { capability: 'private-edge', applied: false, appliedRoutes: [], plan: before };
    }
    if (before.routePlan.state !== 'ready' || !before.routePlan.confirmationToken) {
      throw new AppError(
        'PRIVATE_EDGE_ROUTES_NOT_READY',
        before.routePlan.summary,
        409,
        { routePlan: before.routePlan },
      );
    }
    if (confirmationToken !== before.routePlan.confirmationToken) {
      throw new AppError(
        'STALE_PRIVATE_EDGE_CONFIRMATION',
        'The confirmation token does not match the current live route plan. Preview the plan again before applying it.',
        409,
      );
    }

    const routes = before.routePlan.routes.filter((route) => route.status === 'missing');
    const applied: typeof routes = [];
    let caddyConfigPath: string | undefined;
    let caddyPreviousContent: string | undefined;
    let caddyPreviousExisted = false;
    let caddyConfigChanged = false;
    let caddyWasRunning = false;
    let caddyStartAttempted = false;
    let caddyStartedThisAttempt = false;
    let tailscaleConfigPath: string | undefined;
    let tailscalePreviousContent: string | undefined;
    let tailscalePreviousExisted = false;
    let tailscaleConfigChanged = false;
    let tailscaleWasRunning = false;
    let tailscaleStartAttempted = false;
    let tailscaleStartedThisAttempt = false;
    let previousRuntimeOwnership: PrivateEdgeRuntimeOwnership | undefined;
    let pendingRuntimeOwnership: PrivateEdgeRuntimeOwnership | undefined;
    try {
      if (before.routePlan.adapter === 'tailscale-caddy') {
        const runtime = before.routePlan.runtime;
        const generatedFile = before.routePlan.generatedFiles.find((file) => file.kind === 'caddyfile');
        const generatedTailscaleFile = before.routePlan.generatedFiles.find((file) => file.kind === 'tailscale-serve-config');
        const tailscaleRuntime = runtime?.tailscale;
        if (!runtime?.manageable || !runtime.configPath || !runtime.configTarget || !generatedFile?.validate) {
          throw new AppError(
            'PRIVATE_EDGE_CADDY_RUNTIME_NOT_MANAGEABLE',
            'LocalLink cannot safely manage this Caddy service. It must mount its Caddyfile from inside the active workspace.',
            409,
          );
        }
        if (tailscaleRuntime?.source === 'docker-compose' && (
          !tailscaleRuntime.manageable
          || !tailscaleRuntime.serviceName
          || !tailscaleRuntime.configPath
          || !tailscaleRuntime.configTarget
          || !generatedTailscaleFile
        )) {
          throw new AppError(
            'PRIVATE_EDGE_TAILSCALE_RUNTIME_NOT_MANAGEABLE',
            'LocalLink cannot safely manage this Tailscale sidecar. It must set TS_SERVE_CONFIG and mount it from inside the active workspace.',
            409,
          );
        }

        await writeWorkspaceCaddyfile(this.root, generatedFile.path, generatedFile.content);
        const validation = await this.commandRunner(
          generatedFile.validate.command,
          generatedFile.validate.args,
          { cwd: this.root, timeoutMs: 15_000 },
        );
        if (!validation.ok) {
          throw new AppError(
            'PRIVATE_EDGE_CADDY_CONFIG_INVALID',
            `Caddy rejected the generated workspace configuration: ${validation.stderr || validation.error || `exit ${validation.code}`}.`,
            502,
          );
        }

        await this.workspaceState.load();
        previousRuntimeOwnership = this.workspaceState.read().privateEdgeRuntime;
        const relativeConfigPath = path.relative(this.root, runtime.configPath);
        const relativeTailscaleConfigPath = tailscaleRuntime?.configPath
          ? path.relative(this.root, tailscaleRuntime.configPath)
          : undefined;
        if (previousRuntimeOwnership && (
          previousRuntimeOwnership.adapter !== 'tailscale-caddy'
          || previousRuntimeOwnership.serviceName !== runtime.serviceName
          || previousRuntimeOwnership.configPath !== relativeConfigPath
          || (relativeTailscaleConfigPath && (
            previousRuntimeOwnership.tailscale?.serviceName !== tailscaleRuntime?.serviceName
            || previousRuntimeOwnership.tailscale?.configPath !== relativeTailscaleConfigPath
          ))
        )) {
          throw new AppError(
            'PRIVATE_EDGE_CADDY_OWNERSHIP_CONFLICT',
            'The saved Caddy runtime ownership does not match the active workspace Compose service. Reconcile or repair the saved runtime before applying routes.',
            409,
          );
        }

        caddyConfigPath = runtime.configPath;
        caddyPreviousContent = await readWorkspaceFile(caddyConfigPath);
        caddyPreviousExisted = caddyPreviousContent !== undefined;
        if (!previousRuntimeOwnership) {
          await writeWorkspaceCaddyfile(this.root, CADDY_BACKUP_PATH, caddyPreviousContent ?? '');
        }
        let tailscaleOwnership = previousRuntimeOwnership?.tailscale;
        if (tailscaleRuntime?.source === 'docker-compose' && tailscaleRuntime.configPath && relativeTailscaleConfigPath) {
          tailscaleConfigPath = tailscaleRuntime.configPath;
          tailscalePreviousContent = await readWorkspaceFile(tailscaleRuntime.configPath);
          tailscalePreviousExisted = tailscalePreviousContent !== undefined;
          if (!tailscaleOwnership) {
            await writeWorkspaceCaddyfile(this.root, TAILSCALE_SERVE_BACKUP_PATH, tailscalePreviousContent ?? '');
          }
          tailscaleOwnership = {
            serviceName: tailscaleRuntime.serviceName!,
            configPath: relativeTailscaleConfigPath,
            configTarget: tailscaleRuntime.configTarget!,
            backupPath: tailscaleOwnership?.backupPath || TAILSCALE_SERVE_BACKUP_PATH,
            configExisted: tailscaleOwnership?.configExisted ?? tailscalePreviousExisted,
            startedByLocalLink: tailscaleOwnership?.startedByLocalLink || !tailscaleRuntime.running,
          };
        }
        pendingRuntimeOwnership = {
          adapter: 'tailscale-caddy',
          serviceName: runtime.serviceName!,
          configPath: relativeConfigPath,
          configTarget: runtime.configTarget,
          backupPath: previousRuntimeOwnership?.backupPath || CADDY_BACKUP_PATH,
          configExisted: previousRuntimeOwnership?.configExisted ?? caddyPreviousExisted,
          startedByLocalLink: previousRuntimeOwnership?.startedByLocalLink || !runtime.running,
          ...(tailscaleOwnership ? { tailscale: tailscaleOwnership } : {}),
          status: 'applying',
          updatedAt: new Date().toISOString(),
        };
        await this.workspaceState.setPrivateEdgeRuntime(pendingRuntimeOwnership);
        caddyWasRunning = runtime.running;
        tailscaleWasRunning = tailscaleRuntime?.running ?? true;
        const existing = caddyPreviousContent ?? '';
        await writeWorkspaceCaddyfile(this.root, relativeConfigPath, mergeManagedCaddyfile(existing, generatedFile.content));
        caddyConfigChanged = true;
        if (tailscaleConfigPath && generatedTailscaleFile) {
          await writeWorkspaceCaddyfile(this.root, path.relative(this.root, tailscaleConfigPath), generatedTailscaleFile.content);
          tailscaleConfigChanged = true;
        }
        if (tailscaleRuntime?.source === 'docker-compose' && !tailscaleRuntime.running) {
          tailscaleStartAttempted = true;
          const start = tailscaleStartCommand(tailscaleRuntime);
          if (!start) throw new AppError('PRIVATE_EDGE_TAILSCALE_START_UNSUPPORTED', 'LocalLink could not derive a safe Docker Compose Tailscale start command.', 409);
          const started = await this.commandRunner(start.command, start.args, { cwd: this.root, timeoutMs: 30_000 });
          if (!started.ok) {
            throw new AppError(
              'PRIVATE_EDGE_TAILSCALE_START_FAILED',
              `The Tailscale configuration was written but the Compose service did not start: ${started.stderr || started.error || `exit ${started.code}`}.`,
              502,
            );
          }
          tailscaleStartedThisAttempt = true;
        }
        if (!runtime.running) {
          caddyStartAttempted = true;
          const start = caddyStartCommand(runtime);
          if (!start) throw new AppError('PRIVATE_EDGE_CADDY_START_UNSUPPORTED', 'LocalLink could not derive a safe Docker Compose Caddy start command.', 409);
          const started = await this.commandRunner(start.command, start.args, { cwd: this.root, timeoutMs: 30_000 });
          if (!started.ok) {
            throw new AppError(
              'PRIVATE_EDGE_CADDY_START_FAILED',
              `Caddy configuration was written but the Compose service did not start: ${started.stderr || started.error || `exit ${started.code}`}.`,
              502,
            );
          }
          caddyStartedThisAttempt = true;
        }
        const reload = caddyReloadCommand(runtime);
        if (!reload) {
          throw new AppError('PRIVATE_EDGE_CADDY_RELOAD_UNSUPPORTED', 'LocalLink could not derive a safe Docker Compose Caddy reload command.', 409);
        }
        const reloaded = await this.commandRunner(reload.command, reload.args, { cwd: this.root, timeoutMs: 15_000 });
        if (!reloaded.ok) {
          throw new AppError(
            'PRIVATE_EDGE_CADDY_RELOAD_FAILED',
            `Caddy configuration was written but reload failed: ${reloaded.stderr || reloaded.error || `exit ${reloaded.code}`}.`,
            502,
          );
        }
      }

      for (const route of routes) {
        // Route commands are generated as argument arrays so no shell parsing is involved.
        // eslint-disable-next-line no-await-in-loop
        const result = await this.commandRunner(route.apply.command, route.apply.args, { cwd: this.root, timeoutMs: 10_000 });
        if (!result.ok) {
          throw new AppError(
            'PRIVATE_EDGE_ROUTE_COMMAND_FAILED',
            `Tailscale could not publish ${route.serviceName}: ${result.stderr || result.error || `exit ${result.code}`}.`,
            502,
          );
        }
        applied.push(route);
      }

      const verified = await this.plan(capability);
      if (verified.routePlan.state !== 'in-sync') {
        throw new AppError(
          'PRIVATE_EDGE_ROUTE_VERIFICATION_FAILED',
          `Tailscale accepted the route commands, but verification failed: ${verified.routePlan.summary}`,
          502,
        );
      }

      await this.workspaceState.load();
      const appliedAt = new Date().toISOString();
      await this.workspaceState.upsertPrivateEdgeRoutes(applied.map((route) => ({
        serviceId: route.serviceId,
        adapter: before.routePlan.adapter,
        serviceName: route.serviceName,
        targetPort: route.targetPort,
        proxyPort: route.proxyPort,
        httpsPort: route.httpsPort,
        url: route.url,
        command: route.apply.command,
        applyArgs: route.apply.args,
        rollbackArgs: route.rollback.args,
        appliedAt,
        status: 'active',
      })));
      if (pendingRuntimeOwnership) {
        await this.workspaceState.setPrivateEdgeRuntime({
          ...pendingRuntimeOwnership,
          status: 'active',
          updatedAt: new Date().toISOString(),
        });
      }
      return {
        capability: 'private-edge',
        applied: applied.length > 0,
        appliedRoutes: applied.map(({ serviceId, serviceName, targetPort, httpsPort, url }) => ({
          serviceId, serviceName, targetPort, httpsPort, url,
        })),
        plan: verified,
      };
    } catch (error) {
      const rollbackFailures: Array<{ route: (typeof routes)[number]; detail: string }> = [];
      const rollbackCandidates = tailscaleConfigChanged ? routes : applied;
      for (const route of [...rollbackCandidates].reverse()) {
        // Re-check the listener before rollback so a concurrent replacement is never removed.
        // eslint-disable-next-line no-await-in-loop
        const rollbackAdapter = resolvePrivateEdgeRouteAdapter(before.routePlan.adapter, route.rollback.command);
        const rollbackPlan = await rollbackAdapter.planRoutes(
          before.workspace.id,
          [{ id: route.serviceId, name: route.serviceName, port: route.targetPort }],
          this.commandRunner,
          route.httpsPort,
          this.root,
        );
        if (rollbackPlan.state === 'ready') continue;
        if (rollbackPlan.state !== 'in-sync') {
          rollbackFailures.push({ route, detail: `Listener ownership changed before rollback: ${rollbackPlan.summary}` });
          continue;
        }
        // eslint-disable-next-line no-await-in-loop
        const result = await this.commandRunner(route.rollback.command, route.rollback.args, { cwd: this.root, timeoutMs: 10_000 });
        if (!result.ok) rollbackFailures.push({ route, detail: result.stderr || result.error || `exit ${result.code}` });
      }
      let caddyRollbackFailure: string | undefined;
      if (caddyConfigChanged && caddyConfigPath) {
        try {
          const relativeConfigPath = path.relative(this.root, caddyConfigPath);
          await writeWorkspaceCaddyfile(this.root, relativeConfigPath, caddyPreviousContent ?? '');
          if (caddyWasRunning) {
            const reload = caddyReloadCommand(before.routePlan.runtime!);
            if (!reload) throw new Error('No safe Caddy reload command is available.');
            const restored = await this.commandRunner(reload.command, reload.args, { cwd: this.root, timeoutMs: 15_000 });
            if (!restored.ok) throw new Error(restored.stderr || restored.error || `exit ${restored.code}`);
          }
          if (!caddyWasRunning && (caddyStartAttempted || caddyStartedThisAttempt)) {
            const stop = caddyStopCommand(before.routePlan.runtime!);
            if (!stop) throw new Error('No safe Caddy stop command is available.');
            const stopped = await this.commandRunner(stop.command, stop.args, { cwd: this.root, timeoutMs: 30_000 });
            if (!stopped.ok) throw new Error(stopped.stderr || stopped.error || `exit ${stopped.code}`);
          }
          if (!caddyPreviousExisted) await removeWorkspaceFile(this.root, relativeConfigPath);
        } catch (restoreError) {
          caddyRollbackFailure = restoreError instanceof Error ? restoreError.message : String(restoreError);
        }
      }
      let tailscaleRollbackFailure: string | undefined;
      if (tailscaleConfigChanged && tailscaleConfigPath) {
        try {
          const relativeConfigPath = path.relative(this.root, tailscaleConfigPath);
          await writeWorkspaceCaddyfile(this.root, relativeConfigPath, tailscalePreviousContent ?? '');
          if (!tailscalePreviousExisted) await removeWorkspaceFile(this.root, relativeConfigPath);
          if (!tailscaleWasRunning && (tailscaleStartAttempted || tailscaleStartedThisAttempt)) {
            const stop = tailscaleStopCommand(before.routePlan.runtime!.tailscale!);
            if (!stop) throw new Error('No safe Tailscale stop command is available.');
            const stopped = await this.commandRunner(stop.command, stop.args, { cwd: this.root, timeoutMs: 30_000 });
            if (!stopped.ok) throw new Error(stopped.stderr || stopped.error || `exit ${stopped.code}`);
          }
        } catch (restoreError) {
          tailscaleRollbackFailure = restoreError instanceof Error ? restoreError.message : String(restoreError);
        }
      }
      if (pendingRuntimeOwnership) {
        if (caddyRollbackFailure || tailscaleRollbackFailure) {
          await this.workspaceState.setPrivateEdgeRuntime({
            ...pendingRuntimeOwnership,
            status: 'rollback-failed',
            updatedAt: new Date().toISOString(),
          });
        } else if (previousRuntimeOwnership) {
          await this.workspaceState.setPrivateEdgeRuntime(previousRuntimeOwnership);
        } else {
          await this.workspaceState.clearPrivateEdgeRuntime();
        }
      }
      if (rollbackFailures.length > 0) {
        await this.workspaceState.load();
        const appliedAt = new Date().toISOString();
        await this.workspaceState.upsertPrivateEdgeRoutes(rollbackFailures.map(({ route }) => ({
          serviceId: route.serviceId,
          adapter: before.routePlan.adapter,
          serviceName: route.serviceName,
          targetPort: route.targetPort,
          proxyPort: route.proxyPort,
          httpsPort: route.httpsPort,
          url: route.url,
          command: route.apply.command,
          applyArgs: route.apply.args,
          rollbackArgs: route.rollback.args,
          appliedAt,
          status: 'rollback-failed',
        })));
      }
      throw new AppError(
        'PRIVATE_EDGE_ROUTE_APPLY_FAILED',
        rollbackFailures.length > 0
          ? 'Private Edge route application failed, and one or more newly created routes could not be rolled back.'
          : 'Private Edge route application failed; every route created by this attempt was rolled back.',
        502,
        {
          cause: error instanceof Error ? error.message : String(error),
          appliedBeforeFailure: applied.map((route) => route.serviceId),
          rollbackFailures: rollbackFailures.map(({ route, detail }) => ({ serviceId: route.serviceId, detail })),
          ...(caddyRollbackFailure ? { caddyRollbackFailure } : {}),
          ...(tailscaleRollbackFailure ? { tailscaleRollbackFailure } : {}),
        },
      );
    }
  }

  async reconcileRoutes(capability: string, confirmationToken: string): Promise<ExtensionRouteReconcileResult> {
    const before = await this.plan(capability);
    if (before.canApply) {
      throw new AppError(
        'PRIVATE_EDGE_WORKSPACE_PLAN_PENDING',
        'Apply the workspace-owned Private Edge declaration plan before reconciling host routes.',
        409,
      );
    }
    if (before.reconciliation.state === 'clean') {
      return { capability: 'private-edge', reconciled: false, removedRoutes: [], forgottenRoutes: [], plan: before };
    }
    if (before.reconciliation.state !== 'ready' || !before.reconciliation.confirmationToken) {
      throw new AppError('PRIVATE_EDGE_RECONCILIATION_NOT_READY', before.reconciliation.summary, 409);
    }
    if (confirmationToken !== before.reconciliation.confirmationToken) {
      throw new AppError(
        'STALE_PRIVATE_EDGE_RECONCILIATION',
        'The confirmation token does not match the current owned-route reconciliation plan. Preview the plan again.',
        409,
      );
    }

    const hostRemovals = before.reconciliation.removals.filter((item) => item.action === 'remove');
    const removed: typeof hostRemovals = [];
    const caddyRuntimeOwnership = before.reconciliation.adapter === 'tailscale-caddy'
      ? this.workspaceState.read().privateEdgeRuntime
      : undefined;
    let caddyReconcilePreviousContent: string | undefined;
    let caddyReconcileConfigChanged = false;
    let caddyReconcileWasRunning = false;
    let caddyReconcileStarted = false;
    let caddyReconcileStopped = false;
    let tailscaleReconcilePreviousContent: string | undefined;
    let tailscaleReconcileConfigChanged = false;
    let tailscaleReconcileWasRunning = false;
    let tailscaleReconcileStarted = false;
    let tailscaleReconcileStopped = false;
    try {
      const plannedTailscaleRuntime = before.routePlan.runtime?.tailscale;
      if (
        hostRemovals.length > 0
        && plannedTailscaleRuntime?.source === 'docker-compose'
        && !plannedTailscaleRuntime.running
      ) {
        if (
          !caddyRuntimeOwnership?.tailscale
          || caddyRuntimeOwnership.tailscale.serviceName !== plannedTailscaleRuntime.serviceName
        ) {
          throw new AppError(
            'PRIVATE_EDGE_TAILSCALE_OWNERSHIP_MISSING',
            'The stopped Tailscale sidecar cannot be started because its saved workspace ownership is missing.',
            409,
          );
        }
        tailscaleReconcileWasRunning = false;
        const start = tailscaleStartCommand(plannedTailscaleRuntime);
        if (!start) throw new Error('No safe Tailscale start command is available.');
        const started = await this.commandRunner(start.command, start.args, { cwd: this.root, timeoutMs: 30_000 });
        if (!started.ok) throw new Error(started.stderr || started.error || `exit ${started.code}`);
        tailscaleReconcileStarted = true;
      }
      for (const item of hostRemovals) {
        // eslint-disable-next-line no-await-in-loop
        const result = await this.commandRunner(item.command, item.rollbackArgs, { cwd: this.root, timeoutMs: 10_000 });
        if (!result.ok) {
          throw new AppError(
            'PRIVATE_EDGE_ROUTE_REMOVE_FAILED',
            `Tailscale could not remove ${item.serviceName}: ${result.stderr || result.error || `exit ${result.code}`}.`,
            502,
          );
        }
        removed.push(item);
      }

      const verified = await this.plan(capability);
      const stillActive = verified.reconciliation.removals.filter((item) => item.liveStatus === 'active');
      if (stillActive.length > 0) {
        throw new AppError(
          'PRIVATE_EDGE_ROUTE_REMOVE_VERIFICATION_FAILED',
          `Tailscale accepted the removal commands, but ${stillActive.length} owned listener${stillActive.length === 1 ? ' is' : 's are'} still active.`,
          502,
        );
      }

      if (before.reconciliation.adapter === 'tailscale-caddy') {
        const runtime = before.routePlan.runtime;
        const generatedFile = before.routePlan.generatedFiles.find((file) => file.kind === 'caddyfile');
        if (!runtime?.manageable || !runtime.configPath || !runtime.configTarget || !runtime.serviceName || !generatedFile?.validate) {
          throw new AppError(
            'PRIVATE_EDGE_CADDY_RUNTIME_NOT_MANAGEABLE',
            'Caddy reconciliation requires a workspace-local Docker Caddyfile mount.',
            409,
          );
        }
        const relativeConfigPath = path.relative(this.root, runtime.configPath);
        if (!caddyRuntimeOwnership
          || caddyRuntimeOwnership.serviceName !== runtime.serviceName
          || caddyRuntimeOwnership.configPath !== relativeConfigPath) {
          throw new AppError(
            'PRIVATE_EDGE_CADDY_OWNERSHIP_MISSING',
            'The saved Caddy runtime ownership does not match the active workspace service.',
            409,
          );
        }
        const tailscaleRuntime = runtime.tailscale;
        const tailscaleOwnership = caddyRuntimeOwnership.tailscale;
        if (tailscaleRuntime?.source === 'docker-compose' && (
          !tailscaleRuntime.manageable
          || !tailscaleRuntime.serviceName
          || !tailscaleRuntime.configPath
          || !tailscaleOwnership
          || tailscaleOwnership.serviceName !== tailscaleRuntime.serviceName
          || tailscaleOwnership.configPath !== path.relative(this.root, tailscaleRuntime.configPath)
        )) {
          throw new AppError(
            'PRIVATE_EDGE_TAILSCALE_OWNERSHIP_MISSING',
            'The saved Tailscale sidecar ownership does not match the active workspace service.',
            409,
          );
        }

        const finalRemoval = before.routePlan.routes.length === 0;
        const backupContent = finalRemoval
          ? await readWorkspaceFile(path.resolve(this.root, caddyRuntimeOwnership.backupPath))
          : undefined;
        if (finalRemoval && backupContent === undefined) {
          throw new AppError('PRIVATE_EDGE_CADDY_BACKUP_MISSING', 'The original workspace Caddyfile backup is missing; LocalLink will not remove managed routes without it.', 409);
        }
        const nextContent = finalRemoval ? backupContent! : generatedFile.content;
        await writeWorkspaceCaddyfile(this.root, generatedFile.path, nextContent);
        const validation = await this.commandRunner(
          generatedFile.validate.command,
          generatedFile.validate.args,
          { cwd: this.root, timeoutMs: 15_000 },
        );
        if (!validation.ok) {
          throw new AppError(
            'PRIVATE_EDGE_CADDY_CONFIG_INVALID',
            `Caddy rejected the reconciled workspace configuration: ${validation.stderr || validation.error || `exit ${validation.code}`}.`,
            502,
          );
        }

        caddyReconcilePreviousContent = await readWorkspaceFile(runtime.configPath);
        caddyReconcileWasRunning = runtime.running;
        await this.workspaceState.setPrivateEdgeRuntime({
          ...caddyRuntimeOwnership,
          status: 'applying',
          updatedAt: new Date().toISOString(),
        });
        const merged = finalRemoval
          ? nextContent
          : mergeManagedCaddyfile(caddyReconcilePreviousContent, nextContent);
        await writeWorkspaceCaddyfile(this.root, relativeConfigPath, merged);
        caddyReconcileConfigChanged = true;

        if (tailscaleRuntime?.source === 'docker-compose' && tailscaleOwnership && tailscaleRuntime.configPath) {
          const tailscaleBackupContent = await readWorkspaceFile(path.resolve(this.root, tailscaleOwnership.backupPath));
          if (tailscaleBackupContent === undefined) {
            throw new AppError(
              'PRIVATE_EDGE_TAILSCALE_BACKUP_MISSING',
              'The original workspace Tailscale Serve configuration backup is missing; LocalLink will not reconcile managed routes without it.',
              409,
            );
          }
          const removalIds = new Set(before.reconciliation.removals.map((item) => item.serviceId));
          const nextTailscaleContent = finalRemoval
            ? tailscaleBackupContent
            : buildManagedTailscaleServeConfig(
                tailscaleBackupContent,
                before.routePlan.routes.filter((route) => !removalIds.has(route.serviceId)),
              );
          tailscaleReconcilePreviousContent = await readWorkspaceFile(tailscaleRuntime.configPath);
          tailscaleReconcileWasRunning = tailscaleRuntime.running;
          await writeWorkspaceCaddyfile(
            this.root,
            path.relative(this.root, tailscaleRuntime.configPath),
            nextTailscaleContent,
          );
          tailscaleReconcileConfigChanged = true;
          if (!tailscaleRuntime.running && !tailscaleReconcileStarted && !finalRemoval) {
            const start = tailscaleStartCommand(tailscaleRuntime);
            if (!start) throw new Error('No safe Tailscale start command is available.');
            const started = await this.commandRunner(start.command, start.args, { cwd: this.root, timeoutMs: 30_000 });
            if (!started.ok) throw new Error(started.stderr || started.error || `exit ${started.code}`);
            tailscaleReconcileStarted = true;
          }
        }

        if (!runtime.running && !finalRemoval) {
          const start = caddyStartCommand(runtime);
          if (!start) throw new Error('No safe Caddy start command is available.');
          const started = await this.commandRunner(start.command, start.args, { cwd: this.root, timeoutMs: 30_000 });
          if (!started.ok) throw new Error(started.stderr || started.error || `exit ${started.code}`);
          caddyReconcileStarted = true;
        }
        if (runtime.running || caddyReconcileStarted) {
          const reload = caddyReloadCommand(runtime);
          if (!reload) throw new Error('No safe Caddy reload command is available.');
          const reloaded = await this.commandRunner(reload.command, reload.args, { cwd: this.root, timeoutMs: 15_000 });
          if (!reloaded.ok) throw new Error(reloaded.stderr || reloaded.error || `exit ${reloaded.code}`);
        }
        if (finalRemoval && caddyRuntimeOwnership.startedByLocalLink && runtime.running) {
          const stop = caddyStopCommand(runtime);
          if (!stop) throw new Error('No safe Caddy stop command is available.');
          const stopped = await this.commandRunner(stop.command, stop.args, { cwd: this.root, timeoutMs: 30_000 });
          if (!stopped.ok) throw new Error(stopped.stderr || stopped.error || `exit ${stopped.code}`);
          caddyReconcileStopped = true;
        }
        if (
          finalRemoval
          && tailscaleRuntime?.source === 'docker-compose'
          && tailscaleOwnership?.startedByLocalLink
          && (tailscaleRuntime.running || tailscaleReconcileStarted)
        ) {
          const stop = tailscaleStopCommand(tailscaleRuntime);
          if (!stop) throw new Error('No safe Tailscale stop command is available.');
          const stopped = await this.commandRunner(stop.command, stop.args, { cwd: this.root, timeoutMs: 30_000 });
          if (!stopped.ok) throw new Error(stopped.stderr || stopped.error || `exit ${stopped.code}`);
          tailscaleReconcileStopped = true;
        }
      }

      const all = before.reconciliation.removals;
      if (caddyRuntimeOwnership) {
        if (before.routePlan.routes.length === 0) {
          if (!caddyRuntimeOwnership.configExisted && (caddyReconcileStopped || !before.routePlan.runtime?.running)) {
            await removeWorkspaceFile(this.root, caddyRuntimeOwnership.configPath);
          }
          await this.workspaceState.clearPrivateEdgeRuntime();
          await removeWorkspaceFile(this.root, caddyRuntimeOwnership.backupPath);
          if (caddyRuntimeOwnership.tailscale) {
            if (!caddyRuntimeOwnership.tailscale.configExisted && (tailscaleReconcileStopped || !before.routePlan.runtime?.tailscale?.running)) {
              await removeWorkspaceFile(this.root, caddyRuntimeOwnership.tailscale.configPath);
            }
            await removeWorkspaceFile(this.root, caddyRuntimeOwnership.tailscale.backupPath);
          }
        } else {
          await this.workspaceState.setPrivateEdgeRuntime({
            ...caddyRuntimeOwnership,
            startedByLocalLink: caddyRuntimeOwnership.startedByLocalLink || caddyReconcileStarted,
            ...(caddyRuntimeOwnership.tailscale ? {
              tailscale: {
                ...caddyRuntimeOwnership.tailscale,
                startedByLocalLink: caddyRuntimeOwnership.tailscale.startedByLocalLink || tailscaleReconcileStarted,
              },
            } : {}),
            status: 'active',
            updatedAt: new Date().toISOString(),
          });
        }
      }
      await this.workspaceState.removePrivateEdgeRoutes(all.map((item) => item.serviceId));
      return {
        capability: 'private-edge',
        reconciled: all.length > 0,
        removedRoutes: removed.map((item) => item.serviceId),
        forgottenRoutes: all.filter((item) => item.action === 'forget').map((item) => item.serviceId),
        plan: await this.plan(capability),
      };
    } catch (error) {
      let caddyRestoreFailure: string | undefined;
      if (caddyReconcileConfigChanged && caddyRuntimeOwnership) {
        try {
          await writeWorkspaceCaddyfile(this.root, caddyRuntimeOwnership.configPath, caddyReconcilePreviousContent ?? '');
          const runtime = before.routePlan.runtime!;
          if (caddyReconcileStopped && caddyReconcileWasRunning) {
            const start = caddyStartCommand(runtime);
            if (!start) throw new Error('No safe Caddy start command is available.');
            const started = await this.commandRunner(start.command, start.args, { cwd: this.root, timeoutMs: 30_000 });
            if (!started.ok) throw new Error(started.stderr || started.error || `exit ${started.code}`);
          }
          if (caddyReconcileWasRunning || caddyReconcileStarted || caddyReconcileStopped) {
            const reload = caddyReloadCommand(runtime);
            if (!reload) throw new Error('No safe Caddy reload command is available.');
            const reloaded = await this.commandRunner(reload.command, reload.args, { cwd: this.root, timeoutMs: 15_000 });
            if (!reloaded.ok) throw new Error(reloaded.stderr || reloaded.error || `exit ${reloaded.code}`);
          }
          if (!caddyReconcileWasRunning && caddyReconcileStarted) {
            const stop = caddyStopCommand(runtime);
            if (!stop) throw new Error('No safe Caddy stop command is available.');
            const stopped = await this.commandRunner(stop.command, stop.args, { cwd: this.root, timeoutMs: 30_000 });
            if (!stopped.ok) throw new Error(stopped.stderr || stopped.error || `exit ${stopped.code}`);
          }
          await this.workspaceState.setPrivateEdgeRuntime(caddyRuntimeOwnership);
        } catch (restoreError) {
          caddyRestoreFailure = restoreError instanceof Error ? restoreError.message : String(restoreError);
          await this.workspaceState.setPrivateEdgeRuntime({
            ...caddyRuntimeOwnership,
            status: 'rollback-failed',
            updatedAt: new Date().toISOString(),
          });
        }
      } else if (caddyRuntimeOwnership) {
        await this.workspaceState.setPrivateEdgeRuntime(caddyRuntimeOwnership);
      }
      let tailscaleRestoreFailure: string | undefined;
      if ((tailscaleReconcileConfigChanged || tailscaleReconcileStarted) && caddyRuntimeOwnership?.tailscale) {
        try {
          if (tailscaleReconcileConfigChanged) {
            await writeWorkspaceCaddyfile(
              this.root,
              caddyRuntimeOwnership.tailscale.configPath,
              tailscaleReconcilePreviousContent ?? '',
            );
          }
          const runtime = before.routePlan.runtime!.tailscale!;
          if (tailscaleReconcileStopped && tailscaleReconcileWasRunning) {
            const start = tailscaleStartCommand(runtime);
            if (!start) throw new Error('No safe Tailscale start command is available.');
            const started = await this.commandRunner(start.command, start.args, { cwd: this.root, timeoutMs: 30_000 });
            if (!started.ok) throw new Error(started.stderr || started.error || `exit ${started.code}`);
          }
          if (!tailscaleReconcileWasRunning && tailscaleReconcileStarted) {
            const stop = tailscaleStopCommand(runtime);
            if (!stop) throw new Error('No safe Tailscale stop command is available.');
            const stopped = await this.commandRunner(stop.command, stop.args, { cwd: this.root, timeoutMs: 30_000 });
            if (!stopped.ok) throw new Error(stopped.stderr || stopped.error || `exit ${stopped.code}`);
          }
          await this.workspaceState.setPrivateEdgeRuntime(caddyRuntimeOwnership);
        } catch (restoreError) {
          tailscaleRestoreFailure = restoreError instanceof Error ? restoreError.message : String(restoreError);
          await this.workspaceState.setPrivateEdgeRuntime({
            ...caddyRuntimeOwnership,
            status: 'rollback-failed',
            updatedAt: new Date().toISOString(),
          });
        }
      }
      const restoreFailures: Array<{ serviceId: string; detail: string }> = [];
      for (const item of [...removed].reverse()) {
        // eslint-disable-next-line no-await-in-loop
        const restoreAdapter = resolvePrivateEdgeRouteAdapter(item.adapter, item.command);
        const restorePlan = await restoreAdapter.planRoutes(
          before.workspace.id,
          [{ id: item.serviceId, name: item.serviceName, port: item.targetPort }],
          this.commandRunner,
          item.httpsPort,
          this.root,
        );
        if (restorePlan.state === 'in-sync') continue;
        if (restorePlan.state !== 'ready') {
          restoreFailures.push({ serviceId: item.serviceId, detail: `Listener changed before restore: ${restorePlan.summary}` });
          continue;
        }
        // eslint-disable-next-line no-await-in-loop
        const result = await this.commandRunner(item.command, item.applyArgs, { cwd: this.root, timeoutMs: 10_000 });
        if (!result.ok) restoreFailures.push({ serviceId: item.serviceId, detail: result.stderr || result.error || `exit ${result.code}` });
      }
      throw new AppError(
        'PRIVATE_EDGE_RECONCILIATION_FAILED',
        restoreFailures.length > 0
          ? 'Private Edge reconciliation failed, and one or more removed routes could not be restored.'
          : 'Private Edge reconciliation failed; every route removed by this attempt was restored.',
        502,
        {
          cause: error instanceof Error ? error.message : String(error),
          removedBeforeFailure: removed.map((item) => item.serviceId),
          restoreFailures,
          ...(caddyRestoreFailure ? { caddyRestoreFailure } : {}),
          ...(tailscaleRestoreFailure ? { tailscaleRestoreFailure } : {}),
        },
      );
    }
  }
}
