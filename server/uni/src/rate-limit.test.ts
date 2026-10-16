import assert from 'node:assert/strict';
import test from 'node:test';
import type { Pool } from 'pg';
import { assertSecondaryStorageReady } from './rate-limit';
import { supportedMigrationVersion } from './db/migrate';

const migratedRows = [
  { version: 1, name: 'university_persistence', checksum: 'a'.repeat(64) },
  { version: 2, name: 'better_auth', checksum: 'b'.repeat(64) },
  { version: 3, name: 'admission', checksum: 'c'.repeat(64) },
  { version: 4, name: 'published_shares', checksum: 'd'.repeat(64) },
];

function fakePool(handlers: { failOn?: RegExp; rows?: (sql: string) => unknown[] }): Pool {
  const calls: string[] = [];
  const pool = {
    query: async (sql: string) => {
      calls.push(sql);
      if (handlers.failOn?.test(sql)) {
        throw new Error('relation "auth_kv" does not exist for role sef with password hunter2');
      }
      if (sql.includes('to_regclass')) return { rows: [{ exists: true }] };
      if (sql.includes('schema_migrations')) return { rows: handlers.rows?.(sql) ?? migratedRows };
      return { rows: [] };
    },
    calls,
  };
  return pool as unknown as Pool;
}

test('secondary storage readiness rejects when auth_kv is physically absent', async () => {
  const pool = fakePool({ failOn: /FROM auth_kv/ });
  await assert.rejects(assertSecondaryStorageReady(pool), (error: unknown) => {
    const message = (error as Error).message;
    assert.match(message, /auth_kv storage requires university schema version/);
    for (const secret of ['hunter2', 'does not exist for role', 'sef with password']) {
      assert.ok(!message.includes(secret), `expected ${secret} to stay out of the readiness error`);
    }
    return true;
  });
});

test('secondary storage readiness rejects when migrations are pending and never runs them', async () => {
  const pool = fakePool({ rows: () => migratedRows.filter((row) => row.version === 1) });
  await assert.rejects(assertSecondaryStorageReady(pool), /requires university schema version/);
  const queries = (pool as unknown as { calls: string[] }).calls;
  assert.ok(!queries.some((sql) => /\bCREATE\b|\bALTER\b|\bINSERT\b/.test(sql)), 'readiness must never write or migrate');
});

test('secondary storage readiness resolves once the registry is complete and the table exists', async () => {
  const pool = fakePool({});
  await assertSecondaryStorageReady(pool);
  const queries = (pool as unknown as { calls: string[] }).calls;
  assert.ok(queries.some((sql) => sql.includes('FROM auth_kv')));
  assert.equal(supportedMigrationVersion, 4);
});
