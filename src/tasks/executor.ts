import path from 'node:path';

import type { ExecuteTaskInput, ServiceDefinition, TaskAction, TaskExecutionResult, TaskRuntime } from '../shared/contracts';
import type { WorkspaceLifecycleAction, WorkspaceLifecycleResult, WorkspaceLifecycleStep } from '../shared/contracts';
import { AppError } from '../shared/errors';
import { getExternalToolSpecForRuntime, probeExternalTool } from '../shared/runtime-tools';
import type { CommandRunner } from '../shared/utils';
import { LogBroker } from '../logs/broker';
import { ConfigRepository } from '../config/files';
import { PortAllocator } from '../ports/allocator';
import { prepareRuntimeIsolation, readDockerfileBlueprint, verifyBlueprintCompliance } from '../runtime/lego';
import { loadExtensionDefinitions, type ExtensionDefinition } from '../runtime/extensions';
import {
  clearWorkspaceRuntimeState,
  readWorkspaceRuntimeState,
  writeWorkspaceRuntimeState,
} from '../runtime/workspace-state';
import { runCommand } from '../shared/utils';

function resolveServiceDefinition(
  definitions: ServiceDefinition[],
  input: ExecuteTaskInput,
): ServiceDefinition {
  const definition = definitions.find((candidate) => candidate.name === input.serviceName);
  if (!definition) {
    throw new AppError(
      'UNKNOWN_SERVICE',
      `Service "${input.serviceName}" is not declared in docker-compose.yml, locallink.services.yml, or ecosystem.config.js.`,
      404,
    );
  }

  if (definition.runtime !== input.runtime) {
    throw new AppError(
      'RUNTIME_MISMATCH',
      `Service "${input.serviceName}" is declared for ${definition.runtime ?? 'no'} runtime, not ${input.runtime}.`,
      400,
    );
  }

  return definition;
}

function taskCandidates(taskName: string, action: TaskAction): string[] {
  if (action === 'up') {
    return [`${taskName}:up`, taskName];
  }

  return [`${taskName}:${action}`, `${action}:${taskName}`];
}

function normalizePm2Args(args: ServiceDefinition['args']): string[] {
  if (Array.isArray(args)) {
    return args.map(String).filter(Boolean);
  }
  if (typeof args === 'string') {
    return args.split(/\s+/).map((entry) => entry.trim()).filter(Boolean);
  }
  return [];
}

function splitCommand(command: string): string[] {
  const trimmed = command.trim();
  if (!trimmed) {
    return [];
  }

  if (trimmed.startsWith('[')) {
    try {
      const parsed = JSON.parse(trimmed);
      if (Array.isArray(parsed)) {
        return parsed.map(String).filter(Boolean);
      }
    } catch {
      return [];
    }
  }

  const matches = trimmed.match(/"[^"]*"|'[^']*'|\S+/g) ?? [];
  return matches.map((part) => part.replace(/^["']|["']$/g, ''));
}

function pm2LaunchFromCommand(command: string): { script: string; args: string[] } | undefined {
  const parts = splitCommand(command);
  if (parts.length === 0) {
    return undefined;
  }

  if (/^(node|nodejs)$/i.test(parts[0]) && parts[1]) {
    return {
      script: parts[1],
      args: parts.slice(2),
    };
  }

  return {
    script: parts[0],
    args: parts.slice(1),
  };
}

export class TaskExecutor {
  constructor(
    private readonly root: string,
    private readonly configRepository: ConfigRepository,
    private readonly logs: LogBroker,
    private readonly commandRunner: CommandRunner = runCommand,
    private readonly appRoot: string = process.cwd(),
    private readonly portAllocator: PortAllocator = new PortAllocator(),
  ) {}

  private async ensureRuntimeAvailable(runtime: TaskRuntime): Promise<void> {
    const spec = getExternalToolSpecForRuntime(runtime);
    const probe = await probeExternalTool(spec.key, this.commandRunner);

    if (probe.status === 'ok') {
      return;
    }

    throw new AppError('RUNTIME_UNAVAILABLE', probe.detail, 503, {
      runtime,
      command: spec.command,
    });
  }

  private async runPreflight(definition: ServiceDefinition, action: TaskAction): Promise<void> {
    if (action === 'stop') {
      return;
    }

    const compliance = await verifyBlueprintCompliance(definition);
    if (compliance.status === 'warn') {
      this.logs.append(
        `${definition.name}: ${compliance.summary}${compliance.issues.length > 0 ? ` ${compliance.issues.join(' ')}` : ''}`,
        'Alerts',
        'warn',
      );
    }

    await prepareRuntimeIsolation(definition, this.commandRunner);
  }

  private async executeTaskfile(definition: ServiceDefinition, action: TaskAction): Promise<TaskExecutionResult> {
    const taskName = definition.taskName || definition.runtimeName || definition.name;
    const candidates = taskCandidates(taskName, action);
    let lastResult: TaskExecutionResult | undefined;

    for (const candidate of candidates) {
      const result = await this.commandRunner('task', [candidate], { cwd: this.root, timeoutMs: 60_000 });
      lastResult = {
        ok: result.ok,
        runtime: 'taskfile',
        serviceName: definition.name,
        action,
        command: `task ${candidate}`,
        exitCode: result.code,
        stdout: result.stdout,
        stderr: result.stderr,
      };

      const combinedOutput = `${result.stdout}\n${result.stderr}`;
      if (result.ok || !/does not exist/i.test(combinedOutput)) {
        return lastResult;
      }
    }

    return (
      lastResult ?? {
        ok: false,
        runtime: 'taskfile',
        serviceName: definition.name,
        action,
        command: `task ${taskName}`,
        exitCode: null,
        stdout: '',
        stderr: 'Taskfile command could not be resolved.',
      }
    );
  }

  private async runLifecycleCommand(
    runtime: TaskRuntime,
    command: string,
    args: string[],
    action: TaskAction,
    serviceName: string,
  ): Promise<TaskExecutionResult> {
    const execution = await this.commandRunner(command, args, {
      cwd: this.root,
      timeoutMs: 60_000,
      onStdoutLine: (line) => this.logs.append(line, runtime === 'docker' ? 'Docker' : 'PM2'),
      onStderrLine: (line) => this.logs.append(line, 'Alerts', 'warn'),
    });

    return {
      ok: execution.ok,
      runtime,
      serviceName,
      action,
      command: [command, ...args].join(' '),
      exitCode: execution.code,
      stdout: execution.stdout,
      stderr: execution.stderr,
    };
  }

  private async executePm2(definition: ServiceDefinition, action: TaskAction): Promise<TaskExecutionResult> {
    const serviceName = definition.runtimeName || definition.name;
    const ecosystemPath = this.configRepository.getFilePath('ecosystem.config.js');
    const startArgs = ['start', ecosystemPath, '--only', serviceName, '--update-env'];
    const directLaunch = await this.resolveDirectPm2Launch(definition);
    const directStartArgs = directLaunch
      ? [
          'start',
          directLaunch.script,
          '--name',
          serviceName,
          '--update-env',
          ...(definition.cwd ? ['--cwd', definition.cwd] : []),
          ...(directLaunch.args.length > 0 ? ['--', ...directLaunch.args] : []),
        ]
      : undefined;
    const fallbackStartArgs = definition.definitionSource === 'ecosystem' ? startArgs : directStartArgs;
    const requireStartArgs = (): string[] => {
      if (fallbackStartArgs) {
        return fallbackStartArgs;
      }
      throw new AppError(
        'PM2_LAUNCH_UNAVAILABLE',
        `Service "${definition.name}" needs either script metadata or a readable Dockerfile blueprint CMD before PM2 can start it.`,
        400,
      );
    };

    if (action === 'start' || action === 'up') {
      return this.runLifecycleCommand('pm2', 'pm2', requireStartArgs(), action, definition.name);
    }

    const args = [action, serviceName];
    if (action === 'restart') {
      args.push('--update-env');
    }

    const result = await this.runLifecycleCommand('pm2', 'pm2', args, action, definition.name);
    const combinedOutput = `${result.stdout}\n${result.stderr}`;
    if (action === 'restart' && !result.ok && /not found|does not exist|process or namespace/i.test(combinedOutput)) {
      return this.runLifecycleCommand('pm2', 'pm2', requireStartArgs(), action, definition.name);
    }

    return result;
  }

  private async resolveDirectPm2Launch(
    definition: ServiceDefinition,
  ): Promise<{ script: string; args: string[] } | undefined> {
    if (definition.script) {
      return {
        script: definition.script,
        args: normalizePm2Args(definition.args),
      };
    }

    const blueprint = await readDockerfileBlueprint(definition.dockerfilePath);
    if (!blueprint?.command) {
      return undefined;
    }

    return pm2LaunchFromCommand(blueprint.command);
  }

  async execute(input: ExecuteTaskInput): Promise<TaskExecutionResult> {
    await this.configRepository.hydrateProcessEnv();
    const model = await this.configRepository.loadProjectModel();
    const definition = resolveServiceDefinition(model.definitions, input);
    const lifecycleLevel = input.action === 'restart' || input.action === 'stop' ? 'warn' : 'info';

    this.logs.append(
      `${definition.name} ${input.action} requested through ${input.runtime}.`,
      'Lifecycle',
      lifecycleLevel,
    );
    await this.runPreflight(definition, input.action);

    let result: TaskExecutionResult;
    if (input.runtime === 'taskfile') {
      await this.ensureRuntimeAvailable(input.runtime);
      result = await this.executeTaskfile(definition, input.action);
    } else if (input.runtime === 'pm2') {
      await this.ensureRuntimeAvailable(input.runtime);
      result = await this.executePm2(definition, input.action);
    } else {
      await this.ensureRuntimeAvailable(input.runtime);
      const command = this.buildDockerCommand(definition, input.action);
      result = await this.runLifecycleCommand(
        input.runtime,
        command.command,
        command.args,
        input.action,
        definition.name,
      );
    }

    if (result.stdout) {
      for (const line of result.stdout.split(/\r?\n/).filter(Boolean)) {
        this.logs.append(line, input.runtime === 'docker' ? 'Docker' : input.runtime === 'pm2' ? 'PM2' : 'Lifecycle');
      }
    }
    if (result.stderr) {
      for (const line of result.stderr.split(/\r?\n/).filter(Boolean)) {
        this.logs.append(line, 'Alerts', result.ok ? 'warn' : 'error');
      }
    }

    this.logs.append(
      result.ok
        ? `${definition.name} ${input.action} completed successfully.`
        : `${definition.name} ${input.action} failed.`,
      result.ok ? 'Lifecycle' : 'Alerts',
      result.ok ? 'info' : 'error',
    );

    return result;
  }

  async executeWorkspaceLifecycle(action: WorkspaceLifecycleAction): Promise<WorkspaceLifecycleResult> {
    await this.configRepository.hydrateProcessEnv();
    const model = await this.configRepository.loadProjectModel();
    const steps: WorkspaceLifecycleStep[] = [];
    const enabledDefinitions = model.definitions.filter((definition) => definition.lifecycleState !== 'disabled' && definition.lifecycleState !== 'retired');
    const serviceDefinitions = action === 'up' ? enabledDefinitions : [...enabledDefinitions].reverse();
    const extensions = await loadExtensionDefinitions(this.root);
    const enabledExtensions = extensions.filter((extension) => extension.enabled === true);
    const localLinkProcesses = buildLocalLinkProcessNames(this.root, model.env);
    const runtimePorts =
      action === 'up'
        ? await this.resolveLocalLinkPorts(
            model.env,
            localLinkProcesses,
            enabledExtensions.some((extension) => extension.id === 'dashboard'),
          )
        : undefined;

    this.logs.append(`Workspace ${action} requested.`, 'Lifecycle', action === 'down' ? 'warn' : 'info');

    if (action === 'up') {
      steps.push(await this.runManagedLocalLinkProcess('api', action, model.env, localLinkProcesses, runtimePorts));
    }

    for (const definition of serviceDefinitions) {
      if (!definition.runtime) {
        steps.push({
          id: `service:${definition.id}`,
          name: definition.name,
          kind: 'service',
          action,
          ok: true,
          skipped: true,
          detail: 'Service has no runnable LocalLink runtime.',
        });
        continue;
      }

      try {
        const result = await this.execute({
          runtime: definition.runtime,
          serviceName: definition.name,
          action: action === 'up' ? 'up' : 'stop',
        });
        steps.push(taskResultToWorkspaceStep(definition, action, result));
      } catch (error) {
        steps.push(errorToWorkspaceStep(`service:${definition.id}`, definition.name, 'service', action, error));
      }
    }

    const extensionDefinitions = action === 'up' ? enabledExtensions : [...enabledExtensions].reverse();
    for (const extension of extensionDefinitions) {
      steps.push(await this.runExtensionLifecycle(extension, action, model.env, localLinkProcesses, runtimePorts));
    }

    if (action === 'down') {
      steps.push(await this.runManagedLocalLinkProcess('api', action, model.env, localLinkProcesses));
    }

    if (action === 'up' && runtimePorts) {
      await writeWorkspaceRuntimeState(this.root, {
        systemId: localLinkProcesses.systemId,
        workspaceRoot: this.root,
        updatedAt: new Date().toISOString(),
        processes: {
          api: {
            name: localLinkProcesses.api,
            port: runtimePorts.api,
            url: `http://${runtimePorts.host}:${runtimePorts.api}`,
          },
          dashboard: runtimePorts.dashboard
            ? {
                name: localLinkProcesses.dashboard,
                port: runtimePorts.dashboard,
                url: `http://${runtimePorts.host}:${runtimePorts.dashboard}`,
              }
            : undefined,
        },
      });
    }
    if (action === 'down' && steps.every((step) => step.ok || step.skipped)) {
      await clearWorkspaceRuntimeState(this.root);
    }

    const ok = steps.every((step) => step.ok || step.skipped);
    this.logs.append(
      ok ? `Workspace ${action} completed.` : `Workspace ${action} completed with failures.`,
      ok ? 'Lifecycle' : 'Alerts',
      ok ? 'info' : 'error',
    );

    return {
      action,
      workspaceRoot: this.root,
      ok,
      steps,
    };
  }

  private async runExtensionLifecycle(
    extension: ExtensionDefinition,
    action: WorkspaceLifecycleAction,
    env: Record<string, string>,
    processNames: LocalLinkProcessNames,
    ports?: LocalLinkRuntimePorts,
  ): Promise<WorkspaceLifecycleStep> {
    if (extension.id === 'dashboard') {
      return this.runManagedLocalLinkProcess('dashboard', action, env, processNames, ports);
    }

    return {
      id: `extension:${extension.id}`,
      name: extension.name || extension.id,
      kind: 'extension',
      action,
      ok: true,
      skipped: true,
      detail: `${extension.name || extension.id} is configuration-only until it declares an explicit lifecycle command.`,
    };
  }

  private async runManagedLocalLinkProcess(
    surface: 'api' | 'dashboard',
    action: WorkspaceLifecycleAction,
    env: Record<string, string>,
    processNames: LocalLinkProcessNames,
    ports?: LocalLinkRuntimePorts,
  ): Promise<WorkspaceLifecycleStep> {
    const processName = surface === 'api' ? processNames.api : processNames.dashboard;
    if (action === 'up' && (await this.isPm2ProcessKnown(processName))) {
      return {
        id: `${surface}:${processName}`,
        name: surface === 'api' ? 'LocalLink API' : 'Dashboard extension',
        kind: surface === 'api' ? 'core' : 'extension',
        action,
        ok: true,
        skipped: true,
        detail: `${processName} is already managed by PM2.`,
      };
    }

    const binPath = path.join(this.appRoot, 'bin', 'locallink.js');
    const processEnv = {
      ...process.env,
      ...env,
      ...(ports && surface === 'api' ? { LOCALLINK_API_PORT: String(ports.api) } : {}),
      ...(ports && surface === 'dashboard' && ports.dashboard
        ? { LOCALLINK_DASHBOARD_PORT: String(ports.dashboard) }
        : {}),
    };
    const args =
      action === 'up'
        ? [
            'start',
            binPath,
            '--name',
            processName,
            '--update-env',
            '--',
            surface,
            '--workspace',
            this.root,
          ]
        : ['delete', processName];

    const result = await this.commandRunner('pm2', args, {
      cwd: this.root,
      env: processEnv,
      timeoutMs: 60_000,
      onStdoutLine: (line) => this.logs.append(line, 'PM2'),
      onStderrLine: (line) => this.logs.append(line, 'Alerts', 'warn'),
    });
    const missingOnDown = action === 'down' && !result.ok && /not found|does not exist|process or namespace/i.test(`${result.stdout}\n${result.stderr}`);
    const ok = result.ok || missingOnDown;

    return {
      id: `${surface}:${processName}`,
      name: surface === 'api' ? 'LocalLink API' : 'Dashboard extension',
      kind: surface === 'api' ? 'core' : 'extension',
      action,
      ok,
      skipped: missingOnDown,
      command: ['pm2', ...args].join(' '),
      stdout: result.stdout,
      stderr: result.stderr,
      detail: missingOnDown
        ? `${processName} was already down.`
        : ok
          ? `${processName} ${action === 'up' ? `started${ports ? ` on port ${surface === 'api' ? ports.api : ports.dashboard}` : ''}` : 'stopped'}.`
          : `${processName} ${action} failed.`,
    };
  }

  private async isPm2ProcessKnown(processName: string): Promise<boolean> {
    const result = await this.commandRunner('pm2', ['jlist'], {
      cwd: this.root,
      timeoutMs: 3000,
    });
    if (!result.ok) {
      return false;
    }

    try {
      const rows = JSON.parse(result.stdout) as Array<{ name?: string; pm2_env?: { status?: string } }>;
      return rows.some((row) => row.name === processName && row.pm2_env?.status !== 'errored');
    } catch {
      return false;
    }
  }

  private async resolveLocalLinkPorts(
    env: Record<string, string>,
    processNames: LocalLinkProcessNames,
    includeDashboard: boolean,
  ): Promise<LocalLinkRuntimePorts> {
    const existing = await readWorkspaceRuntimeState(this.root);
    const host = env.LOCALLINK_BIND_HOST || '127.0.0.1';
    const startFrom = Number(env.LOCALLINK_DEFAULT_PORT_START || '5000');
    const apiDesired = existing?.processes.api?.port ?? Number(env.LOCALLINK_API_PORT || env.LOCALLINK_WEB_PORT || '4010');
    const api = await this.resolvePort(apiDesired, startFrom);
    const dashboardDesired =
      existing?.processes.dashboard?.port ??
      Number(env.LOCALLINK_DASHBOARD_PORT || env.LOCALLINK_WEB_PORT || apiDesired);
    const dashboard = includeDashboard
      ? await this.resolvePort(
          dashboardDesired === api ? api + 1 : dashboardDesired,
          Math.max(startFrom, api + 1),
          new Set([api]),
        )
      : undefined;

    return {
      host,
      api,
      dashboard,
      processNames,
    };
  }

  private async resolvePort(desired: number, fallbackStart: number, reserved = new Set<number>()): Promise<number> {
    const candidate = Number.isFinite(desired) ? desired : fallbackStart;
    if (!reserved.has(candidate) && (await this.portAllocator.isPortAvailable(candidate))) {
      return candidate;
    }

    let startFrom = Math.max(1024, Math.floor(fallbackStart));
    while (reserved.has(startFrom)) {
      startFrom += 1;
    }
    const scan = await this.portAllocator.findNextAvailablePort(startFrom);
    if (reserved.has(scan.nextFree)) {
      return this.resolvePort(scan.nextFree + 1, scan.nextFree + 1, reserved);
    }
    return scan.nextFree;
  }

  private buildDockerCommand(definition: ServiceDefinition, action: TaskAction) {
    const serviceName = definition.runtimeName || definition.name;
    if (action === 'up' || action === 'start') {
      return {
        command: 'docker',
        args: ['compose', 'up', '-d', serviceName],
      };
    }

    return {
      command: 'docker',
      args: ['compose', action, serviceName],
    };
  }
}

function slugSystemId(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '') || 'system';
}

interface LocalLinkProcessNames {
  systemId: string;
  api: string;
  dashboard: string;
}

interface LocalLinkRuntimePorts {
  host: string;
  api: number;
  dashboard?: number;
  processNames: LocalLinkProcessNames;
}

function buildLocalLinkProcessNames(root: string, env: Record<string, string>): LocalLinkProcessNames {
  const systemId = slugSystemId(env.LOCALLINK_SYSTEM_ID || path.basename(root));
  return {
    systemId,
    api: `locallink-${systemId}-api`,
    dashboard: `locallink-${systemId}-dashboard`,
  };
}

function taskResultToWorkspaceStep(
  definition: ServiceDefinition,
  action: WorkspaceLifecycleAction,
  result: TaskExecutionResult,
): WorkspaceLifecycleStep {
  return {
    id: `service:${definition.id}`,
    name: definition.name,
    kind: 'service',
    action,
    ok: result.ok,
    command: result.command,
    stdout: result.stdout,
    stderr: result.stderr,
    detail: result.ok
      ? `${definition.name} ${action === 'up' ? 'started' : 'stopped'}.`
      : `${definition.name} ${action} failed.`,
  };
}

function errorToWorkspaceStep(
  id: string,
  name: string,
  kind: WorkspaceLifecycleStep['kind'],
  action: WorkspaceLifecycleAction,
  error: unknown,
): WorkspaceLifecycleStep {
  return {
    id,
    name,
    kind,
    action,
    ok: false,
    detail: error instanceof Error ? error.message : 'Unexpected lifecycle error.',
  };
}
