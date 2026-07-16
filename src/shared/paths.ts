import fs from 'node:fs';
import path from 'node:path';

import { TARGET_FILES, type TargetFile } from './contracts';

export interface ProjectPaths {
  root: string;
  appRoot: string;
  publicDir: string;
  docsDir: string;
  stateDir: string;
  workspaceStateFile: string;
}

export function resolveProjectRoot(): string {
  return process.cwd();
}

function resolveAppRoot(): string {
  return path.resolve(__dirname, '../..');
}

function resolvePublicDir(workspaceRoot: string, appRoot: string): string {
  const runtimeFolder = path.basename(path.resolve(__dirname, '..'));
  const preferredAppDirs =
    runtimeFolder === 'dist'
      ? [path.join(appRoot, 'dist', 'public'), path.join(appRoot, 'public')]
      : [path.join(appRoot, 'public'), path.join(appRoot, 'dist', 'public')];
  const sameRoot = path.resolve(workspaceRoot) === path.resolve(appRoot);
  const candidates = sameRoot ? [path.join(workspaceRoot, 'public'), ...preferredAppDirs] : preferredAppDirs;
  return candidates.find((candidate) => fs.existsSync(candidate)) ?? preferredAppDirs[0];
}

export function resolvePaths(root = resolveProjectRoot()): ProjectPaths {
  const appRoot = resolveAppRoot();
  return {
    root,
    appRoot,
    publicDir: resolvePublicDir(root, appRoot),
    docsDir: path.join(appRoot, 'docs'),
    stateDir: path.join(root, '.locallink'),
    workspaceStateFile: path.join(root, '.locallink', 'workspace-state.json'),
  };
}

export function getInfraFilePath(root: string, targetFile: TargetFile): string {
  if (!TARGET_FILES.includes(targetFile)) {
    throw new Error(`Unsupported target file: ${targetFile}`);
  }

  return path.join(root, targetFile);
}
