import { createHash, randomBytes } from 'node:crypto';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { AppError } from '../shared/errors';

export const LOCALLINK_AGENT_SKILL_NAME = 'locallink-workspace';
const INSTALL_MANIFEST = '.locallink-install.json';

export type AgentSkillTarget = 'codex' | 'agents' | 'workspace';

interface SkillInstallManifest {
  version: 1;
  managedBy: 'locallink';
  skillName: typeof LOCALLINK_AGENT_SKILL_NAME;
  sourceVersion: string;
  contentDigest: string;
  installedAt: string;
}

export interface InstallAgentSkillOptions {
  appRoot: string;
  workspaceRoot: string;
  target?: AgentSkillTarget;
  force?: boolean;
  homeDirectory?: string;
  codexHome?: string;
  agentsHome?: string;
}

export interface InstallAgentSkillResult {
  skill: typeof LOCALLINK_AGENT_SKILL_NAME;
  target: AgentSkillTarget;
  status: 'installed' | 'updated' | 'unchanged';
  path: string;
  sourceVersion: string;
  contentDigest: string;
  backupPath?: string;
}

async function exists(filePath: string): Promise<boolean> {
  try {
    await fs.lstat(filePath);
    return true;
  } catch (error) {
    const code = error && typeof error === 'object' && 'code' in error ? String(error.code) : '';
    if (code === 'ENOENT') return false;
    throw error;
  }
}

function isInside(parent: string, candidate: string): boolean {
  const relative = path.relative(path.resolve(parent), path.resolve(candidate));
  return relative !== '..'
    && !relative.startsWith(`..${path.sep}`)
    && !path.isAbsolute(relative);
}

async function contentDigest(root: string): Promise<string> {
  const hash = createHash('sha256');
  const visit = async (directory: string, relativeRoot = ''): Promise<void> => {
    const entries = await fs.readdir(directory, { withFileTypes: true });
    entries.sort((left, right) => left.name.localeCompare(right.name));
    for (const entry of entries) {
      if (!relativeRoot && entry.name === INSTALL_MANIFEST) continue;
      const relative = path.posix.join(relativeRoot.split(path.sep).join('/'), entry.name);
      const filePath = path.join(directory, entry.name);
      if (entry.isDirectory()) {
        hash.update(`directory:${relative}\n`);
        await visit(filePath, relative);
      } else if (entry.isFile()) {
        hash.update(`file:${relative}\n`);
        hash.update(await fs.readFile(filePath));
        hash.update('\n');
      } else {
        throw new AppError(
          'AGENT_SKILL_UNSUPPORTED_ENTRY',
          `The bundled skill contains unsupported filesystem entry ${relative}.`,
          500,
        );
      }
    }
  };
  await visit(root);
  return hash.digest('hex');
}

async function readManifest(skillPath: string): Promise<SkillInstallManifest | undefined> {
  try {
    const parsed = JSON.parse(
      await fs.readFile(path.join(skillPath, INSTALL_MANIFEST), 'utf8'),
    ) as Partial<SkillInstallManifest>;
    if (
      parsed.version !== 1
      || parsed.managedBy !== 'locallink'
      || parsed.skillName !== LOCALLINK_AGENT_SKILL_NAME
      || typeof parsed.contentDigest !== 'string'
      || typeof parsed.sourceVersion !== 'string'
      || typeof parsed.installedAt !== 'string'
    ) return undefined;
    return parsed as SkillInstallManifest;
  } catch {
    return undefined;
  }
}

async function packageVersion(appRoot: string): Promise<string> {
  try {
    const parsed = JSON.parse(
      await fs.readFile(path.join(appRoot, 'package.json'), 'utf8'),
    ) as { version?: unknown };
    return typeof parsed.version === 'string' && parsed.version ? parsed.version : 'unknown';
  } catch {
    return 'unknown';
  }
}

function targetSkillsRoot(options: InstallAgentSkillOptions, target: AgentSkillTarget): string {
  const home = options.homeDirectory || os.homedir();
  switch (target) {
    case 'workspace':
      return path.join(options.workspaceRoot, '.agents', 'skills');
    case 'agents':
      return path.join(options.agentsHome || process.env.AGENTS_HOME || path.join(home, '.agents'), 'skills');
    case 'codex':
    default:
      return path.join(options.codexHome || process.env.CODEX_HOME || path.join(home, '.codex'), 'skills');
  }
}

function backupName(targetPath: string): string {
  const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
  return `${targetPath}.backup-${timestamp}`;
}

export async function installBundledAgentSkill(
  options: InstallAgentSkillOptions,
): Promise<InstallAgentSkillResult> {
  const target = options.target || 'codex';
  const sourcePath = path.join(options.appRoot, 'skills', LOCALLINK_AGENT_SKILL_NAME);
  if (!await exists(path.join(sourcePath, 'SKILL.md'))) {
    throw new AppError(
      'AGENT_SKILL_SOURCE_MISSING',
      `LocalLink could not find its bundled ${LOCALLINK_AGENT_SKILL_NAME} skill at ${sourcePath}. Reinstall or rebuild the LocalLink package.`,
      500,
    );
  }

  const skillsRoot = path.resolve(targetSkillsRoot(options, target));
  const targetPath = path.join(skillsRoot, LOCALLINK_AGENT_SKILL_NAME);
  if (!isInside(skillsRoot, targetPath)) {
    throw new AppError('AGENT_SKILL_TARGET_INVALID', 'The resolved agent skill target escapes its skills directory.', 400);
  }

  const [digest, sourceVersion] = await Promise.all([
    contentDigest(sourcePath),
    packageVersion(options.appRoot),
  ]);
  const targetExists = await exists(targetPath);
  const manifest = targetExists ? await readManifest(targetPath) : undefined;
  if (targetExists && !manifest && !options.force) {
    throw new AppError(
      'AGENT_SKILL_CONFLICT',
      `${targetPath} already exists and is not marked as LocalLink-managed. Preserve it or rerun with --force to move it to a backup before installation.`,
      409,
      { targetPath },
    );
  }
  if (manifest?.contentDigest === digest) {
    return {
      skill: LOCALLINK_AGENT_SKILL_NAME,
      target,
      status: 'unchanged',
      path: targetPath,
      sourceVersion,
      contentDigest: digest,
    };
  }

  await fs.mkdir(skillsRoot, { recursive: true });
  const nonce = `${process.pid}-${randomBytes(6).toString('hex')}`;
  const stagingPath = path.join(skillsRoot, `.${LOCALLINK_AGENT_SKILL_NAME}.install-${nonce}`);
  if (!isInside(skillsRoot, stagingPath)) {
    throw new AppError('AGENT_SKILL_TARGET_INVALID', 'The resolved staging path escapes its skills directory.', 400);
  }
  await fs.cp(sourcePath, stagingPath, { recursive: true, errorOnExist: true });
  const installedAt = new Date().toISOString();
  const installManifest: SkillInstallManifest = {
    version: 1,
    managedBy: 'locallink',
    skillName: LOCALLINK_AGENT_SKILL_NAME,
    sourceVersion,
    contentDigest: digest,
    installedAt,
  };
  await fs.writeFile(
    path.join(stagingPath, INSTALL_MANIFEST),
    `${JSON.stringify(installManifest, null, 2)}\n`,
    'utf8',
  );

  let backupPath: string | undefined;
  let replacementPath: string | undefined;
  try {
    if (!targetExists) {
      await fs.rename(stagingPath, targetPath);
    } else if (!manifest) {
      backupPath = backupName(targetPath);
      await fs.rename(targetPath, backupPath);
      try {
        await fs.rename(stagingPath, targetPath);
      } catch (error) {
        await fs.rename(backupPath, targetPath);
        backupPath = undefined;
        throw error;
      }
    } else {
      replacementPath = path.join(skillsRoot, `.${LOCALLINK_AGENT_SKILL_NAME}.replace-${nonce}`);
      await fs.rename(targetPath, replacementPath);
      try {
        await fs.rename(stagingPath, targetPath);
      } catch (error) {
        await fs.rename(replacementPath, targetPath);
        replacementPath = undefined;
        throw error;
      }
      await fs.rm(replacementPath, { recursive: true });
      replacementPath = undefined;
    }
  } finally {
    if (await exists(stagingPath)) await fs.rm(stagingPath, { recursive: true });
    if (replacementPath && await exists(replacementPath) && !await exists(targetPath)) {
      await fs.rename(replacementPath, targetPath);
    }
  }

  return {
    skill: LOCALLINK_AGENT_SKILL_NAME,
    target,
    status: targetExists ? 'updated' : 'installed',
    path: targetPath,
    sourceVersion,
    contentDigest: digest,
    backupPath,
  };
}
