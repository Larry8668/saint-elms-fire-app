import { Pool, type PoolConfig } from 'pg';
import { log } from '../logger';
import { parseDatabaseConfig, type DatabaseConfig } from './config';

export { parseDatabaseConfig } from './config';
export type { DatabaseConfig } from './config';
export { getDatabaseMigrationStatus, migrateDatabase, supportedMigrationVersion } from './migrate';
export { withTransaction } from './transaction';

export function createDatabasePool(config: DatabaseConfig = parseDatabaseConfig()): Pool {
  const pool = new Pool({
    connectionString: config.connectionString,
    max: config.max,
    connectionTimeoutMillis: config.connectionTimeoutMillis,
    idleTimeoutMillis: config.idleTimeoutMillis,
    application_name: 'saint-elms-uni',
    keepAlive: true,
  } satisfies PoolConfig);

  pool.on('error', (error: Error & { code?: string }) => {
    const code = error.code && /^[A-Z0-9_]{1,32}$/i.test(error.code) ? error.code : 'unknown';
    log.error('uni_database_pool_error', { code });
  });

  return pool;
}

export async function closeDatabasePool(pool: Pool): Promise<void> {
  await pool.end();
}

export async function checkDatabaseReadiness(pool: Pool): Promise<{ ready: boolean }> {
  try {
    await pool.query('SELECT 1');
    return { ready: true };
  } catch {
    return { ready: false };
  }
}
