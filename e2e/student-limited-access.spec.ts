import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { request as newRequest, test, type APIRequestContext } from '@playwright/test';
import { ENGINE_URL, MAILPIT_URL, UNI_URL, type E2EStatus } from './support';

/**
 * Limited access, end to end: an enrolment the university suspends mid-life turns the
 * student's next sign-in into a read/export-only session, exercised here against the
 * real stack — real registrar decision, real device grants, real engine, no mocks.
 *
 * The expired-entitlement leg of the same feature is covered at engine integration
 * level instead (engine/src/http/limited-access.test.ts): the harness uni cannot issue
 * an already-expired entitlement — ENTITLEMENT_HOURS bottoms out at one hour and this
 * repo's e2e rule is no clock mocks — while minting one by hand would mean re-signing
 * with the uni's key, which is exactly what the engine tests do with a throwaway pair.
 * Both legs land on the same enforcement surface, which this spec drives over HTTP:
 * GET/HEAD stays open, mutations answer 403 access_limited, export and sign-out work.
 * (Pending-applicant confinement is in the same engine suite; it costs a whole device
 * grant here and proves nothing new.)
 *
 * Two budget rules keep this spec a good neighbour. It runs last — the file name sorts
 * after the other specs, and with `workers: 1` that is the run order — and it starts by
 * flushing the database-backed rate-limit buckets (the same flush global setup does),
 * so neither the drill's sign-up burst nor a concurrent run on this shared database can
 * spend this spec's allowance, and this spec's burst can never spend theirs.
 */

const ORIGIN = `http://localhost:${Number(process.env.E2E_UNI_PORT ?? 4310)}`;
const DB_URL = process.env.E2E_DATABASE_URL ?? 'postgres://sef:sef-uni-local-dev-only@127.0.0.1:5433/sef_uni';
const PASSWORD = 'limited-access-password-1';
const PROGRAMME = 'bsc-physics-mathematics-astrophysics';
const COHORT = 'bsc-pma-2026';
const REPO = path.resolve(import.meta.dirname, '..');

interface DrilledAccount {
  email: string;
  ctx: APIRequestContext;
}

const needsStack = async (): Promise<E2EStatus> => {
  let status: E2EStatus | null = null;
  try {
    status = JSON.parse(readFileSync(path.resolve(import.meta.dirname, '../test-results/e2e-status.json'), 'utf8')) as E2EStatus;
  } catch {
    test.skip(true, 'No global setup status was recorded, so the e2e stack never started.');
  }
  if (!status?.ok) test.skip(true, status?.reason ?? 'The e2e stack did not start.');
  try {
    const res = await fetch(`${UNI_URL}/ready`, { signal: AbortSignal.timeout(2_000) });
    if (!res.ok) test.skip(true, `The university server answered /ready ${res.status} — the account layer is not up.`);
  } catch {
    test.skip(true, 'The university server is not reachable.');
  }
  try {
    const res = await fetch(`${ENGINE_URL}/api/health`, { signal: AbortSignal.timeout(2_000) });
    if (!res.ok) test.skip(true, 'The engine answered but is not healthy.');
  } catch {
    test.skip(true, 'The engine is not reachable.');
  }
  return status!;
};

const mailpitUp = async (): Promise<boolean> => {
  try {
    return (await fetch(`${MAILPIT_URL}/api/v1/messages`, { signal: AbortSignal.timeout(2_000) })).ok;
  } catch {
    return false;
  }
};

/** Pulls the newest link mailed to an address out of Mailpit. */
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
  throw new Error(`No mail arrived for ${email} — is Mailpit running and MAIL_SMTP_URL pointing at it?`);
};

const uniCtx = () => newRequest.newContext({ baseURL: UNI_URL, extraHTTPHeaders: { origin: ORIGIN } });

const signIn = async (account: DrilledAccount): Promise<void> => {
  const res = await account.ctx.post('/v1/auth/sign-in/email', { data: { email: account.email, password: PASSWORD } });
  assert.ok(res.ok(), `sign-in failed: ${res.status()} ${await res.text()}`);
};

/** register → verify-by-email → sign in; the returned context carries the session cookie. */
const registerVerifiedStudent = async (email: string, name: string): Promise<DrilledAccount> => {
  const account: DrilledAccount = { email, ctx: await uniCtx() };
  const before = Date.now();
  const signUp = await account.ctx.post('/v1/auth/sign-up/email', { data: { email, password: PASSWORD, name } });
  assert.ok(signUp.ok(), `sign-up failed: ${signUp.status()} ${await signUp.text()}`);
  const link = await latestLinkTo(email, before);
  const url = new URL(link);
  url.searchParams.set('callbackURL', '/');
  const verified = await account.ctx.fetch(url.toString(), { maxRedirects: 0 });
  assert.ok(verified.status() === 302 || verified.ok(), `verification link answered ${verified.status()}`);
  await signIn(account);
  return account;
};

interface EngineSignIn {
  token: string;
  profile: { id: string; admission?: string };
  access?: { mode: string; reason?: string };
}

/** engine device grant → the student claims and approves it on the uni → poll returns an engine session. */
const deviceSignIn = async (account: DrilledAccount): Promise<EngineSignIn> => {
  const started = await fetch(`${ENGINE_URL}/api/auth/device/start`, { method: 'POST' });
  // Read the body once — an assert message that awaits text() would consume the stream.
  const grant = (await started.json().catch(() => null)) as { userCode?: string } | null;
  assert.ok(started.status === 200 && grant?.userCode, `device start failed: ${started.status} ${JSON.stringify(grant)}`);

  const claim = await account.ctx.get(`/v1/auth/device?user_code=${encodeURIComponent(grant!.userCode)}`);
  assert.ok(claim.ok(), `device claim failed: ${claim.status()} ${await claim.text()}`);
  const approve = await account.ctx.post('/v1/auth/device/approve', { data: { userCode: grant!.userCode } });
  assert.ok(approve.ok(), `device approve failed: ${approve.status()} ${await approve.text()}`);

  for (let attempt = 0; attempt < 12; attempt += 1) {
    const poll = await fetch(`${ENGINE_URL}/api/auth/device/poll`, { method: 'POST' });
    const body = (await poll.json()) as ({ status: 'approved' } & EngineSignIn) | { status: string };
    if (body.status === 'approved' && 'token' in body) return body;
    if (body.status === 'denied' || body.status === 'expired') throw new Error(`device grant ${body.status}`);
    await new Promise((resolve) => setTimeout(resolve, 800));
  }
  throw new Error('device grant never approved');
};

const engine = async (token: string, method: string, path: string, body?: unknown) => {
  const res = await fetch(`${ENGINE_URL}${path}`, {
    method,
    headers: { authorization: `Bearer ${token}`, ...(body === undefined ? {} : { 'content-type': 'application/json' }) },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const json = await res.json().catch(() => null);
  return { status: res.status, body: json };
};

test.describe('limited access — read/export-only after the uni says no', () => {
  test('suspension turns the next sign-in read/export-only; files stay exportable', async () => {
    test.setTimeout(300_000);
    await needsStack();
    if (!(await mailpitUp())) test.skip(true, `Mailpit is not reachable at ${MAILPIT_URL} — run "docker compose --profile mail up -d mailpit".`);

    // Fresh rate-limit window for this spec's burst, exactly as global setup does per run.
    execFileSync(
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
      { cwd: path.join(REPO, 'server/uni'), env: { ...process.env, UNI_DATABASE_URL: DB_URL }, stdio: 'pipe', timeout: 30_000 },
    );

    // ---- staff: register, verify, then the operator grant (no HTTP path, by design) ----
    const ops = await registerVerifiedStudent(`ops-${Date.now()}@limited.test`, 'Limited Ops');
    execFileSync(
      path.join(REPO, 'server/uni/node_modules/.bin/tsx'),
      ['src/scripts/grant-staff.ts', '--email', ops.email, '--role', 'registrar'],
      { cwd: path.join(REPO, 'server/uni'), env: { ...process.env, UNI_DATABASE_URL: DB_URL }, stdio: 'pipe', timeout: 60_000 },
    );
    const opsMe = (await (await ops.ctx.get('/v1/me')).json()) as { staffRoles: string[] };
    assert.ok(opsMe.staffRoles.includes('registrar'), 'staff grant did not take effect');

    // ---- student: register, verify, apply, get approved, sign in fully, file something ----
    const student = await registerVerifiedStudent(`student-${Date.now()}@limited.test`, 'Lee Limited');
    const applied = await student.ctx.post('/v1/applications', { data: { schemaVersion: 2, programmeId: PROGRAMME } });
    assert.ok([200, 201].includes(applied.status()), `application failed: ${await applied.text()}`);

    const find = async () => {
      const students = (await (await ops.ctx.get(`/v1/admin/students?search=${encodeURIComponent(student.email)}`)).json()) as {
        rows: Array<{ email: string; enrolment: { id: string; version: number; status: string } | null }>;
      };
      const row = students.rows.find((r) => r.email === student.email);
      assert.ok(row?.enrolment, 'applicant not visible to staff');
      return row.enrolment!;
    };
    const pendingEnrolment = await find();
    const approved = await ops.ctx.post(`/v1/admin/enrolments/${pendingEnrolment.id}/decision`, {
      data: { schemaVersion: 2, expectedVersion: pendingEnrolment.version, action: 'approve', reason: 'Limited-access drill admission.', cohortId: COHORT },
    });
    assert.equal(approved.status(), 200, `approval failed: ${await approved.text()}`);

    const fullSession = await deviceSignIn(student);
    assert.equal(fullSession.profile.admission, 'approved');
    assert.notEqual(fullSession.access?.mode, 'limited');
    const note = Buffer.from('My own summary of orbital mechanics: orbits are falls that keep missing the ground.', 'utf8').toString('base64');
    const ingested = await engine(fullSession.token, 'POST', '/api/sources', { kind: 'note', title: 'Orbits, in my words', mediaType: 'text/plain', data: note });
    assert.equal(ingested.status, 201, `ingest failed: ${JSON.stringify(ingested.body)}`);

    // ---- the registrar suspends the enrolment; the uni revokes the student's sessions ----
    const approvedEnrolment = await find();
    assert.equal(approvedEnrolment.status, 'approved');
    const suspended = await ops.ctx.post(`/v1/admin/enrolments/${approvedEnrolment.id}/decision`, {
      data: { schemaVersion: 2, expectedVersion: approvedEnrolment.version, action: 'suspend', reason: 'Limited-access drill suspension.' },
    });
    assert.equal(suspended.status(), 200, `suspension failed: ${await suspended.text()}`);
    // The account itself is not disabled: the student signs back in to confirm the device.
    await signIn(student);

    // ---- the next sign-in is read/export-only, and the engine says so honestly ----
    const limitedSession = await deviceSignIn(student);
    assert.equal(limitedSession.profile.admission, 'suspended');
    assert.deepEqual(limitedSession.access, { mode: 'limited', reason: 'admission_suspended' });
    const me = await engine(limitedSession.token, 'GET', '/api/auth/me');
    assert.equal(me.status, 200);
    assert.deepEqual((me.body as { access?: unknown }).access, { mode: 'limited', reason: 'admission_suspended' });

    // Their own files stay readable — the suspension cannot hold them hostage.
    assert.equal((await engine(limitedSession.token, 'GET', '/api/brain/pages')).status, 200);
    assert.equal((await engine(limitedSession.token, 'GET', '/api/sources')).status, 200);

    // Every mutation answers the same typed refusal.
    for (const [method, path, body] of [
      ['POST', '/api/sources', { kind: 'note', title: 'x', mediaType: 'text/plain', data: note }],
      ['PUT', '/api/settings', { thinking: false }],
      ['POST', '/api/chat/sessions', { teacher: 'guide' }],
      ['POST', '/api/vault/import', { archive: {} }],
      ['POST', '/api/vault/import/preview', { archive: {} }],
    ] as const) {
      const res = await engine(limitedSession.token, method, path, body);
      assert.equal(res.status, 403, `${method} ${path}`);
      assert.equal((res.body as { code?: string })?.code, 'access_limited', `${method} ${path}`);
    }

    // The export — the point of the mode — works, and carries the note filed while full.
    const exported = await engine(limitedSession.token, 'POST', '/api/vault/export', {});
    assert.equal(exported.status, 200, `export failed: ${JSON.stringify(exported.body)}`);
    assert.ok((exported.body as { counts: { files: number } }).counts.files >= 1, 'the export carries the vault the student built');

    // And a limited session can always end itself.
    assert.equal((await engine(limitedSession.token, 'POST', '/api/auth/logout', {})).status, 204);
    assert.equal((await engine(limitedSession.token, 'GET', '/api/auth/me')).status, 401);
  });
});
