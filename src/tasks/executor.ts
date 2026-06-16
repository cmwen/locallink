import type { ExecuteTaskInput, ServiceDefinition, TaskAction, TaskExecutionResult, TaskRuntime } from '../shared/contracts';
import { AppError } from '../shared/errors';
import { getExternalToolSpecForRuntime, probeExternalTool } from '../shared/runtime-tools';
import type { CommandRunner } from '../shared/utils';
import { LogBroker } from '../logs/broker';
import { ConfigRepository } from '../config/files';
import { prepareRuntimeIsolation, verifyBlueprintCompliance } from '../runtime/lego';
import { runCommand } from '../shared/utils';

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

export class TaskExecutor {
  constructor(
    private readonly root: string,
    private readonly configRepository: ConfigRepository,
    private readonly logs: LogBroker,
    private readonly commandRunner: CommandRunner = runCommand,
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

    if (action === 'start' || action === 'up') {
      return this.runLifecycleCommand('pm2', 'pm2', startArgs, action, definition.name);
    }

    const args = [action, serviceName];
    if (action === 'restart') {
      args.push('--update-env');
    }

    const result = await this.runLifecycleCommand('pm2', 'pm2', args, action, definition.name);
    const combinedOutput = `${result.stdout}\n${result.stderr}`;
    if (action === 'restart' && !result.ok && /not found|does not exist|process or namespace/i.test(combinedOutput)) {
      return this.runLifecycleCommand('pm2', 'pm2', startArgs, action, definition.name);
    }

    return result;
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
