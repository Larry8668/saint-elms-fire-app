import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import type { Pool, PoolClient } from 'pg';

interface MigrationSource {
  version: number;
  name: string;
  url: URL;
}

interface LoadedMigration extends MigrationSource {
  sql: string;
  checksum: string;
}

interface AppliedMigration {
  version: number;
  name: string;
  checksum: string;
}

const migrations: MigrationSource[] = [
  {
    version: 1,
    name: 'university_persistence',
    url: new URL('./migrations/001_university_persistence.sql', import.meta.url),
  },
  {
    version: 2,
    name: 'better_auth',
    url: new URL('./migrations/002_better_auth.sql', import.meta.url),
  },
  {
    version: 3,
    name: 'admission',
    url: new URL('./migrations/003_admission.sql', import.meta.url),
  },
  {
    version: 4,
    name: 'published_shares',
    url: new URL('./migrations/004_published_shares.sql', import.meta.url),
  },
  {
    version: 5,
    name: 'student_sessions',
    url: new URL('./migrations/005_student_sessions.sql', import.meta.url),
  },
];

export interface MigrationResult {
  appliedVersions: number[];
  currentVersion: number;
}

export interface MigrationStatus {
  currentVersion: number;
  latestVersion: number;
  pendingVersions: number[];
}

function validateRegistry(sources: MigrationSource[]): void {
  for (let index = 0; index < sources.length; index += 1) {
    const migration = sources[index]!;
    if (migration.version !== index + 1 || !/^[a-z][a-z0-9_]*$/.test(migration.name)) {
      throw new Error('Invalid database migration registry');
    }
  }
}

async function loadMigrations(): Promise<LoadedMigration[]> {
  validateRegistry(migrations);
  return Promise.all(migrations.map(async (migration) => {
    const sql = await readFile(migration.url, 'utf8');
    return {
      ...migration,
      sql,
      checksum: createHash('sha256').update(sql).digest('hex'),
    };
  }));
}

async function readAppliedMigrations(client: Pool | PoolClient): Promise<AppliedMigration[]> {
  const result = await client.query<AppliedMigration>(
    'SELECT version, name, checksum FROM schema_migrations ORDER BY version',
  );
  return result.rows;
}

function validateAppliedHistory(applied: AppliedMigration[], latestVersion: number): void {
  const highestVersion = applied.reduce((highest, row) => Math.max(highest, row.version), 0);
  if (highestVersion > latestVersion) {
    throw new Error(`Database schema version ${highestVersion} is newer than this server supports (latest ${latestVersion})`);
  }

  for (let version = 1; version <= highestVersion; version += 1) {
    if (!applied.some((row) => row.version === version)) {
      throw new Error(`Database migration history is missing version ${version}`);
    }
  }
}

export async function migrateDatabase(pool: Pool): Promise<MigrationResult> {
  const loaded = await loadMigrations();
  const latestVersion = loaded.at(-1)?.version ?? 0;
  const client = await pool.connect();
  let transactionOpen = false;

  try {
    await client.query('BEGIN');
    transactionOpen = true;
    await client.query('SELECT pg_advisory_xact_lock(23015, 3)');
    await client.query(`
      CREATE TABLE IF NOT EXISTS schema_migrations (
        version integer PRIMARY KEY CHECK (version > 0),
        name text NOT NULL UNIQUE,
        checksum text NOT NULL CHECK (checksum ~ '^[a-f0-9]{64}$'),
        applied_at timestamptz NOT NULL DEFAULT now()
      )
    `);

    const applied = await readAppliedMigrations(client);
    validateAppliedHistory(applied, latestVersion);
    const appliedByVersion = new Map(applied.map((row) => [row.version, row]));

    for (const migration of loaded) {
      const previous = appliedByVersion.get(migration.version);
      if (previous) {
        if (previous.name !== migration.name || previous.checksum !== migration.checksum) {
          throw new Error(`Database migration metadata mismatch at version ${migration.version}`);
        }
        continue;
      }

      await client.query(migration.sql);
      await client.query(
        'INSERT INTO schema_migrations (version, name, checksum) VALUES ($1, $2, $3)',
        [migration.version, migration.name, migration.checksum],
      );
    }

    await client.query('COMMIT');
    transactionOpen = false;
    const newCurrentVersion = loaded.at(-1)?.version ?? 0;
    return {
      appliedVersions: loaded.filter((migration) => !appliedByVersion.has(migration.version)).map((migration) => migration.version),
      currentVersion: newCurrentVersion,
    };
  } catch (error) {
    if (transactionOpen) {
      try {
        await client.query('ROLLBACK');
      } catch {
        // Preserve the migration failure instead of reporting a second connection error.
      }
    }
    throw error;
  } finally {
    client.release();
  }
}

export async function getDatabaseMigrationStatus(pool: Pool): Promise<MigrationStatus> {
  const latestVersion = migrations.at(-1)?.version ?? 0;
  const table = await pool.query<{ exists: boolean }>("SELECT to_regclass('schema_migrations') IS NOT NULL AS exists");
  if (!table.rows[0]?.exists) {
    return { currentVersion: 0, latestVersion, pendingVersions: migrations.map(({ version }) => version) };
  }

  const applied = await readAppliedMigrations(pool);
  const currentVersion = applied.reduce((highest, row) => Math.max(highest, row.version), 0);
  const appliedVersions = new Set(applied.map(({ version }) => version));
  return {
    currentVersion,
    latestVersion,
    pendingVersions: migrations.filter(({ version }) => !appliedVersions.has(version)).map(({ version }) => version),
  };
}

export const supportedMigrationVersion = migrations.at(-1)?.version ?? 0;
