import { checkDatabaseReadiness, closeDatabasePool, createDatabasePool } from '../db';
import { log } from '../logger';

let pool: ReturnType<typeof createDatabasePool> | undefined;

try {
  pool = createDatabasePool();
  const readiness = await checkDatabaseReadiness(pool);
  log.info('uni_database_readiness', { ready: readiness.ready });
  if (!readiness.ready) process.exitCode = 1;
} catch (error) {
  log.error('uni_database_readiness_failed', {
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
