import { spawn, spawnSync, type ChildProcess } from 'node:child_process';
import { mkdirSync, mkdtempSync, openSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { ENGINE_PORT, UNI_PORT, UNI_URL } from './support';

/**
 * Starts the university server and the student engine for the run and stops them
 * afterwards.
 *
 * The uni serves `/app` and `/device` itself, which is the point: the account endpoints
 * and the pages that use them are same-origin, so the HttpOnly session cookie behaves
 * exactly as it will in production. No mocking, no proxy. The engine runs against an
 * isolated throwaway ENGINE_DATA_DIR with SEED_DEMO=false, so the drill's students are
 * created by the drill itself — nothing seeded, nothing shared with the dev box.
 *
 * The disposable PostgreSQL the uni uses is provisioned outside this file (the compose
 * db-test stack or any reachable instance given by E2E_DATABASE_URL); this file applies
 * the pending migrations to it first, which is the same explicit step a deployment runs.
 */

const REPO = path.resolve(import.meta.dirname, '..');
const PORTAL_DIR = path.join(REPO, 'apps/desktop/dist-portal');
const DB_URL = process.env.E2E_DATABASE_URL ?? 'postgres://sef:sef-uni-local-dev-only@127.0.0.1:5433/sef_uni';
const ENGINE_URL = `http://127.0.0.1:${ENGINE_PORT}`;
const ENGINE_DATA = mkdtempSync(path.join(tmpdir(), 'sef-e2e-engine-'));
// The uni's file stores (audit, shares, dispersal, seeded accounts) and its signing keys
// are just as throwaway as the database — a run must never write into the dev checkout's
// .data/uni or keys/ and then leak those fixtures into someone's demo.
const UNI_DATA = mkdtempSync(path.join(tmpdir(), 'sef-e2e-uni-'));

let uni: ChildProcess | null = null;
let engine: ChildProcess | null = null;
const LOG = path.join(REPO, 'test-results/e2e-uni.log');
const ENGINE_LOG = path.join(REPO, 'test-results/e2e-engine.log');

/**
 * The server's output goes to a file rather than the inherited stdout. A child that
 * inherits the parent's stdout keeps that pipe open for its whole life, so the run never
 * reaches EOF and `pnpm test:e2e | tail` hangs forever on a pass.
 */
mkdirSync(path.dirname(LOG), { recursive: true });
const logFd = openSync(LOG, 'a');
const engineLogFd = openSync(ENGINE_LOG, 'a');

const reachable = async (url: string): Promise<boolean> => {
  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(1_500) });
    return res.ok;
  } catch {
    return false;
  }
};

/**
 * Skips are communicated through a file, not an environment variable: global setup and the
 * workers are separate processes, and an exported env var does not survive that boundary.
 * The drill spec also reads the engine address and data dir out of it.
 */
const statusPath = path.join(REPO, 'test-results/e2e-status.json');
const writeStatus = (value: { ok: boolean; reason?: string; engineUrl?: string; engineDataDir?: string; uniUrl?: string }) =>
  writeFileSync(statusPath, JSON.stringify(value), 'utf8');

const spawnService = (binDir: string, cwd: string, env: NodeJS.ProcessEnv, fd: number): ChildProcess =>
  spawn(path.join(binDir, 'node_modules/.bin/tsx'), ['src/index.ts'], {
    cwd,
    env: { ...process.env, ...env },
    stdio: ['ignore', fd, fd],
    // Own process group: tsx re-execs node as a child, so killing only the wrapper leaves
    // the real server orphaned and still holding the port. detached lets stop() signal
    // the whole group.
    detached: true,
  });

const waitFor = async (label: string, url: string, proc: ChildProcess | null, deadlineMs = 45_000): Promise<string | null> => {
  const deadline = Date.now() + deadlineMs;
  while (Date.now() < deadline) {
    if (proc && proc.exitCode !== null) return `${label} exited with status ${proc.exitCode}.`;
    if (await reachable(url)) return null;
    await new Promise((resolve) => setTimeout(resolve, 400));
  }
  return `${label} did not become healthy in time.`;
};

export default async function globalSetup(): Promise<(() => Promise<void>) | void> {
  // Something already answering /health on our port is not our server: running against it would
  // test the wrong build while reporting ours. Refuse to start rather than race the spawn.
  for (const [name, url] of [
    ['university server', `${UNI_URL}/health`],
    ['engine', `${ENGINE_URL}/api/health`],
  ] as const) {
    if (await reachable(url)) {
      writeStatus({ ok: false, reason: `A ${name} already answers at ${url} — kill it or set the E2E port overrides.` });
      return;
    }
  }

  /**
   * Migrations are explicit, here exactly as on a real deployment: the uni refuses the
   * account surface until the schema is at the supported version, so a stale test
   * database must be brought forward before the server starts.
   */
  const migrated = spawnSync(
    path.join(REPO, 'server/uni/node_modules/.bin/tsx'),
    ['src/scripts/db-migrate.ts'],
    { cwd: path.join(REPO, 'server/uni'), env: { ...process.env, UNI_DATABASE_URL: DB_URL }, encoding: 'utf8', timeout: 60_000 },
  );
  if (migrated.status !== 0) {
    const detail = `${migrated.stderr || migrated.stdout || 'no output'}`.split('\n').filter(Boolean).at(-1) ?? 'unknown';
    writeStatus({ ok: false, reason: `db:migrate against E2E_DATABASE_URL failed (${detail}). Start a throwaway PostgreSQL and set E2E_DATABASE_URL.` });
    return;
  }

  /**
   * Auth rate limits live in auth_kv (the database-backed secondary store), keyed by source
   * IP — and every e2e request shares 127.0.0.1. Two runs inside a window would inherit the
   * previous run's spend and 429 on the very first sign-up, so the disposable database's
   * buckets are flushed as part of bringing it to a known state. The limits themselves are
   * never relaxed: the drill stays inside the real budget (5 sign-ups/min).
   */
  const flushBuckets = spawnSync(
    process.execPath,
    [
      '-e',
      `const { Client } = require('pg');
       const c = new Client({ connectionString: process.env.UNI_DATABASE_URL });
       c.connect()
         .then(() => c.query('DELETE FROM auth_kv'))
         .then(() => c.end())
         .catch((e) => { console.error(e.message); process.exit(1); });`,
    ],
    { cwd: path.join(REPO, 'server/uni'), env: { ...process.env, UNI_DATABASE_URL: DB_URL }, encoding: 'utf8', timeout: 30_000 },
  );
  if (flushBuckets.status !== 0) {
    writeStatus({ ok: false, reason: `Could not flush auth_kv rate-limit buckets: ${flushBuckets.stderr || 'unknown'}.` });
    return;
  }

  uni = spawnService(
    path.join(REPO, 'server/uni'),
    path.join(REPO, 'server/uni'),
    {
      UNI_PORT: String(UNI_PORT),
      UNI_HOST: '127.0.0.1',
      UNI_DATABASE_URL: DB_URL,
      BETTER_AUTH_SECRET: process.env.BETTER_AUTH_SECRET ?? 'e2e-local-secret-not-for-production-0123456789',
      UNI_PUBLIC_URL: `http://localhost:${UNI_PORT}`,
      MAIL_SMTP_URL: process.env.MAIL_SMTP_URL ?? 'smtp://127.0.0.1:1025',
      MAIL_FROM: process.env.MAIL_FROM ?? 'e2e@saintelms.local',
      UNI_PORTAL_DIR: PORTAL_DIR,
      UNI_DATA_DIR: UNI_DATA,
      KEYS_DIR: path.join(UNI_DATA, 'keys'),
    },
    logFd,
  );

  const uniFailure = await waitFor('The university server', `${UNI_URL}/health`, uni);
  if (uniFailure) {
    writeStatus({ ok: false, reason: `${uniFailure} See ${LOG}.` });
    await globalTeardown();
    return;
  }

  engine = spawnService(
    path.join(REPO, 'engine'),
    path.join(REPO, 'engine'),
    {
      ENGINE_PORT: String(ENGINE_PORT),
      ENGINE_HOST: '127.0.0.1',
      ENGINE_DATA_DIR: ENGINE_DATA,
      SEED_DEMO: 'false',
      UNI_SERVER_URL: UNI_URL,
      // Model roles stay overrideable so the drill can point at whatever is pulled.
      ...(process.env.E2E_TUTOR_MODEL ? { TUTOR_MODEL: process.env.E2E_TUTOR_MODEL } : {}),
      ...(process.env.E2E_BRAIN_MODEL ? { BRAIN_MODEL: process.env.E2E_BRAIN_MODEL } : {}),
      ...(process.env.E2E_VISION_MODEL ? { VISION_MODEL: process.env.E2E_VISION_MODEL } : {}),
      ...(process.env.E2E_OLLAMA_URL ? { OLLAMA_URL: process.env.E2E_OLLAMA_URL } : {}),
      ...(process.env.E2E_SEARXNG_URL ? { SEARXNG_URL: process.env.E2E_SEARXNG_URL } : {}),
    },
    engineLogFd,
  );

  const engineFailure = await waitFor('The engine', `${ENGINE_URL}/api/health`, engine);
  if (engineFailure) {
    writeStatus({ ok: false, reason: `${engineFailure} See ${ENGINE_LOG}.` });
    await globalTeardown();
    return;
  }

  writeStatus({ ok: true, engineUrl: ENGINE_URL, engineDataDir: ENGINE_DATA, uniUrl: UNI_URL });
  // Playwright runs the function globalSetup returns as the run's teardown — exporting a
  // `globalTeardown` name alone wires nothing, and leaked servers poison the next run's
  // port guard.
  return globalTeardown;
}

const killTree = (proc: ChildProcess, signal: NodeJS.Signals): void => {
  try {
    // Negative pid targets the process group detached:true created — the tsx wrapper and
    // the node server it exec'd die together.
    if (proc.pid) process.kill(-proc.pid, signal);
  } catch {
    try {
      proc.kill(signal);
    } catch {
      /* already gone */
    }
  }
};

const stop = async (proc: ChildProcess | null): Promise<void> => {
  if (!proc || proc.exitCode !== null) return;
  await new Promise<void>((resolve) => {
    proc.once('exit', () => resolve());
    killTree(proc, 'SIGTERM');
    setTimeout(() => {
      killTree(proc, 'SIGKILL');
      resolve();
    }, 3_000);
  });
};

export async function globalTeardown(): Promise<void> {
  await Promise.all([stop(uni), stop(engine)]);
}
