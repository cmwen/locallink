import fs from 'node:fs/promises';
import path from 'node:path';

export interface ManagedProcessRecord {
  name: string;
  port?: number;
  url?: string;
}

export interface WorkspaceRuntimeState {
  systemId: string;
  workspaceRoot: string;
  updatedAt: string;
  processes: {
    api?: ManagedProcessRecord;
    dashboard?: ManagedProcessRecord;
  };
}

function statePath(root: string): string {
  return path.join(root, '.locallink', 'runtime.json');
}

export async function readWorkspaceRuntimeState(root: string): Promise<WorkspaceRuntimeState | undefined> {
  try {
    const raw = await fs.readFile(statePath(root), 'utf8');
    const parsed = JSON.parse(raw) as WorkspaceRuntimeState;
    return parsed && typeof parsed === 'object' ? parsed : undefined;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      return undefined;
    }
    throw error;
  }
}

export async function writeWorkspaceRuntimeState(root: string, state: WorkspaceRuntimeState): Promise<void> {
  await fs.mkdir(path.dirname(statePath(root)), { recursive: true });
  await fs.writeFile(statePath(root), `${JSON.stringify(state, null, 2)}\n`, 'utf8');
}

export async function clearWorkspaceRuntimeState(root: string): Promise<void> {
  await fs.rm(statePath(root), { force: true });
}
