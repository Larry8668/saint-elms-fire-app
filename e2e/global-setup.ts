import { spawn, type ChildProcess } from 'node:child_process';
import { mkdirSync, openSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { UNI_PORT, UNI_URL } from './support';

/**
 * Starts the university server for the run and stops it afterwards.
 *
 * The uni serves `/app` and `/device` itself, which is the point: the account endpoints and
 * the pages that use them are same-origin, so the HttpOnly session cookie behaves exactly as
 * it will in production. No mocking, no proxy.
 */

const REPO = path.resolve(import.meta.dirname, '..');
const PORTAL_DIR = path.join(REPO, 'apps/desktop/dist-portal');
const DB_URL = process.env.E2E_DATABASE_URL ?? 'postgres://sef:sef-uni-local-dev-only@127.0.0.1:5433/sef_uni';

let uni: ChildProcess | null = null;
const LOG = path.join(REPO, 'test-results/e2e-uni.log');

/**
 * The server's output goes to a file rather than the inherited stdout. A child that inherits
 * the parent's stdout keeps that pipe open for its whole life, so the run never reaches EOF
 * and `pnpm test:e2e | tail` hangs forever on a pass.
 */
mkdirSync(path.dirname(LOG), { recursive: true });
const logFd = openSync(LOG, 'a');

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
 */
const statusPath = path.join(REPO, 'test-results/e2e-status.json');
const writeStatus = (value: { ok: boolean; reason?: string }) =>
  writeFileSync(statusPath, JSON.stringify(value), 'utf8');

export default async function globalSetup(): Promise<void> {
  writeStatus({ ok: true });

  uni = spawn(
    path.join(REPO, 'server/uni/node_modules/.bin/tsx'),
    ['src/index.ts'],
    {
      cwd: path.join(REPO, 'server/uni'),
      env: {
        ...process.env,
        UNI_PORT: String(UNI_PORT),
        UNI_HOST: '127.0.0.1',
        UNI_DATABASE_URL: DB_URL,
        BETTER_AUTH_SECRET: process.env.BETTER_AUTH_SECRET ?? 'e2e-local-secret-not-for-production-0123456789',
        UNI_PUBLIC_URL: `http://localhost:${UNI_PORT}`,
        MAIL_SMTP_URL: process.env.MAIL_SMTP_URL ?? 'smtp://127.0.0.1:1025',
        MAIL_FROM: process.env.MAIL_FROM ?? 'e2e@saintelms.local',
        UNI_PORTAL_DIR: PORTAL_DIR,
      },
      stdio: ['ignore', logFd, logFd],
    },
  );

  const deadline = Date.now() + 45_000;
  while (Date.now() < deadline) {
    if (uni.exitCode !== null) {
      writeStatus({ ok: false, reason: `The university server exited with status ${uni.exitCode}. See ${LOG}.` });
      uni = null;
      return;
    }
    if (await reachable(`${UNI_URL}/health`)) return;
    await new Promise((resolve) => setTimeout(resolve, 400));
  }
  writeStatus({ ok: false, reason: `The university server did not become healthy in time. See ${LOG}.` });
  await globalTeardown();
}

export async function globalTeardown(): Promise<void> {
  if (!uni || uni.exitCode !== null) return;
  await new Promise<void>((resolve) => {
    uni!.once('exit', () => resolve());
    uni!.kill('SIGTERM');
    setTimeout(() => {
      uni!.kill('SIGKILL');
      resolve();
    }, 3_000);
  });
}

