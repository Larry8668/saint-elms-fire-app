import type { Pool } from 'pg';
import { getDatabaseMigrationStatus, supportedMigrationVersion } from './db/migrate';

export interface SecondaryStorage {
  get(key: string): Promise<string | null>;
  set(key: string, value: string, ttl?: number): Promise<void>;
  delete(key: string): Promise<void>;
  getAndDelete(key: string): Promise<string | null>;
  increment(key: string, ttl?: number): Promise<number>;
}

/**
 * Database-backed secondary storage for better-auth's rate limiter (the pinned release supports
 * `memory | secondary-storage` for `rateLimit.storage`; "database" is implemented through
 * secondary storage). Rows live in `auth_kv` and expire lazily; `increment` is a single atomic
 * upsert so limits hold across processes and restarts. Sessions remain stored in the database
 * (`session.storeSessionInDatabase`), so this store never becomes the source of truth.
 */
export function createPgSecondaryStorage(pool: Pool): SecondaryStorage {
  return {
    async get(key) {
      // Expired rows are removed on read so they cannot linger; the value is null either way.
      const result = await pool.query<{ value: string }>(
        `WITH expired AS (DELETE FROM auth_kv WHERE key = $1 AND expires_at <= now())
         SELECT value FROM auth_kv WHERE key = $1 AND expires_at > now()`,
        [key],
      );
      return result.rows[0]?.value ?? null;
    },
    async set(key, value, ttl) {
      await pool.query(
        `INSERT INTO auth_kv (key, value, expires_at) VALUES ($1, $2, now() + make_interval(secs => $3))
         ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, expires_at = EXCLUDED.expires_at`,
        [key, value, ttl ?? 86_400],
      );
    },
    async delete(key) {
      await pool.query('DELETE FROM auth_kv WHERE key = $1', [key]);
    },
    async getAndDelete(key) {
      const result = await pool.query<{ value: string; valid: boolean }>(
        'DELETE FROM auth_kv WHERE key = $1 RETURNING value, expires_at > now() AS valid',
        [key],
      );
      const row = result.rows[0];
      return row?.valid ? row.value : null;
    },
    async increment(key, ttl) {
      const result = await pool.query<{ count: string }>(
        `INSERT INTO auth_kv (key, value, expires_at) VALUES ($1, '1', now() + make_interval(secs => $2))
         ON CONFLICT (key) DO UPDATE SET
           value = (CASE WHEN auth_kv.expires_at <= now() THEN 1 ELSE auth_kv.value::bigint + 1 END)::text,
           expires_at = (CASE WHEN auth_kv.expires_at <= now() THEN now() + make_interval(secs => $2) ELSE auth_kv.expires_at END)
         RETURNING value AS count`,
        [key, ttl ?? 60],
      );
      return Number(result.rows[0]?.count ?? '0');
    },
  };
}

/** Fails fast when the migration has not run: rate limiting must not silently degrade to memory. */
export async function assertSecondaryStorageReady(pool: Pool): Promise<void> {
  try {
    const status = await getDatabaseMigrationStatus(pool);
    if (status.currentVersion !== supportedMigrationVersion || status.pendingVersions.length > 0) {
      throw new Error('pending');
    }
    await pool.query('SELECT 1 FROM auth_kv LIMIT 1');
  } catch {
    throw new Error(
      `auth_kv storage requires university schema version ${supportedMigrationVersion}; run the university migrations before starting account authentication`,
    );
  }
}
