import { closeDatabasePool, createDatabasePool } from '../db';
import { getDatabaseMigrationStatus } from '../db/migrate';
import { log } from '../logger';

let pool: ReturnType<typeof createDatabasePool> | undefined;

try {
  pool = createDatabasePool();
  const status = await getDatabaseMigrationStatus(pool);
  log.info('uni_database_migration_status', {
    current_version: status.currentVersion,
    latest_version: status.latestVersion,
    pending_versions: status.pendingVersions,
  });
  if (status.currentVersion > status.latestVersion) process.exitCode = 1;
} catch (error) {
  log.error('uni_database_status_failed', {
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
