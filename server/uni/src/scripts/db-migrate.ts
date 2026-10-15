import { closeDatabasePool, createDatabasePool } from '../db';
import { migrateDatabase } from '../db/migrate';
import { log } from '../logger';

const startedAt = Date.now();
let pool: ReturnType<typeof createDatabasePool> | undefined;

try {
  pool = createDatabasePool();
  const result = await migrateDatabase(pool);
  log.info('uni_database_migration_complete', {
    applied_versions: result.appliedVersions,
    current_version: result.currentVersion,
    elapsed_ms: Date.now() - startedAt,
  });
} catch (error) {
  log.error('uni_database_migration_failed', {
    failure_type: error instanceof Error ? error.name : 'unknown',
  });
  process.exitCode = 1;
} finally {
  if (pool) {
    try {
      await closeDatabasePool(pool);
    } catch {
      log.error('uni_database_pool_close_failed', {});
      process.exitCode = 1;
    }
  }
}
