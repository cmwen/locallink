import type { TaskRuntime } from './contracts';
import { isCommandMissingResult, runCommand, type CommandRunner } from './utils';

export type ExternalToolKey = 'docker' | 'pm2' | 'task';

export interface ExternalToolSpec {
  key: ExternalToolKey;
  command: string;
  label: string;
  versionArgs: string[];
  installHint: string;
}

export interface ExternalToolProbe {
  spec: ExternalToolSpec;
  status: 'ok' | 'missing' | 'degraded';
  detail: string;
}

const EXTERNAL_TOOL_SPECS: Record<ExternalToolKey, ExternalToolSpec> = {
  docker: {
    key: 'docker',
    command: 'docker',
    label: 'Docker CLI',
    versionArgs: ['--version'],
    installHint:
      'Install Docker Desktop or Docker Engine and ensure `docker` is on PATH.',
  },
  pm2: {
    key: 'pm2',
    command: 'pm2',
    label: 'PM2',
    versionArgs: ['--version'],
    installHint:
      'Install PM2 with `pnpm add -g pm2` or `npm install -g pm2`, then retry the PM2-backed service.',
  },
  task: {
    key: 'task',
    command: 'task',
    label: 'Task',
    versionArgs: ['--version'],
    installHint:
      'Install go-task from https://taskfile.dev/installation/ and ensure `task` is on PATH.',
  },
};

export function getExternalToolSpec(key: ExternalToolKey): ExternalToolSpec {
  return EXTERNAL_TOOL_SPECS[key];
}

export function getExternalToolSpecForRuntime(runtime: TaskRuntime): ExternalToolSpec {
  switch (runtime) {
    case 'docker':
      return EXTERNAL_TOOL_SPECS.docker;
    case 'pm2':
      return EXTERNAL_TOOL_SPECS.pm2;
    case 'taskfile':
      return EXTERNAL_TOOL_SPECS.task;
  }
}

export async function probeExternalTool(
  key: ExternalToolKey,
  commandRunner: CommandRunner = runCommand,
): Promise<ExternalToolProbe> {
  const spec = getExternalToolSpec(key);
  const versionResult = await commandRunner(spec.command, spec.versionArgs, { timeoutMs: 2_000 });

  if (isCommandMissingResult(versionResult)) {
    return {
      spec,
      status: 'missing',
      detail: `${spec.label} is not installed. ${spec.installHint}`,
    };
  }

  if (!versionResult.ok) {
    return {
      spec,
      status: 'degraded',
      detail: `${spec.label} is installed but did not respond cleanly. ${
        versionResult.stderr || versionResult.error || spec.installHint
      }`.trim(),
    };
  }

  if (key === 'docker') {
    const daemonResult = await commandRunner('docker', ['info', '--format', '{{json .ServerVersion}}'], {
      timeoutMs: 2_500,
    });

    if (isCommandMissingResult(daemonResult)) {
      return {
        spec,
        status: 'missing',
        detail: `${spec.label} is not installed. ${spec.installHint}`,
      };
    }

    if (!daemonResult.ok) {
      return {
        spec,
        status: 'degraded',
        detail:
          'Docker is installed but the daemon is unavailable. Start Docker Desktop or the Docker service before using Docker-backed actions.',
      };
    }
  }

  return {
    spec,
    status: 'ok',
    detail: `${spec.label} is available on PATH.`,
  };
}
