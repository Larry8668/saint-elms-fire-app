import path from 'node:path';
import type { ObjectStore } from '../store/object-store';
import type { VaultSyncConfig } from './config';
import { installSyncHooks } from './hooks';
import { VaultSync, type VaultSyncOptions } from './vault-sync';

export { parseVaultSyncConfig, type VaultSyncConfig } from './config';
export { VaultSync, SyncConflictError, type PushResult, type RestoreReport, type VaultSyncState } from './vault-sync';

/** What the HTTP layer sees: the sync, and the bearer its flush endpoint expects. */
export interface VaultSyncHandle {
  sync: VaultSync;
  flushToken: string | null;
}

/** One sync for the seat owner's profile, wired to the vault's write hook. */
export function createVaultSync(config: VaultSyncConfig, store: ObjectStore, root: string, options: Partial<VaultSyncOptions> = {}): VaultSyncHandle {
  const sync = new VaultSync({ ...options, store, account: config.account, root });
  const inside = (absolutePath: string) => {
    const relative = path.relative(sync.root, path.resolve(absolutePath));
    return !relative.startsWith('..') && !path.isAbsolute(relative);
  };
  installSyncHooks({
    written: (absolutePath) => {
      if (inside(absolutePath)) sync.markDirty();
    },
  });
  return { sync, flushToken: config.flushToken };
}
