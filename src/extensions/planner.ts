import { ConfigRepository } from '../config/files';
import type { ExtensionLifecycleRecord, WorkspaceExtension } from '../shared/contracts';
import { AppError } from '../shared/errors';
import type { CommandRunner } from '../shared/utils';
import { runCommand } from '../shared/utils';
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
  state: 'ready-to-apply' | 'waiting-user' | 'complete';
  summary: string;
  canApply: boolean;
  selection: {
    requested: boolean;
    selected: Array<{ id: string; name: string; port: string }>;
    available: Array<{ id: string; name: string; port: string }>;
  };
  steps: ExtensionPlanStep[];
}

export interface ExtensionApplyResult {
  capability: InstallableCapabilityId;
  applied: boolean;
  changedFiles: string[];
  plan: ExtensionInstallPlan;
}

function envValue(content: string, key: string): string | undefined {
  const match = content.match(new RegExp(`^\\s*${key}\\s*=\\s*(.*?)\\s*$`, 'm'));
  return match?.[1]?.replace(/^['"]|['"]$/g, '');
}

function syntheticPrivateEdge(existing?: WorkspaceExtension): WorkspaceExtension {
  return {
    id: existing?.id || 'private-edge',
    name: existing?.name || 'Private Edge',
    kind: 'network-edge',
    enabled: true,
    detail: existing?.detail || 'Publishes selected workspace services privately through Tailscale Serve.',
    status: 'ready',
    command: existing?.command || 'tailscale',
    exposedPorts: existing?.exposedPorts || [],
    requiredEnv: existing?.requiredEnv || [],
    missingEnv: existing?.missingEnv || [],
    dependsOn: existing?.dependsOn || [],
    docsUrl: existing?.docsUrl || 'https://tailscale.com/docs/features/tailscale-serve',
  };
}

function runtimeSteps(lifecycle: ExtensionLifecycleRecord, hasSelectedServices: boolean): ExtensionPlanStep[] {
  if (lifecycle.state === 'healthy') {
    return [{
      id: 'verify-private-edge',
      label: 'Verify workspace routes',
      owner: 'locallink',
      status: 'complete',
      automatic: true,
      detail: lifecycle.summary,
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
    status: 'blocked',
    automatic: true,
    detail: hasSelectedServices
      ? 'Service selection is recorded. Live route mutation requires a separate reversible route plan before LocalLink can apply it.'
      : 'Waiting for an explicit service selection before LocalLink can generate route changes.',
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
    const privateEdge = syntheticPrivateEdge(existing);
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
    const lifecycleExtensions = [
      ...model.extensions.filter((extension) => extension.kind !== 'network-edge'),
      privateEdge,
    ];
    const lifecycle = (await buildExtensionLifecycles(
      lifecycleExtensions,
      this.commandRunner,
    )).find((record) => record.id === 'private-edge');
    if (!lifecycle) {
      throw new AppError('EXTENSION_PLAN_FAILED', 'Private Edge lifecycle could not be evaluated.', 500);
    }

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
    const steps = [...workspaceSteps, ...runtimeSteps(lifecycle, selectionReady)];
    const canApply = workspaceSteps.some((step) => step.owner === 'locallink' && step.status === 'pending');
    const waitingUser = steps.some((step) => step.owner === 'user' && step.status !== 'complete');
    const complete = steps.every((step) => step.status === 'complete');

    return {
      workspace: deriveWorkspaceIdentity(this.root, model.env.LOCALLINK_WORKSPACE_ID),
      capability: 'private-edge',
      state: complete ? 'complete' : canApply ? 'ready-to-apply' : waitingUser ? 'waiting-user' : 'ready-to-apply',
      summary: complete
        ? 'Private Edge is declared and healthy for this workspace.'
        : canApply
          ? 'LocalLink can apply the workspace-owned declaration changes. External security decisions remain explicit steps.'
          : 'Workspace declarations are ready; Private Edge is waiting for user-owned or route-selection steps.',
      canApply,
      selection: {
        requested: requestedSelection,
        selected: selectedServices,
        available: availableServices,
      },
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
}
