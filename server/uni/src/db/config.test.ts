import assert from 'node:assert/strict';
import test from 'node:test';
import { parseDatabaseConfig } from './config';

test('database config validates a PostgreSQL URL and supplies bounded pool defaults', () => {
  const config = parseDatabaseConfig({ UNI_DATABASE_URL: 'postgresql://uni:secret@127.0.0.1:5432/uni' });

  assert.equal(config.connectionString, 'postgresql://uni:secret@127.0.0.1:5432/uni');
  assert.equal(config.max, 10);
  assert.equal(config.connectionTimeoutMillis, 5_000);
  assert.equal(config.idleTimeoutMillis, 30_000);
});

test('database config allows explicit pool limits within the supported range', () => {
  const config = parseDatabaseConfig({
    UNI_DATABASE_URL: 'postgres://uni@localhost/uni',
    UNI_DB_POOL_MAX: '4',
    UNI_DB_CONNECTION_TIMEOUT_MS: '1200',
    UNI_DB_IDLE_TIMEOUT_MS: '9000',
  });

  assert.equal(config.max, 4);
  assert.equal(config.connectionTimeoutMillis, 1_200);
  assert.equal(config.idleTimeoutMillis, 9_000);
});

test('database config rejects malformed URLs and unsafe pool limits without echoing secrets', () => {
  assert.throws(
    () => parseDatabaseConfig({ UNI_DATABASE_URL: 'mysql://uni:secret@localhost/uni' }),
    (error: unknown) => error instanceof Error && error.message === 'Invalid UNI database configuration',
  );
  assert.throws(
    () => parseDatabaseConfig({ UNI_DATABASE_URL: 'postgres://uni:secret@localhost' }),
    (error: unknown) => error instanceof Error && error.message === 'Invalid UNI database configuration',
  );
  assert.throws(
    () => parseDatabaseConfig({ UNI_DATABASE_URL: 'postgres://uni:secret@localhost/uni', UNI_DB_POOL_MAX: '0' }),
    (error: unknown) => error instanceof Error && error.message === 'Invalid UNI database configuration',
  );
});
