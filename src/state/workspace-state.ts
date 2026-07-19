import fs from 'node:fs/promises';
import path from 'node:path';

import type {
  PortReservation,
  TemporaryRuntimeRecord,
  VersionUpdateRecord,
  WorkspacePreferences,
  WorkspaceState,
} from '../shared/contracts';

const DEFAULT_PREFERENCES: WorkspacePreferences = {
  dashboardEnabled: true,
  proxyEnabled: true,
  pocketIdEnabled: true,
  edgeEnabled: false,
};

const DEFAULT_STATE: WorkspaceState = {
  preferences: DEFAULT_PREFERENCES,
  temporaryRuntimes: [],
  versionUpdates: [],
  portReservations: [],
};

function normalizeState(value: Partial<WorkspaceState> | undefined): WorkspaceState {
  return {
    preferences: { ...DEFAULT_PREFERENCES, ...(value?.preferences || {}) },
    temporaryRuntimes: value?.temporaryRuntimes || [],
    versionUpdates: value?.versionUpdates || [],
    portReservations: value?.portReservations || [],
  };
}

export class WorkspaceStateRepository {
  private state: WorkspaceState = DEFAULT_STATE;

  constructor(private readonly filePath: string) {}

  async load(): Promise<WorkspaceState> {
    try {
      const raw = await fs.readFile(this.filePath, 'utf8');
      this.state = normalizeState(JSON.parse(raw) as Partial<WorkspaceState>);
    } catch {
      this.state = DEFAULT_STATE;
    }
    return this.state;
  }

  read(): WorkspaceState {
    return this.state;
  }

  async update(patch: Partial<WorkspaceState>): Promise<WorkspaceState> {
    this.state = normalizeState({ ...this.state, ...patch });
    await fs.mkdir(path.dirname(this.filePath), { recursive: true });
    const temporaryPath = `${this.filePath}.${process.pid}.tmp`;
    await fs.writeFile(temporaryPath, `${JSON.stringify(this.state, null, 2)}\n`, 'utf8');
    await fs.rename(temporaryPath, this.filePath);
    return this.state;
  }

  async updatePreferences(patch: Partial<WorkspacePreferences>): Promise<WorkspacePreferences> {
    await this.update({ preferences: { ...this.state.preferences, ...patch } });
    return this.state.preferences;
  }

  async addTemporaryRuntime(runtime: TemporaryRuntimeRecord): Promise<WorkspaceState> {
    return this.update({ temporaryRuntimes: [runtime, ...this.state.temporaryRuntimes] });
  }

  async removeTemporaryRuntime(id: string): Promise<WorkspaceState> {
    return this.update({ temporaryRuntimes: this.state.temporaryRuntimes.filter((runtime) => runtime.id !== id) });
  }

  async addVersionUpdate(update: VersionUpdateRecord): Promise<WorkspaceState> {
    return this.update({ versionUpdates: [update, ...this.state.versionUpdates] });
  }

  async cancelVersionUpdate(id: string): Promise<WorkspaceState> {
    return this.update({
      versionUpdates: this.state.versionUpdates.map((update) => update.id === id ? { ...update, status: 'cancelled' } : update),
    });
  }

  async addPortReservation(reservation: PortReservation): Promise<WorkspaceState> {
    return this.update({ portReservations: [reservation, ...this.state.portReservations] });
  }

  async releasePortReservation(id: string): Promise<WorkspaceState> {
    return this.update({
      portReservations: this.state.portReservations.map((reservation) => reservation.id === id ? { ...reservation, status: 'released' } : reservation),
    });
  }
}
