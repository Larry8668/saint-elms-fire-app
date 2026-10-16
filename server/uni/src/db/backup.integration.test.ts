import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { Pool } from 'pg';
import test from 'node:test';
import { closeDatabasePool, createDatabasePool, parseDatabaseConfig } from './index';
import { migrateDatabase } from './migrate';

const testDatabaseUrl = process.env.UNI_DB_TEST_RUNNER === 'compose-ephemeral'
  ? process.env.UNI_TEST_DATABASE_URL
  : undefined;
const testOptions = { skip: !testDatabaseUrl };

const run = promisify(execFile);
const SCRIPTS = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../scripts');

function maintenanceUrl(): URL {
  assert.ok(testDatabaseUrl, 'UNI_TEST_DATABASE_URL is required');
  const url = new URL(testDatabaseUrl);
  assert.ok(url.protocol === 'postgres:' || url.protocol === 'postgresql:');
  assert.ok(['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname));
  assert.equal(url.pathname, '/sef_uni_test');
  assert.ok(Number(url.port) >= 1024);
  return url;
}

/** The drill's own databases inside the disposable instance — never the shared test one. */
function drillUrl(name: string): string {
  const url = maintenanceUrl();
  url.pathname = `/${name}`;
  return url.toString();
}

async function tableCounts(pool: Pool): Promise<Record<string, number>> {
  const tables = await pool.query<{ table_name: string }>(
    `SELECT table_name FROM information_schema.tables
     WHERE table_schema = 'public' AND table_type = 'BASE TABLE' ORDER BY table_name`,
  );
  const counts: Record<string, number> = {};
  for (const { table_name } of tables.rows) {
    const result = await pool.query<{ n: number }>(`SELECT count(*)::int AS n FROM "${table_name}"`);
    counts[table_name] = result.rows[0]!.n;
  }
  return counts;
}

const pgToolAvailable = async (tool: string): Promise<boolean> => {
  try {
    await run(tool, ['--version']);
    return true;
  } catch {
    return false;
  }
};

test('db:backup into db:restore reproduces every table row-for-row', testOptions, async (t) => {
  for (const tool of ['pg_dump', 'pg_restore']) {
    if (!(await pgToolAvailable(tool))) return t.skip(`${tool} is not on PATH — install the PostgreSQL client tools`);
  }

  const SRC = 'sef_uni_test_backup_src';
  const DST = 'sef_uni_test_backup_dst';
  const workDir = mkdtempSync(path.join(tmpdir(), 'sef-db-backup-drill-'));
  const dumpFile = path.join(workDir, 'backup.dump');
  const admin = new Pool({ connectionString: maintenanceUrl().toString(), max: 1, connectionTimeoutMillis: 5_000 });

  try {
    for (const name of [SRC, DST]) {
      await admin.query(`DROP DATABASE IF EXISTS ${name} WITH (FORCE)`);
      await admin.query(`CREATE DATABASE ${name}`);
    }

    // A migrated database with at least one real row, so the comparison is not vacuous.
    const source = createDatabasePool(parseDatabaseConfig({ UNI_DATABASE_URL: drillUrl(SRC) }));
    let expected: Record<string, number>;
    try {
      const migrated = await migrateDatabase(source);
      assert.ok(migrated.currentVersion >= 1, 'the source database did not migrate');
      await source.query("INSERT INTO student_profiles (legal_name) VALUES ('Backup Drill')");
      expected = await tableCounts(source);
    } finally {
      await closeDatabasePool(source);
    }

    const backup = await run('bash', [path.join(SCRIPTS, 'db-backup.sh'), dumpFile], {
      env: { ...process.env, UNI_DATABASE_URL: drillUrl(SRC) },
      timeout: 60_000,
    });
    assert.equal(backup.stderr.trim(), '', `db:backup printed to stderr: ${backup.stderr}`);

    await run('bash', [path.join(SCRIPTS, 'db-restore.sh'), dumpFile], {
      env: { ...process.env, UNI_DATABASE_URL: drillUrl(DST) },
      timeout: 60_000,
    });

    const restored = createDatabasePool(parseDatabaseConfig({ UNI_DATABASE_URL: drillUrl(DST) }));
    try {
      assert.deepEqual(await tableCounts(restored), expected);
      const row = await restored.query<{ legal_name: string }>(
        "SELECT legal_name FROM student_profiles WHERE legal_name = 'Backup Drill'",
      );
      assert.equal(row.rows.length, 1, 'the seeded row did not survive the round trip');
    } finally {
      await closeDatabasePool(restored);
    }
  } finally {
    for (const name of [SRC, DST]) {
      await admin.query(`DROP DATABASE IF EXISTS ${name} WITH (FORCE)`).catch(() => {});
    }
    await admin.end();
    rmSync(workDir, { recursive: true, force: true });
  }
});

// This drill only runs inside the disposable Compose test workflow: it creates and drops
// whole databases, which must never happen against anything but a throwaway instance.
