import fs from 'node:fs/promises';
import path from 'node:path';

import { AppError } from '../shared/errors';
import { logDebug } from '../shared/logger';
import type { ServiceBlueprint, ServiceCompliance, ServiceDefinition } from '../shared/contracts';
import { runCommand, type CommandRunner } from '../shared/utils';

function mergeUnique(values: Array<string[] | undefined>): string[] {
  return Array.from(
    new Set(
      values
        .flatMap((items) => items ?? [])
        .map((item) => item.trim())
        .filter(Boolean),
    ),
  );
}

function normalizeDockerfileLines(content: string): string[] {
  return content
    .replace(/\\\r?\n/g, ' ')
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line && !line.startsWith('#'));
}

function parseEnvVariables(fragment: string): string[] {
  return fragment
    .split(/\s+/)
    .map((entry) => entry.split('=')[0]?.trim())
    .filter((entry): entry is string => !!entry);
}

function parseExposePorts(fragment: string): string[] {
  return fragment
    .split(/\s+/)
    .map((entry) => entry.split('/')[0]?.trim())
    .filter((entry): entry is string => !!entry);
}

async function exists(filePath: string): Promise<boolean> {
  try {
    await fs.access(filePath);
    return true;
  } catch {
    return false;
  }
}

export async function readDockerfileBlueprint(filePath?: string): Promise<ServiceBlueprint | undefined> {
  if (!filePath || !(await exists(filePath))) {
    return undefined;
  }

  const content = await fs.readFile(filePath, 'utf8');
  const lines = normalizeDockerfileLines(content);
  const envVars: string[] = [];
  const expose: string[] = [];
  let command = '';

  for (const line of lines) {
    if (line.startsWith('ENV ')) {
      envVars.push(...parseEnvVariables(line.slice(4)));
      continue;
    }

    if (line.startsWith('EXPOSE ')) {
      expose.push(...parseExposePorts(line.slice(7)));
      continue;
    }

    if (!command && (line.startsWith('CMD ') || line.startsWith('ENTRYPOINT '))) {
      command = line.replace(/^(CMD|ENTRYPOINT)\s+/, '');
    }
  }

  return {
    dockerfilePath: filePath,
    expose: mergeUnique([expose]),
    envVars: mergeUnique([envVars]),
    command,
  };
}

function detectRuntimeFamily(definition: ServiceDefinition, cwd: string): 'node' | 'python' | 'unknown' {
  const script = definition.script || '';
  if (/\.py$/i.test(script)) {
    return 'python';
  }
  if (/\.(c?js|mjs|ts|tsx)$/i.test(script)) {
    return 'node';
  }

  if (definition.blueprint?.command.toLowerCase().includes('python')) {
    return 'python';
  }
  if (definition.blueprint?.command.toLowerCase().includes('node')) {
    return 'node';
  }

  return 'unknown';
}

export async function verifyBlueprintCompliance(definition: ServiceDefinition): Promise<ServiceCompliance> {
  if (definition.runtime !== 'pm2' && definition.runtime !== 'taskfile') {
    return {
      status: 'skipped',
      summary: 'Blueprint checks are only applied to local PM2 and task-backed services.',
      issues: [],
    };
  }

  const blueprint = await readDockerfileBlueprint(definition.dockerfilePath);
  if (!definition.dockerfilePath) {
    return {
      status: 'warn',
      summary: 'No Dockerfile blueprint is declared for this service.',
      issues: ['Declare blueprint in locallink.services.yml so LocalLink can surface a Dockerfile blueprint for this service.'],
    };
  }

  if (!blueprint) {
    return {
      status: 'warn',
      summary: 'The declared Dockerfile blueprint could not be found.',
      issues: [`Expected Dockerfile blueprint at ${definition.dockerfilePath}.`],
    };
  }

  logDebug('Blueprint compliance passed.', {
    service: definition.name,
    dockerfilePath: blueprint.dockerfilePath,
  });

  return {
    status: 'pass',
    summary: `Dockerfile blueprint parsed from ${path.basename(blueprint.dockerfilePath)}.`,
    issues: [],
  };
}

export const verifyLegoCompliance = verifyBlueprintCompliance;

export async function enrichServiceDefinition(definition: ServiceDefinition): Promise<ServiceDefinition> {
  const blueprint = await readDockerfileBlueprint(definition.dockerfilePath);
  const compliance = await verifyBlueprintCompliance({ ...definition, blueprint });

  return {
    ...definition,
    envVars: mergeUnique([definition.envVars, blueprint?.envVars]),
    port: definition.port && definition.port !== '—' ? definition.port : blueprint?.expose?.[0] || definition.port,
    blueprint,
    compliance,
  };
}

export async function prepareRuntimeIsolation(
  definition: ServiceDefinition,
  commandRunner: CommandRunner = runCommand,
): Promise<void> {
  if (!definition.cwd) {
    return;
  }

  const runtimeFamily = detectRuntimeFamily(definition, definition.cwd);
  if (runtimeFamily !== 'python') {
    return;
  }

  const venvPath = path.join(definition.cwd, '.venv');
  if (await exists(venvPath)) {
    return;
  }

  const result = await commandRunner('python3', ['-m', 'venv', '.venv'], {
    cwd: definition.cwd,
    timeoutMs: 60_000,
  });
  if (!result.ok) {
    throw new AppError(
      'PYTHON_VENV_INIT_FAILED',
      result.stderr || result.error || `Failed to create .venv for ${definition.name}.`,
      500,
    );
  }
}
