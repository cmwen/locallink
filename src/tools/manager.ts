import fs from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';

import { parseDocument, stringify, YAMLMap, YAMLSeq } from 'yaml';

import { ConfigRepository } from '../config/files';
import { AppError } from '../shared/errors';
import type {
  ServiceDefinition,
  ToolLockEntry,
  ToolSource,
  ToolTrialRecord,
  ToolVersionStatus,
  ToolWorkspace,
} from '../shared/contracts';
import { runCommand, slugify, type CommandRunner } from '../shared/utils';

interface ToolLockFile {
  services?: Record<string, ToolLockEntry>;
}

export interface ToolTrialInput {
  serviceName: string;
  toolSource?: ToolSource;
  version?: string;
  runtime?: 'pm2' | 'taskfile' | 'docker';
  port?: string;
  ttlHours?: number;
}

export interface ToolTrialPlan {
  planId: string;
  trialId: string;
  serviceName: string;
  runtime: 'pm2' | 'taskfile' | 'docker';
  source?: ToolSource;
  desiredVersion: string;
  port?: string;
  files: string[];
  cleanupScope: string[];
  expiresAt: string;
}

export interface ToolVersionUpdateResult {
  serviceName: string;
  dryRun: boolean;
  requestedVersion: string;
  previousVersion: string;
  nextVersion: string;
  affectedFiles: string[];
  summary: string;
}

export interface ToolRemovalResult {
  serviceName: string;
  mode: 'trial' | 'persistent';
  dryRun: boolean;
  affectedFiles: string[];
  summary: string;
}

function nowIso(): string {
  return new Date().toISOString();
}

async function readFileOrEmpty(filePath: string): Promise<string> {
  try {
    return await fs.readFile(filePath, 'utf8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      return '';
    }
    throw error;
  }
}

async function writeJson(filePath: string, value: unknown): Promise<void> {
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  await fs.writeFile(filePath, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
}

function emptyLock(): ToolLockFile {
  return { services: {} };
}

function versionStatus(definition: ServiceDefinition, lockEntry?: ToolLockEntry): ToolVersionStatus {
  const desiredVersion = definition.version?.desired || lockEntry?.resolvedVersion || 'unlocked';
  const resolvedVersion = lockEntry?.resolvedVersion || 'unresolved';
  const latestVersion = lockEntry?.latestVersion || 'unknown';
  const lifecycleState = definition.lifecycleState || 'active';
  const source = definition.toolSource || lockEntry?.source;
  let status: ToolVersionStatus['status'] = 'unknown';
  let detail = 'No version source is declared yet.';

  if (lifecycleState === 'trial') {
    status = 'trial';
    detail = 'Temporary service; promote it to persist version state.';
  } else if (!source && desiredVersion === 'unlocked') {
    status = 'unlocked';
    detail = 'Add source and version metadata to manage this service.';
  } else if (latestVersion !== 'unknown' && resolvedVersion !== 'unresolved' && latestVersion !== resolvedVersion) {
    status = 'update_available';
    detail = `Latest resolved version is ${latestVersion}.`;
  } else if (resolvedVersion !== 'unresolved') {
    status = 'current';
    detail = 'Resolved version is locked.';
  }

  return {
    serviceName: definition.name,
    runtime: definition.runtime,
    lifecycleState,
    source,
    desiredVersion,
    resolvedVersion,
    latestVersion,
    policy: definition.version?.policy || 'manual',
    status,
    detail,
    checkedAt: lockEntry?.resolvedAt,
  };
}

function trialRecordFromDefinition(definition: ServiceDefinition): ToolTrialRecord | undefined {
  if (definition.lifecycleState !== 'trial' || !definition.trialId) {
    return undefined;
  }

  return {
    trialId: definition.trialId,
    serviceName: definition.name,
    runtime: definition.runtime,
    source: definition.toolSource,
    desiredVersion: definition.version?.desired || 'trial',
    port: definition.port && definition.port !== '—' ? definition.port : undefined,
    status: 'provisioned',
  };
}

function sourceKey(source?: ToolSource): string {
  return source ? `${source.type}:${source.ref}` : 'manual';
}

function getServiceNode(document: ReturnType<typeof parseDocument>, serviceName: string): YAMLMap | undefined {
  const services = document.get('services', true);
  if (!(services instanceof YAMLSeq)) {
    return undefined;
  }

  return services.items.find((item): item is YAMLMap => {
    if (!(item instanceof YAMLMap)) {
      return false;
    }
    return item.get('name') === serviceName;
  });
}

function removeServiceNode(document: ReturnType<typeof parseDocument>, serviceName: string): boolean {
  const services = document.get('services', true);
  if (!(services instanceof YAMLSeq)) {
    return false;
  }

  const index = services.items.findIndex((item) => item instanceof YAMLMap && item.get('name') === serviceName);
  if (index < 0) {
    return false;
  }
  services.items.splice(index, 1);
  return true;
}

export class ToolManager {
  private readonly plans = new Map<string, ToolTrialPlan>();

  constructor(
    private readonly root: string,
    private readonly configRepository: ConfigRepository,
    private readonly commandRunner: CommandRunner = runCommand,
  ) {}

  private lockPath(): string {
    return this.configRepository.getFilePath('locallink.lock.json');
  }

  private servicesPath(): string {
    return this.configRepository.getFilePath('locallink.services.yml');
  }

  private trialDir(trialId: string): string {
    return path.join(this.root, '.locallink', 'trials', trialId);
  }

  private async readLock(): Promise<ToolLockFile> {
    const content = await readFileOrEmpty(this.lockPath());
    if (!content.trim()) {
      return emptyLock();
    }

    try {
      const parsed = JSON.parse(content) as ToolLockFile;
      return {
        services: parsed.services && typeof parsed.services === 'object' ? parsed.services : {},
      };
    } catch (error) {
      throw new AppError('INVALID_TOOL_LOCK', `locallink.lock.json is not valid JSON: ${(error as Error).message}`, 400);
    }
  }

  private async writeLock(lock: ToolLockFile): Promise<void> {
    await writeJson(this.lockPath(), { services: lock.services || {} });
  }

  async readWorkspace(): Promise<ToolWorkspace> {
    const model = await this.configRepository.loadProjectModel();
    const lock = await this.readLock();
    const versions = model.definitions.map((definition) => versionStatus(definition, lock.services?.[definition.name]));
    const trials = model.definitions.flatMap((definition) => {
      const record = trialRecordFromDefinition(definition);
      return record ? [record] : [];
    });
    const updateCount = versions.filter((entry) => entry.status === 'update_available').length;
    const unlockedCount = versions.filter((entry) => entry.status === 'unlocked').length;

    return {
      summary: [
        { label: 'Versioned tools', value: String(versions.length - unlockedCount), detail: 'tracked in LocalLink' },
        { label: 'Updates', value: String(updateCount), detail: 'available after latest checks' },
        { label: 'Trials', value: String(trials.length), detail: 'temporary services' },
      ],
      versions,
      trials,
    };
  }

  async checkLatestVersion(serviceName: string): Promise<ToolVersionStatus> {
    const model = await this.configRepository.loadProjectModel();
    const definition = model.definitions.find((candidate) => candidate.name === serviceName);
    if (!definition) {
      throw new AppError('UNKNOWN_SERVICE', `Service "${serviceName}" is not declared in the current workspace.`, 404);
    }

    const lock = await this.readLock();
    const current = lock.services?.[definition.name] || {};
    const latestVersion = await this.resolveLatestVersion(definition.toolSource || current.source);
    lock.services = {
      ...(lock.services || {}),
      [definition.name]: {
        ...current,
        source: definition.toolSource || current.source,
        resolvedVersion: current.resolvedVersion || definition.version?.desired,
        latestVersion,
        resolvedAt: nowIso(),
      },
    };
    await this.writeLock(lock);
    return versionStatus(definition, lock.services[definition.name]);
  }

  private async resolveLatestVersion(source?: ToolSource): Promise<string> {
    if (!source) {
      return 'unknown';
    }

    if (source.type === 'npm') {
      const result = await this.commandRunner('npm', ['view', source.ref, 'version', '--json'], {
        cwd: this.root,
        timeoutMs: 15_000,
      });
      if (!result.ok) {
        return 'unknown';
      }
      return result.stdout.trim().replace(/^"|"$/g, '') || 'unknown';
    }

    return 'unknown';
  }

  async updateVersion(serviceName: string, targetVersion: string, dryRun = true): Promise<ToolVersionUpdateResult> {
    const model = await this.configRepository.loadProjectModel();
    const definition = model.definitions.find((candidate) => candidate.name === serviceName);
    if (!definition) {
      throw new AppError('UNKNOWN_SERVICE', `Service "${serviceName}" is not declared in the current workspace.`, 404);
    }

    const lock = await this.readLock();
    const previousVersion = lock.services?.[definition.name]?.resolvedVersion || definition.version?.desired || 'unresolved';
    const affectedFiles = [this.lockPath(), this.servicesPath()];
    if (!dryRun) {
      await this.setDesiredVersion(serviceName, targetVersion);
      lock.services = {
        ...(lock.services || {}),
        [definition.name]: {
          ...(lock.services?.[definition.name] || {}),
          source: definition.toolSource,
          resolvedVersion: targetVersion,
          resolvedAt: nowIso(),
          artifact: {
            kind: definition.toolSource?.type || 'manual',
            ref: definition.toolSource?.ref || definition.name,
          },
        },
      };
      await this.writeLock(lock);
    }

    return {
      serviceName,
      dryRun,
      requestedVersion: targetVersion,
      previousVersion,
      nextVersion: targetVersion,
      affectedFiles,
      summary: dryRun
        ? `Would update ${serviceName} from ${previousVersion} to ${targetVersion}.`
        : `Updated ${serviceName} to ${targetVersion}.`,
    };
  }

  private async setDesiredVersion(serviceName: string, targetVersion: string): Promise<void> {
    const content = await readFileOrEmpty(this.servicesPath());
    const document = parseDocument(content.trim() ? content : 'services: []\n');
    let services = document.get('services', true);
    if (!(services instanceof YAMLSeq)) {
      services = document.createNode([]);
      document.set('services', services);
    }

    const serviceNode = getServiceNode(document, serviceName);
    if (!serviceNode) {
      throw new AppError('UNSUPPORTED_VERSION_UPDATE', `Service "${serviceName}" must be declared in locallink.services.yml before LocalLink can persist a version.`, 400);
    }

    const existingVersionNode = serviceNode.get('version', true);
    let versionNode: YAMLMap;
    if (existingVersionNode instanceof YAMLMap) {
      versionNode = existingVersionNode;
    } else {
      versionNode = document.createNode({}) as YAMLMap;
      serviceNode.set('version', versionNode);
    }
    versionNode.set('desired', targetVersion);
    if (!versionNode.get('policy')) {
      versionNode.set('policy', 'manual');
    }

    await fs.writeFile(this.servicesPath(), String(document), 'utf8');
  }

  planTrial(input: ToolTrialInput): ToolTrialPlan {
    const serviceName = input.serviceName.trim();
    if (!serviceName) {
      throw new AppError('INVALID_TRIAL_PLAN', 'serviceName is required.', 400);
    }

    const trialId = `trial-${slugify(serviceName)}-${randomUUID().slice(0, 8)}`;
    const planId = `plan-${randomUUID().slice(0, 12)}`;
    const runtime = input.runtime || 'pm2';
    const expiresAt = new Date(Date.now() + Math.max(1, input.ttlHours || 24) * 60 * 60 * 1000).toISOString();
    const plan: ToolTrialPlan = {
      planId,
      trialId,
      serviceName,
      runtime,
      source: input.toolSource,
      desiredVersion: input.version || 'latest',
      port: input.port,
      files: [path.join(this.trialDir(trialId), 'manifest.yml')],
      cleanupScope: [this.trialDir(trialId), `runtime entries tagged ${trialId}`],
      expiresAt,
    };
    this.plans.set(planId, plan);
    return plan;
  }

  async provisionTrial(planId: string): Promise<{ trial: ToolTrialRecord; manifestPath: string }> {
    const plan = this.plans.get(planId);
    if (!plan) {
      throw new AppError('UNKNOWN_TRIAL_PLAN', `Trial plan "${planId}" is not available.`, 404);
    }

    const manifestPath = path.join(this.trialDir(plan.trialId), 'manifest.yml');
    await fs.mkdir(path.dirname(manifestPath), { recursive: true });
    const service = {
      name: plan.serviceName,
      group: plan.runtime === 'docker' ? 'docker' : 'pm2',
      runtime: plan.runtime,
      runtimeName: slugify(plan.serviceName),
      source: plan.source,
      version: { desired: plan.desiredVersion, policy: 'manual' },
      state: 'trial',
      trialId: plan.trialId,
      port: plan.port,
      notes: 'Temporary LocalLink trial service.',
      detail: 'Provisioned under .locallink/trials and safe to promote or remove.',
      tags: ['trial', plan.runtime],
    };
    await fs.writeFile(
      manifestPath,
      stringify({
        trialId: plan.trialId,
        createdAt: nowIso(),
        expiresAt: plan.expiresAt,
        service,
      }),
      'utf8',
    );

    this.plans.delete(planId);
    return {
      manifestPath,
      trial: {
        trialId: plan.trialId,
        serviceName: plan.serviceName,
        runtime: plan.runtime,
        source: plan.source,
        desiredVersion: plan.desiredVersion,
        port: plan.port,
        status: 'provisioned',
        manifestPath,
        expiresAt: plan.expiresAt,
      },
    };
  }

  async promoteTrial(trialId: string, serviceName?: string): Promise<{ serviceName: string; affectedFiles: string[] }> {
    const manifestPath = path.join(this.trialDir(trialId), 'manifest.yml');
    const content = await readFileOrEmpty(manifestPath);
    if (!content.trim()) {
      throw new AppError('UNKNOWN_TRIAL', `Trial "${trialId}" does not exist.`, 404);
    }

    const parsed = parseDocument(content).toJS() as { service?: Record<string, unknown> };
    const service = parsed.service;
    if (!service) {
      throw new AppError('INVALID_TRIAL_MANIFEST', `Trial "${trialId}" is missing service metadata.`, 400);
    }

    const promotedName = serviceName || String(service.name || trialId);
    const promotedService = {
      ...service,
      name: promotedName,
      state: 'active',
      trialId: undefined,
    };
    delete promotedService.trialId;

    await this.upsertService(promotedService);
    const lock = await this.readLock();
    lock.services = {
      ...(lock.services || {}),
      [promotedName]: {
        source: service.source as ToolSource | undefined,
        resolvedVersion: (service.version as { desired?: string } | undefined)?.desired || 'trial',
        resolvedAt: nowIso(),
        artifact: {
          kind: (service.source as ToolSource | undefined)?.type || 'manual',
          ref: (service.source as ToolSource | undefined)?.ref || promotedName,
        },
        trialId,
      },
    };
    await this.writeLock(lock);
    await fs.rm(this.trialDir(trialId), { recursive: true, force: true });

    return {
      serviceName: promotedName,
      affectedFiles: [this.servicesPath(), this.lockPath(), manifestPath],
    };
  }

  private async upsertService(service: Record<string, unknown>): Promise<void> {
    const content = await readFileOrEmpty(this.servicesPath());
    const document = parseDocument(content.trim() ? content : 'services: []\n');
    const existingServices = document.get('services', true);
    let services: YAMLSeq;
    if (existingServices instanceof YAMLSeq) {
      services = existingServices;
    } else {
      services = document.createNode([]) as YAMLSeq;
      document.set('services', services);
    }

    removeServiceNode(document, String(service.name || ''));
    services.add(document.createNode(service));
    await fs.writeFile(this.servicesPath(), String(document), 'utf8');
  }

  async removeService(serviceName: string, mode: 'trial' | 'persistent', dryRun = true): Promise<ToolRemovalResult> {
    if (mode === 'trial') {
      const model = await this.configRepository.loadProjectModel();
      const definition = model.definitions.find((candidate) => candidate.name === serviceName && candidate.lifecycleState === 'trial');
      if (!definition?.trialId) {
        throw new AppError('UNKNOWN_TRIAL_SERVICE', `Trial service "${serviceName}" is not declared.`, 404);
      }
      const trialPath = this.trialDir(definition.trialId);
      if (!dryRun) {
        await fs.rm(trialPath, { recursive: true, force: true });
      }
      return {
        serviceName,
        mode,
        dryRun,
        affectedFiles: [trialPath],
        summary: dryRun ? `Would remove trial service ${serviceName}.` : `Removed trial service ${serviceName}.`,
      };
    }

    const affectedFiles = [this.servicesPath(), this.lockPath()];
    if (!dryRun) {
      const content = await readFileOrEmpty(this.servicesPath());
      const document = parseDocument(content.trim() ? content : 'services: []\n');
      if (!removeServiceNode(document, serviceName)) {
        throw new AppError('UNKNOWN_SERVICE', `Service "${serviceName}" is not declared in locallink.services.yml.`, 404);
      }
      await fs.writeFile(this.servicesPath(), String(document), 'utf8');
      const lock = await this.readLock();
      if (lock.services) {
        delete lock.services[serviceName];
      }
      await this.writeLock(lock);
    }

    return {
      serviceName,
      mode,
      dryRun,
      affectedFiles,
      summary: dryRun ? `Would remove persistent service ${serviceName}.` : `Removed persistent service ${serviceName}.`,
    };
  }
}
