import type { IdentityInstallPlan } from '../extensions/identity-planner';
import type { ObservabilityInstallPlan } from '../extensions/observability-planner';
import type {
  ExtensionInstallPlan,
  ExtensionPlanStep,
} from '../extensions/planner';
import type {
  ExtensionLifecycleRecord,
  StartupDiagnostics,
} from '../shared/contracts';
import type { WorkspaceIdentity } from '../workspace/identity';

export type OnboardingCapability = 'private-edge' | 'identity' | 'observability';
export type OnboardingCapabilityState = 'optional' | 'disabled' | 'ready' | 'action-required' | 'error';
export type OnboardingPlan = ExtensionInstallPlan | IdentityInstallPlan | ObservabilityInstallPlan;

export interface OnboardingPlanResult {
  plan?: OnboardingPlan;
  error?: string;
}

export interface OnboardingCapabilityReport {
  capability: OnboardingCapability;
  name: string;
  declared: boolean;
  enabled: boolean;
  state: OnboardingCapabilityState;
  planState?: string;
  summary: string;
  automaticSteps: ExtensionPlanStep[];
  manualSteps: ExtensionPlanStep[];
  blockedSteps: ExtensionPlanStep[];
  commands: string[];
}

export interface WorkspaceOnboardingReport {
  version: 1;
  workspace: WorkspaceIdentity;
  core: {
    state: StartupDiagnostics['status'];
    summary: string;
  };
  capabilities: OnboardingCapabilityReport[];
  summary: string;
}

const CAPABILITIES: Array<{ id: OnboardingCapability; name: string }> = [
  { id: 'private-edge', name: 'Private Edge' },
  { id: 'identity', name: 'Identity' },
  { id: 'observability', name: 'Observability' },
];

function commandsFor(
  capability: OnboardingCapability,
  declared: boolean,
  enabled: boolean,
  plan: OnboardingPlan | undefined,
): string[] {
  if (!declared || !enabled) {
    return [
      capability === 'private-edge'
        ? 'locallink extension plan private-edge [SERVICE...]'
        : `locallink extension plan ${capability}`,
    ];
  }
  if (!plan) return [`locallink extension plan ${capability}`];

  const commands: string[] = [];
  if (plan.canApply) {
    commands.push(`locallink extension apply ${capability}`);
  }
  if ('routePlan' in plan) {
    if (plan.routePlan.state === 'ready') {
      commands.push('locallink extension plan private-edge');
      commands.push('locallink extension apply-routes private-edge <token-from-fresh-plan>');
    }
    if (plan.reconciliation.state === 'ready') {
      commands.push('locallink extension reconcile-routes private-edge <token-from-fresh-plan>');
    }
  } else if (plan.privateEdge.state !== 'in-sync' && plan.privateEdge.state !== 'ready') {
    commands.push('locallink extension plan private-edge');
  }
  return [...new Set(commands)];
}

function buildCapability(
  id: OnboardingCapability,
  name: string,
  lifecycles: ExtensionLifecycleRecord[],
  result: OnboardingPlanResult,
): OnboardingCapabilityReport {
  const lifecycle = lifecycles.find((candidate) => candidate.id === id);
  const declared = Boolean(lifecycle?.declared);
  const enabled = Boolean(lifecycle?.enabled);
  const steps = result.plan?.steps || [];
  const incomplete = steps.filter((step) => step.status !== 'complete');
  const automaticSteps = incomplete.filter((step) => step.owner === 'locallink' && step.automatic);
  const manualSteps = incomplete.filter((step) => step.owner !== 'locallink' || !step.automatic);
  const blockedSteps = incomplete.filter((step) => step.status === 'blocked');
  const planError = result.error || result.plan?.state === 'error';
  const state: OnboardingCapabilityState = !declared
    ? 'optional'
    : !enabled
      ? 'disabled'
      : planError
        ? 'error'
        : incomplete.length === 0
          ? 'ready'
          : 'action-required';
  const summary = !declared
    ? `${name} is optional and has not been enabled for this workspace.`
    : !enabled
      ? `${name} is declared but disabled for this workspace.`
      : result.error
        ? result.error
        : result.plan?.summary || lifecycle?.summary || `${name} needs review.`;

  return {
    capability: id,
    name,
    declared,
    enabled,
    state,
    planState: result.plan?.state,
    summary,
    automaticSteps,
    manualSteps,
    blockedSteps,
    commands: commandsFor(id, declared, enabled, result.plan),
  };
}

export function buildWorkspaceOnboardingReport(input: {
  workspace: WorkspaceIdentity;
  diagnostics: StartupDiagnostics;
  lifecycles: ExtensionLifecycleRecord[];
  plans: Record<OnboardingCapability, OnboardingPlanResult>;
}): WorkspaceOnboardingReport {
  const capabilities = CAPABILITIES.map(({ id, name }) => (
    buildCapability(id, name, input.lifecycles, input.plans[id])
  ));
  const configured = capabilities.filter((capability) => capability.declared && capability.enabled);
  const actions = configured.filter((capability) => capability.state !== 'ready').length;
  const errors = configured.filter((capability) => capability.state === 'error').length;
  const summary = input.diagnostics.status === 'error'
    ? 'Core startup has a blocking issue; optional capability work should wait.'
    : configured.length === 0
      ? capabilities.some((capability) => capability.declared)
        ? 'The LocalLink core is ready. No foundation capability is enabled.'
        : 'The LocalLink core is ready. All foundation capabilities remain optional.'
      : errors > 0
        ? `${errors} enabled capability ${errors === 1 ? 'has' : 'have'} a blocking issue.`
        : actions > 0
          ? `${actions} enabled ${actions === 1 ? 'capability has' : 'capabilities have'} remaining automatic or manual onboarding steps.`
          : 'The LocalLink core and all enabled foundation capabilities are ready.';

  return {
    version: 1,
    workspace: input.workspace,
    core: {
      state: input.diagnostics.status,
      summary: input.diagnostics.summary,
    },
    capabilities,
    summary,
  };
}

export function formatWorkspaceOnboardingReport(report: WorkspaceOnboardingReport): string {
  const lines = [
    `LocalLink onboarding: ${report.summary}`,
    `Workspace: ${report.workspace.id} (${report.workspace.root})`,
  ];

  for (const capability of report.capabilities) {
    lines.push(`- [${capability.state.toUpperCase()}] ${capability.name}: ${capability.summary}`);
    for (const step of capability.automaticSteps) {
      lines.push(`  Automatic [${step.status}]: ${step.label}`);
      lines.push(`    ${step.detail}${step.targetFile ? ` Target: ${step.targetFile}.` : ''}`);
    }
    for (const step of capability.manualSteps) {
      lines.push(`  Manual [${step.status}]: ${step.label}`);
      lines.push(`    ${step.detail}`);
    }
    for (const command of capability.commands) {
      lines.push(`  Next command: ${command}`);
    }
  }

  return `${lines.join('\n')}\n`;
}
