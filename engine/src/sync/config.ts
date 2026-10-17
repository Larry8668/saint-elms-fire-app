import type { ObjectStoreConfig } from '../config';
import { assertAccountId } from '../store/keys';

export interface VaultSyncConfig {
  /** The uni account id: the seat owner's profile id, and the vault's prefix in the store. */
  account: string;
  /** Bearer for POST /api/internal/sync/flush; null leaves the flush endpoint shut. */
  flushToken: string | null;
}

/** Long enough that it can only have come from the orchestrator's generator, not a guess. */
export const MIN_FLUSH_TOKEN_LENGTH = 24;

/**
 * Off (null) unless the object store is configured AND VAULT_SYNC_ACCOUNT names an account, so
 * an engine without these variables behaves exactly as before. Once on, a bad value fails boot.
 */
export function parseVaultSyncConfig(environment: NodeJS.ProcessEnv, objectStore: ObjectStoreConfig | null): { config: VaultSyncConfig | null; warnings: string[] } {
  const warnings: string[] = [];
  const account = environment.VAULT_SYNC_ACCOUNT?.trim() ?? '';
  if (!account) return { config: null, warnings };
  if (!objectStore) {
    warnings.push('VAULT_SYNC_ACCOUNT is set but the object store is not configured (OBJECT_STORE_*); vault sync is off.');
    return { config: null, warnings };
  }
  try {
    assertAccountId(account);
  } catch {
    throw new Error('Vault sync config: VAULT_SYNC_ACCOUNT must be 1–128 characters of [A-Za-z0-9_-]');
  }
  const owners = (environment.ENGINE_SEAT_OWNER ?? '').split(',').map((id) => id.trim()).filter(Boolean);
  // A hosted seat restores one student's vault onto a public URL: it must be pinned to that
  // student up front, never left to whoever signs in first.
  if (environment.ENGINE_PUBLIC_HOST?.trim() && owners.length === 0) {
    throw new Error('Vault sync config: a hosted seat (ENGINE_PUBLIC_HOST) needs ENGINE_SEAT_OWNER set to VAULT_SYNC_ACCOUNT');
  }
  if (owners.length > 0 && !owners.includes(account)) {
    throw new Error('Vault sync config: VAULT_SYNC_ACCOUNT must be the seat owner (ENGINE_SEAT_OWNER)');
  }
  let flushToken = environment.SYNC_FLUSH_TOKEN?.trim() || null;
  if (flushToken && flushToken.length < MIN_FLUSH_TOKEN_LENGTH) {
    warnings.push(`SYNC_FLUSH_TOKEN is shorter than ${MIN_FLUSH_TOKEN_LENGTH} characters; the flush endpoint stays shut.`);
    flushToken = null;
  } else if (!flushToken) {
    warnings.push('SYNC_FLUSH_TOKEN is unset; the final flush endpoint stays shut (periodic pushes still run).');
  }
  return { config: { account, flushToken }, warnings };
}
