import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { expect, request as newRequest, test, type APIRequestContext } from '@playwright/test';
import { ENGINE_URL, MAILPIT_URL, UNI_URL, type E2EStatus } from './support';

/**
 * "Open my workspace" (PR-45), end to end: an approved student signs in on the university
 * portal, asks for a workspace, watches the real spawn steps, and is handed to the VM once the
 * browser itself sees the VM's public health ready. The uni runs its real session orchestrator
 * against the in-repo fake Instabox; the e2e engine plays the VM (it serves the workspace UI).
 */

const ORIGIN = `http://localhost:${Number(process.env.E2E_UNI_PORT ?? 4310)}`;
const DB_URL = process.env.E2E_DATABASE_URL ?? 'postgres://sef:sef-uni-local-dev-only@127.0.0.1:5433/sef_uni';
const PASSWORD = 'workspace-drill-password-1';
const PROGRAMME = 'bsc-physics-mathematics-astrophysics';
const COHORT = 'bsc-pma-2026';
const REPO = path.resolve(import.meta.dirname, '..');

const status = (): E2EStatus | null => {
  try {
    return JSON.parse(readFileSync(path.join(REPO, 'test-results/e2e-status.json'), 'utf8')) as E2EStatus;
  } catch {
    return null;
  }
};

const latestLinkTo = async (email: string, since: number): Promise<string> => {
  const deadline = Date.now() + 15_000;
  while (Date.now() < deadline) {
    const list = (await (await fetch(`${MAILPIT_URL}/api/v1/messages?limit=50`)).json()) as {
      messages: Array<{ ID: string; To: Array<{ Address: string }>; Created: string }>;
    };
    const hit = list.messages
      .filter((m) => m.To.some((t) => t.Address.toLowerCase() === email.toLowerCase()) && Date.parse(m.Created) >= since - 60_000)
      .sort((a, b) => Date.parse(b.Created) - Date.parse(a.Created))[0];
    if (hit) {
      const detail = (await (await fetch(`${MAILPIT_URL}/api/v1/message/${hit.ID}`)).json()) as { Text?: string };
      const match = (detail.Text ?? '').match(/https?:\/\/\S+/);
      if (match) return match[0]!;
    }
    await new Promise((resolve) => setTimeout(resolve, 400));
  }
  throw new Error(`No mail arrived for ${email}: is Mailpit running and MAIL_SMTP_URL pointing at it?`);
};

const registerVerified = async (email: string, name: string): Promise<APIRequestContext> => {
  const ctx = await newRequest.newContext({ baseURL: UNI_URL, extraHTTPHeaders: { origin: ORIGIN } });
  const before = Date.now();
  const signUp = await ctx.post('/v1/auth/sign-up/email', { data: { email, password: PASSWORD, name } });
  assert.ok(signUp.ok(), `sign-up failed: ${signUp.status()} ${await signUp.text()}`);
  const url = new URL(await latestLinkTo(email, before));
  url.searchParams.set('callbackURL', '/');
  const verified = await ctx.fetch(url.toString(), { maxRedirects: 0 });
  assert.ok(verified.status() === 302 || verified.ok(), `verification answered ${verified.status()}`);
  const signedIn = await ctx.post('/v1/auth/sign-in/email', { data: { email, password: PASSWORD } });
  assert.ok(signedIn.ok(), `sign-in failed: ${signedIn.status()}`);
  return ctx;
};

test('an approved student opens a workspace: progress, ready, hand-off to the VM', async ({ page }) => {
  const stack = status();
  test.skip(!stack?.ok, stack?.reason ?? 'The e2e stack did not start.');
  test.skip(!stack?.workspaceUi, 'No workspace UI build: run the dist-workspace build named in e2e/support.ts first.');
  test.setTimeout(120_000);

  // The same budget flush as global setup, so earlier specs' sign-ups cannot spend this one's.
  execFileSync(process.execPath, ['-e', `const { Client } = require('pg'); const c = new Client({ connectionString: process.env.UNI_DATABASE_URL }); c.connect().then(() => c.query('DELETE FROM auth_kv')).then(() => c.end()).catch((e) => { console.error(e.message); process.exit(1); });`], {
    cwd: path.join(REPO, 'server/uni'),
    env: { ...process.env, UNI_DATABASE_URL: DB_URL },
    stdio: 'pipe',
    timeout: 30_000,
  });

  const stamp = Date.now();
  const opsEmail = `ops-${stamp}@workspace.test`;
  const ops = await registerVerified(opsEmail, 'Workspace Ops');
  execFileSync(path.join(REPO, 'server/uni/node_modules/.bin/tsx'), ['src/scripts/grant-staff.ts', '--email', opsEmail, '--role', 'registrar'], {
    cwd: path.join(REPO, 'server/uni'),
    env: { ...process.env, UNI_DATABASE_URL: DB_URL },
    stdio: 'pipe',
    timeout: 60_000,
  });

  const email = `student-${stamp}@workspace.test`;
  const student = await registerVerified(email, 'Wren Workspace');
  const applied = await student.post('/v1/applications', { data: { schemaVersion: 2, programmeId: PROGRAMME } });
  assert.ok([200, 201].includes(applied.status()), `application failed: ${await applied.text()}`);
  const rows = (await (await ops.get(`/v1/admin/students?search=${encodeURIComponent(email)}`)).json()) as {
    rows: Array<{ email: string; enrolment: { id: string; version: number } | null }>;
  };
  const enrolment = rows.rows.find((r) => r.email === email)?.enrolment;
  assert.ok(enrolment, 'applicant not visible to staff');
  const decided = await ops.post(`/v1/admin/enrolments/${enrolment.id}/decision`, {
    data: { schemaVersion: 2, expectedVersion: enrolment.version, action: 'approve', reason: 'Workspace drill admission.', cohortId: COHORT },
  });
  assert.equal(decided.status(), 200, `approval failed: ${await decided.text()}`);

  try {
    // The uni's trusted origin is its public URL (localhost), as in the onboarding spec.
    await page.goto(`${ORIGIN}/app/`);
    await page.getByLabel('Email address').fill(email);
    await page.getByLabel('Password').fill(PASSWORD);
    await page.getByRole('button', { name: 'Sign in' }).click();
    await expect(page.getByText('You are enrolled')).toBeVisible();

    await page.getByRole('button', { name: 'Open my workspace' }).click();
    await expect(page.getByRole('heading', { name: 'Starting your workspace…' })).toBeVisible();
    // The real steps, as the university reports them while the fake's operations run.
    await expect(page.getByText(/Creating your workspace|Starting it up|Giving it an address/).first()).toBeVisible();

    await page.waitForURL(`${ENGINE_URL}/**`, { timeout: 60_000 });
    await expect(page.getByRole('button', { name: 'Continue with your university account' })).toBeVisible();

    const session = (await (await student.get('/v1/session')).json()) as { state: string; url?: string };
    assert.equal(session.state, 'ready');
    assert.equal(session.url, ENGINE_URL);
  } finally {
    // Logout path: the uni flushes (the fake exec) and deletes the fake machine.
    await student.delete('/v1/session');
    await Promise.all([student.dispose(), ops.dispose()]);
  }
});
