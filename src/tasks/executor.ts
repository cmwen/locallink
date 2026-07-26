import type { ExecuteTaskInput, ServiceDefinition, TaskAction, TaskExecutionResult, TaskRuntime } from '../shared/contracts';
import { AppError } from '../shared/errors';
import { getExternalToolSpecForRuntime, probeExternalTool } from '../shared/runtime-tools';
import type { CommandRunner } from '../shared/utils';
import { LogBroker } from '../logs/broker';
import { ConfigRepository } from '../config/files';
import { prepareRuntimeIsolation, readDockerfileBlueprint, verifyBlueprintCompliance } from '../runtime/lego';
import { selectPm2Row, stopObsoletePm2ProcessTree, type Pm2Row } from '../runtime/pm2';
import { withPm2WorkspaceLock } from '../runtime/pm2-workspace';
import { runCommand } from '../shared/utils';
import { buildWorkspaceProcessEnv } from '../workspace/identity';
import { parseJsonOutput } from '../shared/utils';

function resolveServiceDefinition(
  definitions: ServiceDefinition[],
  input: ExecuteTaskInput,
): ServiceDefinition {
  const definition = definitions.find((candidate) => candidate.name === input.serviceName);
  if (!definition) {
    throw new AppError(
      'UNKNOWN_SERVICE',
      `Service "${input.serviceName}" is not declared in docker-compose.yml or ecosystem.config.js.`,
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
  ) {}

  private async ensureRuntimeAvailable(runtime: TaskRuntime, env?: NodeJS.ProcessEnv): Promise<void> {
    const spec = getExternalToolSpecForRuntime(runtime);
    const probe = await probeExternalTool(spec.key, this.commandRunner, {
      cwd: this.root,
      env,
    });

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
      const result = await this.commandRunner('task', [candidate], {
        cwd: this.root,
        env: this.buildServiceProcessEnv(),
        timeoutMs: 60_000,
      });
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
      env: this.buildServiceProcessEnv(),
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

    if (action === 'start' || action === 'up' || (action === 'restart' && fallbackStartArgs)) {
      if (!fallbackStartArgs) {
        throw new AppError(
          'PM2_LAUNCH_UNAVAILABLE',
          `Service "${definition.name}" needs either script metadata or a readable Dockerfile blueprint CMD before PM2 can start it.`,
          400,
        );
      }
      const current = await this.commandRunner('pm2', ['jlist'], {
        cwd: this.root,
        env: this.buildServiceProcessEnv(),
        timeoutMs: 5_000,
      });
      if (!current.ok) {
        return this.pm2Failure(definition.name, action, 'pm2 jlist', current);
      }
      const rows = parseJsonOutput<Pm2Row>(current.stdout);
      const existing = selectPm2Row(definition, rows);
      if (existing) {
        const deleted = await this.runLifecycleCommand(
          'pm2',
          'pm2',
          ['delete', serviceName],
          action,
          definition.name,
        );
        if (!deleted.ok) {
          return deleted;
        }
        await stopObsoletePm2ProcessTree(existing.pid ? [existing.pid] : []);
      }

      const started = await this.runLifecycleCommand('pm2', 'pm2', fallbackStartArgs, action, definition.name);
      if (!started.ok) {
        return started;
      }
      return this.verifyPm2Replacement(definition, action, started);
    }

    const args = [action, serviceName];
    if (action === 'restart') {
      args.push('--update-env');
    }

    const result = await this.runLifecycleCommand('pm2', 'pm2', args, action, definition.name);
    const combinedOutput = `${result.stdout}\n${result.stderr}`;
    if (action === 'restart' && !result.ok && fallbackStartArgs && /not found|does not exist|process or namespace/i.test(combinedOutput)) {
      return this.runLifecycleCommand('pm2', 'pm2', fallbackStartArgs, action, definition.name);
    }

    return result;
  }

  private pm2Failure(
    serviceName: string,
    action: TaskAction,
    command: string,
    result: Awaited<ReturnType<CommandRunner>>,
  ): TaskExecutionResult {
    return {
      ok: false,
      runtime: 'pm2',
      serviceName,
      action,
      command,
      exitCode: result.code,
      stdout: result.stdout,
      stderr: result.stderr || result.error || 'PM2 command failed.',
    };
  }

  private async verifyPm2Replacement(
    definition: ServiceDefinition,
    action: TaskAction,
    started: TaskExecutionResult,
  ): Promise<TaskExecutionResult> {
    let lastResult: Awaited<ReturnType<CommandRunner>> | undefined;
    for (let attempt = 0; attempt < 10; attempt += 1) {
      lastResult = await this.commandRunner('pm2', ['jlist'], {
        cwd: this.root,
        env: this.buildServiceProcessEnv(),
        timeoutMs: 5_000,
      });
      if (lastResult.ok) {
        const row = selectPm2Row(definition, parseJsonOutput<Pm2Row>(lastResult.stdout));
        if (row?.pm2_env?.status === 'online' && Number(row.pid) > 0) {
          return started;
        }
        if (row?.pm2_env?.status === 'errored' || row?.pm2_env?.status === 'stopped') {
          break;
        }
      }
      if (attempt < 9) {
        await new Promise((resolve) => setTimeout(resolve, 100));
      }
    }

    return {
      ...started,
      ok: false,
      exitCode: lastResult?.code ?? started.exitCode,
      stderr: [
        started.stderr,
        lastResult?.stderr,
        `PM2 did not report "${definition.runtimeName || definition.name}" online after replacement.`,
      ].filter(Boolean).join('\n'),
    };
  }

  async execute(input: ExecuteTaskInput): Promise<TaskExecutionResult> {
    await this.configRepository.hydrateProcessEnv();
    const model = await this.configRepository.loadProjectModel();
    this.setServiceProcessEnv(model.env);
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
      const guardedResult = await withPm2WorkspaceLock(
        this.root,
        model.env,
        { allowSpawn: input.action !== 'stop' },
        async (processEnv) => {
          this.serviceProcessEnv = processEnv;
          await this.ensureRuntimeAvailable(input.runtime, processEnv);
          return this.executePm2(definition, input.action);
        },
      );
      result = guardedResult ?? {
        ok: true,
        runtime: 'pm2',
        serviceName: definition.name,
        action: input.action,
        command: `pm2 ${input.action} ${definition.runtimeName || definition.name}`,
        exitCode: 0,
        stdout: input.action === 'stop' ? 'PM2 daemon is not running; service is already stopped.' : '',
        stderr: '',
      };
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
    return blueprint?.command ? pm2LaunchFromCommand(blueprint.command) : undefined;
  }

  private serviceProcessEnv?: NodeJS.ProcessEnv;

  private buildServiceProcessEnv(): NodeJS.ProcessEnv {
    return this.serviceProcessEnv || Object.fromEntries(
      Object.entries(process.env).filter((entry): entry is [string, string] => typeof entry[1] === 'string'),
    );
  }

  private setServiceProcessEnv(env: Record<string, string>): void {
    this.serviceProcessEnv = buildWorkspaceProcessEnv(this.root, env);
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
