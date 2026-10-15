import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { Pool } from 'pg';
import test from 'node:test';
import { closeDatabasePool, createDatabasePool, parseDatabaseConfig, type DatabaseConfig } from './index';
import { migrateDatabase } from './migrate';
import { withTransaction } from './transaction';

const testDatabaseUrl = process.env.UNI_DB_TEST_RUNNER === 'compose-ephemeral'
  ? process.env.UNI_TEST_DATABASE_URL
  : undefined;
const testOptions = { skip: !testDatabaseUrl };

function safeTestDatabaseUrl(): string {
  assert.ok(testDatabaseUrl, 'UNI_TEST_DATABASE_URL is required');
  const url = new URL(testDatabaseUrl);
  assert.ok(url.protocol === 'postgres:' || url.protocol === 'postgresql:');
  assert.ok(['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname));
  assert.equal(url.pathname, '/sef_uni_test');
  assert.ok(Number(url.port) >= 1024);
  return testDatabaseUrl;
}

async function withTestSchema<T>(run: (pool: ReturnType<typeof createDatabasePool>) => Promise<T>): Promise<T> {
  const url = safeTestDatabaseUrl();
  const admin = new Pool({ connectionString: url, max: 1, connectionTimeoutMillis: 5_000 });
  const schema = `pr03_${randomUUID().replaceAll('-', '')}`;
  try {
    await admin.query(`CREATE SCHEMA ${schema}`);
  } finally {
    await admin.end();
  }

  const scopedUrl = new URL(url);
  scopedUrl.searchParams.set('options', `-c search_path=${schema}`);
  const config: DatabaseConfig = parseDatabaseConfig({ UNI_DATABASE_URL: scopedUrl.toString() });
  const pool = createDatabasePool(config);
  try {
    return await run(pool);
  } finally {
    await closeDatabasePool(pool);
  }
}

async function expectSqlState(operation: Promise<unknown>, code: string): Promise<void> {
  await assert.rejects(operation, (error: unknown) => {
    return typeof error === 'object' && error !== null && 'code' in error && error.code === code;
  });
}

test('migrates an empty schema and creates the five persistence tables', testOptions, async () => {
  await withTestSchema(async (pool) => {
    const result = await migrateDatabase(pool);
    assert.deepEqual(result.appliedVersions, [1, 2]);
    assert.equal(result.currentVersion, 2);

    const tables = await pool.query<{ table_name: string }>(
      `SELECT table_name FROM information_schema.tables
       WHERE table_schema = current_schema() ORDER BY table_name`,
    );
    assert.deepEqual(new Set(tables.rows.map((row) => row.table_name)), new Set([
      'account',
      'audit_events',
      'auth_kv',
      'course_selections',
      'deviceCode',
      'enrolments',
      'schema_migrations',
      'session',
      'staff_memberships',
      'student_profiles',
      'twoFactor',
      'user',
    ]));
  });
});

test('migration runs are repeatable and preserve the applied checksum', testOptions, async () => {
  await withTestSchema(async (pool) => {
    const first = await migrateDatabase(pool);
    const second = await migrateDatabase(pool);
    assert.deepEqual(first.appliedVersions, [1, 2]);
    assert.deepEqual(second.appliedVersions, []);
    assert.equal(second.currentVersion, 2);
  });
});

test('adds its tables without changing representative pre-existing schema or data', testOptions, async () => {
  await withTestSchema(async (pool) => {
    await pool.query('CREATE TABLE retained_records (id integer PRIMARY KEY, label text NOT NULL)');
    await pool.query("INSERT INTO retained_records VALUES (7, 'keep-me')");

    await migrateDatabase(pool);

    const result = await pool.query<{ label: string }>('SELECT label FROM retained_records WHERE id = 7');
    assert.deepEqual(result.rows, [{ label: 'keep-me' }]);
  });
});

test('enforces primary, unique, foreign-key, check, and optimistic-version constraints', testOptions, async () => {
  await withTestSchema(async (pool) => {
    await migrateDatabase(pool);
    const profile = await pool.query<{ id: string }>(
      "INSERT INTO student_profiles (legal_name) VALUES ('Ada Example') RETURNING id",
    );
    const profileId = profile.rows[0]!.id;
    const enrolment = await pool.query<{ id: string }>(
      `INSERT INTO enrolments (student_profile_id, programme_code, cohort_code, starts_on)
       VALUES ($1, 'BSC', '2026-A', '2026-01-01') RETURNING id`,
      [profileId],
    );
    const enrolmentId = enrolment.rows[0]!.id;

    await pool.query(
      `INSERT INTO course_selections (enrolment_id, course_code) VALUES ($1, 'PHY-101')`,
      [enrolmentId],
    );
    await expectSqlState(
      pool.query(`INSERT INTO course_selections (enrolment_id, course_code) VALUES ($1, 'PHY-101')`, [enrolmentId]),
      '23505',
    );
    await expectSqlState(
      pool.query(
        `INSERT INTO course_selections (enrolment_id, course_code) VALUES ($1, 'PHY-102')`,
        [randomUUID()],
      ),
      '23503',
    );
    await expectSqlState(
      pool.query(
        `INSERT INTO enrolments (student_profile_id, programme_code, cohort_code, starts_on, ends_on)
         VALUES ($1, 'BSC', '2026-B', '2026-02-01', '2026-01-01')`,
        [profileId],
      ),
      '23514',
    );
    await expectSqlState(
      pool.query("INSERT INTO student_profiles (legal_name, version) VALUES ('Invalid Version', 0)"),
      '23514',
    );
    await expectSqlState(
      pool.query("INSERT INTO student_profiles (id, legal_name) VALUES ($1, 'Duplicate primary key')", [profileId]),
      '23505',
    );

    const membership = await pool.query<{ id: string }>(
      `INSERT INTO staff_memberships (staff_subject, display_name, role)
       VALUES ('staff-ada', 'Ada Registrar', 'registrar') RETURNING id`,
    );
    await expectSqlState(
      pool.query(
        `INSERT INTO staff_memberships (staff_subject, display_name, role)
         VALUES ('staff-ada', 'Duplicate Membership', 'support')`,
      ),
      '23505',
    );
    await expectSqlState(
      pool.query("INSERT INTO staff_memberships (staff_subject, display_name, role) VALUES ('staff-bad', 'Invalid Role', 'admin')"),
      '23514',
    );
    await pool.query(
      `INSERT INTO audit_events (staff_membership_id, actor_subject, event_type, subject_type, subject_id)
       VALUES ($1, 'staff-ada', 'profile.updated', 'student_profile', $2)`,
      [membership.rows[0]!.id, profileId],
    );
    await expectSqlState(
      pool.query(
        `INSERT INTO audit_events (actor_subject, event_type, subject_type, subject_id, details)
         VALUES ('staff-ada', 'invalid.details', 'student_profile', $1, '[]'::jsonb)`,
        [profileId],
      ),
      '23514',
    );
  });
});

test('rejects a database schema version newer than this server supports', testOptions, async () => {
  await withTestSchema(async (pool) => {
    await pool.query(`CREATE TABLE schema_migrations (
      version integer PRIMARY KEY,
      name text NOT NULL UNIQUE,
      checksum text NOT NULL,
      applied_at timestamptz NOT NULL DEFAULT now()
    )`);
    await pool.query("INSERT INTO schema_migrations (version, name, checksum) VALUES (99, 'future', 'future')");

    await assert.rejects(migrateDatabase(pool), /newer than this server supports/);
    const existing = await pool.query<{ count: string }>(
      "SELECT count(*)::text AS count FROM information_schema.tables WHERE table_schema = current_schema() AND table_name = 'student_profiles'",
    );
    assert.equal(existing.rows[0]!.count, '0');
  });
});

test('rolls back migration DDL and ledger creation when existing schema conflicts', testOptions, async () => {
  await withTestSchema(async (pool) => {
    await pool.query('CREATE TABLE student_profiles (id integer PRIMARY KEY, retained text NOT NULL)');
    await pool.query("INSERT INTO student_profiles VALUES (1, 'untouched')");

    await expectSqlState(migrateDatabase(pool), '42P07');

    const row = await pool.query<{ retained: string }>('SELECT retained FROM student_profiles WHERE id = 1');
    assert.deepEqual(row.rows, [{ retained: 'untouched' }]);
    const ledger = await pool.query<{ exists: boolean }>("SELECT to_regclass('schema_migrations') IS NOT NULL AS exists");
    assert.equal(ledger.rows[0]!.exists, false);
  });
});

test('rolls back all transaction writes when the operation fails', testOptions, async () => {
  await withTestSchema(async (pool) => {
    await migrateDatabase(pool);
    await assert.rejects(
      withTransaction(pool, async (client) => {
        await client.query("INSERT INTO student_profiles (legal_name) VALUES ('Must roll back')");
        throw new Error('forced rollback');
      }),
      /forced rollback/,
    );
    const result = await pool.query<{ count: string }>(
      "SELECT count(*)::text AS count FROM student_profiles WHERE legal_name = 'Must roll back'",
    );
    assert.equal(result.rows[0]!.count, '0');
  });
});

test('reports PostgreSQL readiness', testOptions, async () => {
  await withTestSchema(async (pool) => {
    const { checkDatabaseReadiness } = await import('./index');
    assert.deepEqual(await checkDatabaseReadiness(pool), { ready: true });
  });
});

test('closes a connected pool and rejects work after shutdown', testOptions, async () => {
  const config = parseDatabaseConfig({ UNI_DATABASE_URL: safeTestDatabaseUrl() });
  const pool = createDatabasePool(config);
  await pool.query('SELECT 1');
  await closeDatabasePool(pool);
  await assert.rejects(pool.query('SELECT 1'), /Cannot use a pool after calling end/);
});

test('connection failures produce a non-ready result instead of leaking database errors', async (t) => {
  if (!testDatabaseUrl) return t.skip('UNI_TEST_DATABASE_URL is required');
  const invalidUrl = new URL(safeTestDatabaseUrl());
  invalidUrl.port = '1';
  const pool = createDatabasePool(parseDatabaseConfig({ UNI_DATABASE_URL: invalidUrl.toString() }));
  try {
    assert.deepEqual(await (await import('./index')).checkDatabaseReadiness(pool), { ready: false });
  } finally {
    await closeDatabasePool(pool);
  }
});

// These PostgreSQL integration tests only run inside the disposable Compose test workflow.
