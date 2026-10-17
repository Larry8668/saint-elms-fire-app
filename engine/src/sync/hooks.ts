/**
 * Where the vault code meets vault sync, without threading a sync object through every store:
 * a write notice schedules a debounced push. With sync off nothing is installed: a no-op.
 */
export interface SyncHooks {
  /** Something under this absolute path was written. */
  written(absolutePath: string): void;
}

let active: SyncHooks | null = null;

export function installSyncHooks(hooks: SyncHooks | null): void {
  active = hooks;
}

export const syncHooks: SyncHooks = {
  written: (absolutePath) => active?.written(absolutePath),
};
