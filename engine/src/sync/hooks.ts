/**
 * The two places the vault code meets vault sync, without threading a sync object through every
 * store: a write notice (schedules a debounced push) and fetch-on-miss for media restored as a
 * stub. With sync off nothing is installed, and both are no-ops.
 */
export interface SyncHooks {
  /** Something under this absolute path was written. */
  written(absolutePath: string): void;
  /** Fetches one restored-but-not-yet-downloaded file; true when it is now on disk. */
  materialize(absolutePath: string): Promise<boolean>;
  /** Fetches every not-yet-downloaded file under this directory (exports need all of them). */
  materializeAll(absoluteDirectory: string): Promise<void>;
}

let active: SyncHooks | null = null;

export function installSyncHooks(hooks: SyncHooks | null): void {
  active = hooks;
}

export const syncHooks: SyncHooks = {
  written: (absolutePath) => active?.written(absolutePath),
  materialize: (absolutePath) => (active ? active.materialize(absolutePath) : Promise.resolve(false)),
  materializeAll: (absoluteDirectory) => (active ? active.materializeAll(absoluteDirectory) : Promise.resolve()),
};
