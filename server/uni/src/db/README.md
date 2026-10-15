# University persistence foundation

This module provides the PostgreSQL connection pool, transaction helper, readiness probe, and versioned SQL migrations. Runtime routes intentionally continue to use the existing JSON stores; do not move data access into route handlers until a later change plans that cutover. Authentication-library tables belong to PR-04. This schema has no password or custom authentication tables.

## Configuration and commands

`UNI_DATABASE_URL` is required by the database commands and must use `postgres://` or `postgresql://`. Optional pool settings are `UNI_DB_POOL_MAX` (1–50, default 10), `UNI_DB_CONNECTION_TIMEOUT_MS` (100–120000, default 5000), and `UNI_DB_IDLE_TIMEOUT_MS` (0–600000, default 30000). Configuration errors and database logs never include the connection string. The reviewed exact pins are `pg@8.23.1` (npm release 2026-09-30) and `@types/pg@8.23.1` (npm release 2026-08-17); both releases predate 2026-10-15 by more than seven days.

Run commands from the repository root:

```sh
# Compose starts PostgreSQL privately; it does not publish port 5432.
docker compose up -d postgres uni

# Apply SQL deliberately; the application does not migrate automatically.
docker compose exec uni pnpm --filter @sef/uni-server db:migrate
docker compose exec uni pnpm --filter @sef/uni-server db:status
docker compose exec uni pnpm --filter @sef/uni-server db:check

# Start a separate disposable PostgreSQL container, run the integration tests,
# then remove that test-only Compose project and its temporary storage.
pnpm --filter @sef/uni-server db:test:integration
```

For a native server/database command, set `UNI_DATABASE_URL` explicitly in the environment. Do not copy the Compose-internal hostname (`postgres`) into a host-run URL. The default Compose password is local-development-only; set a long, unique `UNI_DB_PASSWORD` in the private `.env` file before any deployment or network exposure. The PostgreSQL service is on a dedicated internal Compose network shared only with `uni`, has no host port mapping, and persists its own volume separately from `uni-data`.

## Migration safety

Migrations are append-only SQL files under `migrations/`; each has a contiguous integer version and SHA-256 checksum recorded in `schema_migrations`. A transaction-scoped advisory lock serializes migration runs. Unknown future versions, gaps, and edits to an already-applied migration are rejected. DDL and ledger updates are transactional. Never edit an applied migration; add the next version instead.

The integration command generates a random test password and free loopback port, starts a uniquely named Compose project with a disposable `tmpfs` data directory, and passes only that test URL to the integration test process. Tests additionally require the runner marker, loopback address, and the exact `sef_uni_test` database name. They create isolated schemas and never drop or truncate rows. They do not use `UNI_DATABASE_URL`, `.data/uni`, or an existing database. The integration runner always tears down its unique project, including on test failure.

## Tables

The initial migration adds `student_profiles`, `enrolments`, `course_selections`, `staff_memberships`, and `audit_events`. Each mutable record uses a positive `version` for optimistic concurrency. Foreign keys and natural-key uniqueness protect enrollment and course assignment relationships; code, status, dates, names, and audit JSON have checks. No auth-library/user/password schema is created.

## Readiness, backups, and restore boundary

`checkDatabaseReadiness(pool)` performs a `SELECT 1` probe and reports only ready/not-ready; `db:check` is the explicit command-line probe. Do not add database readiness as an application route dependency until the DB-backed routes are introduced.

Back up only to a protected location outside the repository and `.data/uni`; use restrictive permissions and retain the dump according to the deployment's data policy. For the Compose database, an operator can use:

```sh
umask 077
docker compose exec -T postgres pg_dump -U sef -d sef_uni --format=custom --no-owner > /secure-backups/saint-elms-uni.dump
```

Restore only into a newly created, empty, explicitly designated restore database, then verify it before planning any cutover. Do not use `--clean`/`--if-exists` against an existing database. Never restore a real backup into the disposable integration-test database, and never point test commands at a real or existing database. The migration command is not a backup/restore command and does not provide destructive rollback; take and verify a backup before production migrations.
