import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { expect, request as newRequest, test, type APIRequestContext } from '@playwright/test';
import { ENGINE_URL, MAILPIT_URL, UNI_URL, type E2EStatus } from './support';

/**
 * The release drill: the full student lifecycle run once, end to end, against the real
 * university server and a real engine the harness started on isolated state.
 *
 *   register → verify email → apply → registrar approves → record correction →
 *   device sign-in → course install → source ingest → keeper compile → review/accept →
 *   tutor turn (live local model) → save the answer → explore from the wiki →
 *   publish to the cohort → a second student imports → vault export → restore →
 *   source erasure with an honest tombstone → account switching and offline unlock
 *   on the same engine.
 *
 * Only the steps that genuinely need a local model — keeper compile, the tutor turn,
 * save-to-wiki, anchored explore, and publish/import (its payload is a compiled page) —
 * skip, with the reason, when the configured model is not pulled. Everything else,
 * including account switching, vault export/restore and the erasure drill, always runs.
 *
 * Nothing here is mocked: mail goes through SMTP to Mailpit, the device grant is the
 * uni's real RFC 8628 endpoints, and the keeper/tutor calls hit the local model the
 * engine is configured with. Accounts are throwaway `*.release.test` identities — no
 * real student's data is ever needed.
 */

const ORIGIN = `http://localhost:${Number(process.env.E2E_UNI_PORT ?? 4310)}`;
const DB_URL = process.env.E2E_DATABASE_URL ?? 'postgres://sef:sef-uni-local-dev-only@127.0.0.1:5433/sef_uni';
const PASSWORD = 'release-drill-password-1';
const PROGRAMME = 'bsc-physics-mathematics-astrophysics';
const COHORT = 'bsc-pma-2026';
/** The model the drill points the engine at — the project model. Override E2E_LIVE_MODEL on a machine without it pulled. */
const LIVE_MODEL = process.env.E2E_LIVE_MODEL ?? 'gemma4:e4b';
const REPO = path.resolve(import.meta.dirname, '..');

interface DrilledAccount {
  email: string;
  ctx: APIRequestContext;
  userId: string;
  studentId?: string;
}

const statusFile = (): E2EStatus | null => {
  try {
    return JSON.parse(readFileSync(path.resolve(import.meta.dirname, '../test-results/e2e-status.json'), 'utf8')) as E2EStatus;
  } catch {
    return null;
  }
};

const needsStack = async (): Promise<E2EStatus> => {
  const status = statusFile();
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

/** register → verify-by-email → sign in; the returned context carries the session cookie. */
const registerVerifiedStudent = async (email: string, name: string): Promise<DrilledAccount> => {
  const ctx = await uniCtx();
  const before = Date.now();
  const signUp = await ctx.post('/v1/auth/sign-up/email', { data: { email, password: PASSWORD, name } });
  assert.ok(signUp.ok(), `sign-up failed: ${signUp.status()} ${await signUp.text()}`);

  const link = await latestLinkTo(email, before);
  const url = new URL(link);
  url.searchParams.set('callbackURL', '/');
  const verified = await ctx.fetch(url.toString(), { maxRedirects: 0 });
  assert.ok(verified.status() === 302 || verified.ok(), `verification link answered ${verified.status()}`);

  const signIn = await ctx.post('/v1/auth/sign-in/email', { data: { email, password: PASSWORD } });
  assert.ok(signIn.ok(), `sign-in failed: ${signIn.status()} ${await signIn.text()}`);
  const me = (await (await ctx.get('/v1/me')).json()) as { user: { id: string; emailVerified: boolean }; studentId: string | null };
  assert.equal(me.user.emailVerified, true);
  return { email, ctx, userId: me.user.id, studentId: me.studentId ?? undefined };
};

const applyForProgramme = async (account: DrilledAccount): Promise<void> => {
  const applied = await account.ctx.post('/v1/applications', {
    data: { schemaVersion: 2, programmeId: PROGRAMME },
  });
  assert.ok([200, 201].includes(applied.status()), `application failed: ${await applied.text()}`);
};

interface EngineSession {
  token: string;
  profileId: string;
}

/** engine device grant → student approves on the uni → poll returns an engine session. */
const deviceSignIn = async (account: DrilledAccount): Promise<EngineSession> => {
  const started = await fetch(`${ENGINE_URL}/api/auth/device/start`, { method: 'POST' });
  // Read the body once — an assert message that awaits text() would consume the stream
  // before json() ever sees it.
  const grant = (await started.json().catch(() => null)) as { userCode?: string } | null;
  assert.ok(started.status === 200 && grant?.userCode, `device start failed: ${started.status} ${JSON.stringify(grant)}`);

  // What /device does on load: the signed-in session claims the code first, then approves.
  const claim = await account.ctx.get(`/v1/auth/device?user_code=${encodeURIComponent(grant!.userCode)}`);
  assert.ok(claim.ok(), `device claim failed: ${claim.status()} ${await claim.text()}`);
  const approve = await account.ctx.post('/v1/auth/device/approve', { data: { userCode: grant!.userCode } });
  assert.ok(approve.ok(), `device approve failed: ${approve.status()} ${await approve.text()}`);

  for (let attempt = 0; attempt < 12; attempt += 1) {
    const poll = await fetch(`${ENGINE_URL}/api/auth/device/poll`, { method: 'POST' });
    const body = (await poll.json()) as { status: string; token?: string; profile?: { id: string; admission?: string } };
    if (body.status === 'approved' && body.token) {
      assert.equal(body.profile?.admission, 'approved');
      return { token: body.token, profileId: body.profile!.id };
    }
    if (body.status === 'denied' || body.status === 'expired') throw new Error(`device grant ${body.status}`);
    await new Promise((resolve) => setTimeout(resolve, 800));
  }
  throw new Error('device grant never approved');
};

const api = async (session: EngineSession, method: string, path: string, body?: unknown) => {
  const res = await fetch(`${ENGINE_URL}${path}`, {
    method,
    headers: { authorization: `Bearer ${session.token}`, ...(body === undefined ? {} : { 'content-type': 'application/json' }) },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const json = await res.json().catch(() => null);
  return { status: res.status, body: json };
};

/** Reads the SSE stream of a chat turn until the terminal event; returns the answer text. */
const chatTurn = async (session: EngineSession, sessionId: string, teacher: string, message: string, extra: Record<string, unknown> = {}): Promise<{ text: string; sawDone: boolean }> => {
  const res = await fetch(`${ENGINE_URL}/api/chat/turn`, {
    method: 'POST',
    headers: { authorization: `Bearer ${session.token}`, 'content-type': 'application/json' },
    body: JSON.stringify({ schemaVersion: 2, sessionId, teacher, clientMessageId: `drill-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`, message, ...extra }),
  });
  assert.equal(res.status, 200, `chat/turn answered ${res.status}`);
  const text = await res.text();
  let done = '';
  let sawDone = false;
  let error: string | null = null;
  for (const line of text.split('\n')) {
    if (!line.startsWith('data:')) continue;
    const event = JSON.parse(line.slice(5).trim()) as { type: string; text?: string; message?: string };
    if (event.type === 'done') {
      sawDone = true;
      done = event.text ?? '';
    }
    if (event.type === 'error') error = event.message ?? 'unknown';
  }
  assert.ok(!error, `chat turn failed: ${error}`);
  assert.ok(sawDone, 'chat turn never emitted a done event');
  return { text: done, sawDone };
};

const ollamaHas = async (model: string): Promise<boolean> => {
  try {
    const tags = await fetch(`${process.env.E2E_OLLAMA_URL ?? 'http://localhost:11434'}/api/tags`, { signal: AbortSignal.timeout(3_000) }).then((r) => r.json());
    return JSON.stringify(tags).includes(`"${model}`);
  } catch {
    return false;
  }
};

test.describe('release drill — the full student lifecycle', () => {
  test('register → verify → apply → approve → study → share → restore, on an isolated engine', async ({ browserName: _b }) => {
    test.setTimeout(600_000);
    const status = await needsStack();
    if (!(await mailpitUp())) test.skip(true, `Mailpit is not reachable at ${MAILPIT_URL} — run "docker compose --profile mail up -d mailpit".`);
    test.info().annotations.push({ type: 'env', description: `engine data dir: ${status.engineDataDir}` });

    // ---- staff: the operator path, exactly as documented (register, verify, CLI grant) ----
    const ops = await registerVerifiedStudent(`ops-${Date.now()}@release.test`, 'Release Ops');
    // The same operator script package.json's staff:grant runs — invoked through tsx
    // directly so pnpm's arg forwarding cannot mangle the flags.
    execFileSync(
      path.join(REPO, 'server/uni/node_modules/.bin/tsx'),
      ['src/scripts/grant-staff.ts', '--email', ops.email, '--role', 'registrar'],
      { cwd: path.join(REPO, 'server/uni'), env: { ...process.env, UNI_DATABASE_URL: DB_URL }, stdio: 'pipe', timeout: 60_000 },
    );
    const opsMe = (await (await ops.ctx.get('/v1/me')).json()) as { staffRoles: string[] };
    assert.ok(opsMe.staffRoles.includes('registrar'), 'staff grant did not take effect');

    // The legacy operator admin still answers on its own credential — the desktop
    // registrar surface reads it — but staff mutations below need the live session.
    const adminLogin = await (await uniCtx()).post('/v1/auth/login', {
      data: { email: 'admin@saintelms.local', password: process.env.DEMO_PASSWORD ?? 'harbor-lantern' },
    });
    assert.equal(adminLogin.status(), 200, 'legacy admin login failed');
    const adminToken = ((await adminLogin.json()) as { token: string }).token;
    const overview = await fetch(`${UNI_URL}/v1/admin/overview`, { headers: { authorization: `Bearer ${adminToken}` } });
    assert.equal(overview.status, 200, 'legacy admin overview failed');

    const staffGet = (url: string) => ops.ctx.get(url).then((r) => r.json());

    // ---- student A: register, verify, apply, get approved ----
    const alice = await registerVerifiedStudent(`alice-${Date.now()}@release.test`, 'Alice Release');
    await applyForProgramme(alice);
    const pending = (await (await alice.ctx.get('/v1/me')).json()) as { studentId: string | null; enrolment: { status: string } | null };
    assert.equal(pending.enrolment?.status, 'pending');
    assert.ok(pending.studentId);

    const students = (await staffGet(`/v1/admin/students?search=${encodeURIComponent(alice.email)}`)) as {
      rows: Array<{ profileId: string; email: string; enrolment: { id: string; version: number; status: string } | null; version: number }>;
    };
    const row = students.rows.find((r) => r.email === alice.email);
    assert.ok(row?.enrolment, 'applicant not visible to staff');
    const decided = await ops.ctx.post(`/v1/admin/enrolments/${row!.enrolment!.id}/decision`, {
      data: { schemaVersion: 2, expectedVersion: row!.enrolment!.version, action: 'approve', reason: 'Release drill admission.', cohortId: COHORT },
    });
    assert.equal(decided.status(), 200, `decision failed: ${await decided.text()}`);

    // Registrar correction on the record — the dashboard a staff member edits.
    const corrected = await ops.ctx.fetch(`/v1/admin/students/${row!.profileId}`, {
      method: 'PATCH',
      data: { schemaVersion: 2, expectedVersion: row!.version, preferredName: 'Alice (release drill)', reason: 'Record correction during release drill.' },
    });
    assert.equal(corrected.status(), 200, `record correction failed: ${await corrected.text()}`);
    const meAfter = (await (await alice.ctx.get('/v1/me')).json()) as { enrolment: { status: string; cohortId: string } | null };
    assert.equal(meAfter.enrolment?.status, 'approved');
    assert.equal(meAfter.enrolment?.cohortId, COHORT);

    // ---- engine: device sign-in binds the account to this device ----
    const aliceSession = await deviceSignIn(alice);
    const engineMe = await api(aliceSession, 'GET', '/api/auth/me');
    assert.equal(engineMe.status, 200);
    assert.equal((engineMe.body as { profile: { admission?: string } }).profile.admission, 'approved');

    // ---- course install: the released package crosses sync, signed ----
    const installed = await api(aliceSession, 'POST', '/api/sync/install/mechanics');
    assert.ok(installed.status === 200, `course install failed: ${JSON.stringify(installed.body)}`);
    const library = await api(aliceSession, 'GET', '/api/library');
    assert.equal(library.status, 200);

    // ---- ingest: a student's own note enters the vault as a source + job ----
    const note = Buffer.from(
      'Newton’s second law says net force equals mass times acceleration. My own summary: ' +
        'acceleration is what a net force buys you per unit of mass, which is why the same push ' +
        'moves a light cart more than a heavy one. Open question for me: does friction count as part of net force?',
      'utf8',
    ).toString('base64');
    const ingested = await api(aliceSession, 'POST', '/api/sources', {
      kind: 'note',
      title: 'My note on F = ma',
      mediaType: 'text/plain',
      data: note,
    });
    assert.equal(ingested.status, 201, `ingest failed: ${JSON.stringify(ingested.body)}`);
    const jobId = (ingested.body as { jobId: string }).jobId;
    const sourceId = (ingested.body as { source: { id: string } }).source.id;

    // ---- model-dependent steps: keeper compile, tutor turn, save, anchored explore ----
    // Only what genuinely needs a model is gated; everything file- or account-level below
    // (student B, account switching, export/restore, erasure) runs either way.
    const liveModel = await ollamaHas(LIVE_MODEL);
    test.info().annotations.push({
      type: 'model',
      description: liveModel
        ? `live model steps used ${LIVE_MODEL}: ran`
        : `live model steps SKIPPED — ${LIVE_MODEL} is not pulled locally (pull it, or set E2E_LIVE_MODEL to a pulled model)`,
    });

    let sharedPageId: string | null = null;
    if (liveModel) {
      // Point every role at the model this host actually has, through the real settings path.
      const settingsBody = (await api(aliceSession, 'GET', '/api/settings')).body as { providers: Array<{ id: string }> };
      const providerId = settingsBody.providers[0]?.id ?? 'ollama';
      // thinking is a real settings toggle: a model without a thinking mode makes Ollama
      // reject `think` outright — the drill turns it off, exactly as a student would.
      const patched = await api(aliceSession, 'PUT', '/api/settings', {
        roles: {
          tutor: { provider: providerId, model: LIVE_MODEL },
          brain: { provider: providerId, model: LIVE_MODEL },
          vision: { provider: providerId, model: LIVE_MODEL },
        },
        thinking: false,
      });
      assert.equal(patched.status, 200, `settings patch failed: ${JSON.stringify(patched.body)}`);

      // review: the keeper compiles the note into a proposal; only accept() writes pages.
      const compiled = await api(aliceSession, 'POST', `/api/sources/${jobId}/compile`);
      assert.equal(compiled.status, 200, `compile failed: ${JSON.stringify(compiled.body)}`);
      const proposalId = (compiled.body as { proposalId: string | null }).proposalId;
      if (!proposalId) {
        test.info().annotations.push({ type: 'note', description: `keeper (${LIVE_MODEL}) returned no proposal for the note — page-dependent steps skipped` });
      } else {
        const preview = await api(aliceSession, 'GET', `/api/proposals/${proposalId}`);
        assert.equal(preview.status, 200);
        const accepted = await api(aliceSession, 'POST', `/api/proposals/${proposalId}/accept`, {});
        assert.equal(accepted.status, 200, `accept failed: ${JSON.stringify(accepted.body)}`);
        const wiki = (await api(aliceSession, 'GET', '/api/wiki/pages')).body as { pages: Array<{ id: string; title: string }> };
        assert.ok(wiki.pages.length >= 1, 'accepted proposal produced no wiki page');
        sharedPageId = wiki.pages[0]!.id;
      }

      // query + save: a real tutor turn, then the answer frozen into the same pipeline.
      const conv = await api(aliceSession, 'POST', '/api/chat/sessions', { teacher: 'guide' });
      assert.equal(conv.status, 200);
      const chatSessionId = (conv.body as { sessionId: string }).sessionId;
      const turn = await chatTurn(aliceSession, chatSessionId, 'guide', 'Explain net force in two sentences, then ask me one question.');
      assert.ok(turn.text.length > 0);
      const saved = await api(aliceSession, 'POST', '/api/wiki/save', { sessionId: chatSessionId, title: 'Guide on net force' });
      assert.equal(saved.status, 201, `wiki save failed: ${JSON.stringify(saved.body)}`);
      const saveJob = (saved.body as { jobId: string }).jobId;
      const saveCompiled = await api(aliceSession, 'POST', `/api/sources/${saveJob}/compile`);
      assert.equal(saveCompiled.status, 200);
      const saveProposal = (saveCompiled.body as { proposalId: string | null }).proposalId;
      if (saveProposal) await api(aliceSession, 'POST', `/api/proposals/${saveProposal}/accept`, {});

      // explore from the personal wiki: the anchor catalogue is whatever the vault offers.
      const anchors = await api(aliceSession, 'GET', '/api/anchors');
      assert.equal(anchors.status, 200);
      const catalog = (anchors.body as { anchors: Array<{ pageId: string; pageRevision: string }> }).anchors;
      if (catalog.length > 0) {
        const anchor = catalog[0]!;
        const expl = await api(aliceSession, 'POST', '/api/chat/sessions', { teacher: 'philosopher' });
        const explSession = (expl.body as { sessionId: string }).sessionId;
        await chatTurn(aliceSession, explSession, 'philosopher', 'What does this page leave open for me?', {
          anchorPageId: anchor.pageId,
          anchorRevision: anchor.pageRevision,
        });
      } else {
        test.info().annotations.push({ type: 'note', description: 'anchor catalogue empty — no course-linked page survived compile' });
      }
    }

    // ---- student B: same pipeline end, deterministic — no model involved ----
    const bob = await registerVerifiedStudent(`bob-${Date.now()}@release.test`, 'Bob Release');
    await applyForProgramme(bob);
    const bobRow = ((await staffGet(`/v1/admin/students?search=${encodeURIComponent(bob.email)}`)) as { rows: Array<{ enrolment: { id: string; version: number } | null }> }).rows[0];
    assert.ok(bobRow?.enrolment);
    const bobDecision = await ops.ctx.post(`/v1/admin/enrolments/${bobRow.enrolment.id}/decision`, {
      data: { schemaVersion: 2, expectedVersion: bobRow.enrolment.version, action: 'approve', reason: 'Release drill admission.', cohortId: COHORT },
    });
    assert.equal(bobDecision.status(), 200, `bob decision failed: ${await bobDecision.text()}`);
    const bobSession = await deviceSignIn(bob);

    // account switching: both engine sessions stay live and resolve to their own profile.
    const meA = (await api(aliceSession, 'GET', '/api/auth/me')).body as { profile: { id: string } };
    const meB = (await api(bobSession, 'GET', '/api/auth/me')).body as { profile: { id: string } };
    assert.notEqual(meA.profile.id, meB.profile.id);

    // ---- publish/import: the payload is a page the keeper compiled, so this is model-bound ----
    if (sharedPageId) {
      const prepared = await api(aliceSession, 'POST', '/api/shares/prepare', { pageId: sharedPageId });
      assert.equal(prepared.status, 200, `prepare failed: ${JSON.stringify(prepared.body)}`);
      const request = (prepared.body as { request: unknown }).request;
      const published = await api(aliceSession, 'POST', '/api/shares/publish', request);
      assert.equal(published.status, 200, `publish failed: ${JSON.stringify(published.body)}`);
      const shareId = (published.body as { share: { id: string } }).share.id;

      // Bob's workspace has its own settings: the imported share compiles under them.
      const bobSettings = (await api(bobSession, 'GET', '/api/settings')).body as { providers: Array<{ id: string }> };
      const bobProviderId = bobSettings.providers[0]?.id ?? 'ollama';
      const bobRoles = await api(bobSession, 'PUT', '/api/settings', {
        roles: {
          tutor: { provider: bobProviderId, model: LIVE_MODEL },
          brain: { provider: bobProviderId, model: LIVE_MODEL },
          vision: { provider: bobProviderId, model: LIVE_MODEL },
        },
        thinking: false,
      });
      assert.equal(bobRoles.status, 200);

      const feed = await api(bobSession, 'GET', '/api/shares/feed');
      assert.equal(feed.status, 200);
      const feedBody = feed.body as { state: string; items: Array<{ id: string }> };
      assert.equal(feedBody.state, 'ok', `feed state: ${feedBody.state}`);
      const item = feedBody.items.find((i) => i.id === shareId);
      assert.ok(item, "Alice's share did not reach Bob's cohort feed");

      const imported = await api(bobSession, 'POST', `/api/shares/${shareId}/import`);
      assert.equal(imported.status, 200, `import failed: ${JSON.stringify(imported.body)}`);
      const bobProposal = (imported.body as { proposalId: string | null }).proposalId;
      if (bobProposal) {
        const acceptedImport = await api(bobSession, 'POST', `/api/proposals/${bobProposal}/accept`, {});
        assert.equal(acceptedImport.status, 200);
      }
    } else {
      test.info().annotations.push({ type: 'note', description: 'publish/import needs a page the keeper compiled — skipped without a local model' });
    }

    // ---- export/restore: Alice's vault crosses into Bob's workspace intact ----
    // The archive always carries the ingested note's record and bytes; when the model ran
    // it carries the compiled pages as well.
    const exported = await api(aliceSession, 'POST', '/api/vault/export', {});
    assert.equal(exported.status, 200);
    const archive = exported.body;
    const previewed = await api(bobSession, 'POST', '/api/vault/import/preview', { archive });
    assert.equal(previewed.status, 200);
    assert.ok(['ready', 'conflicts'].includes((previewed.body as { state: string }).state));
    const restored = await api(bobSession, 'POST', '/api/vault/import', { archive, overwritePageIds: [] });
    assert.equal(restored.status, 200, `restore failed: ${JSON.stringify(restored.body)}`);
    assert.equal((restored.body as { committed: boolean }).committed, true);

    await api(bobSession, 'POST', '/api/auth/logout');

    // ---- source erasure: the student's own delete, on a note only this drill uses ----
    const eraseNote = Buffer.from('Release drill erasure note: a fact I want gone — the lab is on Thursday.', 'utf8').toString('base64');
    const eraseIngested = await api(aliceSession, 'POST', '/api/sources', {
      kind: 'note',
      title: 'Erase-me note (release drill)',
      mediaType: 'text/plain',
      data: eraseNote,
    });
    assert.equal(eraseIngested.status, 201, `erasure-note ingest failed: ${JSON.stringify(eraseIngested.body)}`);
    const eraseSource = (eraseIngested.body as { source: { id: string; revision: string } }).source;

    // Nothing cites it yet: dependents are empty, the erase answers with what it orphaned.
    const noDependents = await api(aliceSession, 'GET', `/api/sources/${eraseSource.id}/dependents`);
    assert.equal(noDependents.status, 200);
    assert.equal((noDependents.body as { pages: unknown[] }).pages.length, 0);
    const erased = await api(aliceSession, 'POST', `/api/sources/${eraseSource.id}/erase`, { expectedRevision: eraseSource.revision });
    assert.equal(erased.status, 200, `erase failed: ${JSON.stringify(erased.body)}`);
    assert.equal((erased.body as { erased: boolean }).erased, true);
    assert.equal((erased.body as { dependents: unknown[] }).dependents.length, 0);
    // The record is honestly gone — a read and a second erase both say so.
    assert.equal((await api(aliceSession, 'GET', `/api/sources/${eraseSource.id}`)).status, 404);
    assert.equal((await api(aliceSession, 'POST', `/api/sources/${eraseSource.id}/erase`, {})).status, 404);
    // And the delete is recorded, not hidden: a tombstone travels with the portable vault.
    const afterErase = await api(aliceSession, 'POST', '/api/vault/export', {});
    assert.equal(afterErase.status, 200);
    const tombstone = (afterErase.body as { files: Array<{ path: string; content: string }> }).files
      .find((f) => f.path === `.meta/tombstones/${eraseSource.id}.json`);
    assert.ok(tombstone, 'the erasure tombstone travels with the vault export');
    const marker = JSON.parse(tombstone!.content) as { id: string; erasedAt?: string };
    assert.equal(marker.id, eraseSource.id);
    assert.ok(marker.erasedAt, 'the tombstone records when the source was erased');

    // Erasure with dependents: a compiled page that cited the F=ma note keeps the citation
    // and reads it honestly — missing from the catalogue, withheld from answers.
    if (sharedPageId) {
      const dependents = await api(aliceSession, 'GET', `/api/sources/${sourceId}/dependents`);
      assert.equal(dependents.status, 200);
      const dependentPages = (dependents.body as { pages: Array<{ id: string }> }).pages;
      if (dependentPages.length > 0) {
        const record = await api(aliceSession, 'GET', `/api/sources/${sourceId}`);
        assert.equal(record.status, 200);
        const revision = (record.body as { record: { revision: string } }).record.revision;
        const erasedNote = await api(aliceSession, 'POST', `/api/sources/${sourceId}/erase`, { expectedRevision: revision });
        assert.equal(erasedNote.status, 200, `erase failed: ${JSON.stringify(erasedNote.body)}`);
        assert.equal((erasedNote.body as { erased: boolean }).erased, true);
        assert.ok((erasedNote.body as { dependents: unknown[] }).dependents.length >= 1, 'the erase answer names the orphaned pages');

        const view = await api(aliceSession, 'GET', `/api/wiki/pages/${dependentPages[0]!.id}`);
        assert.equal(view.status, 200);
        const page = view.body as {
          missingSourceIds: string[];
          claims: Array<{ assertable: boolean; reason?: string; citations: Array<{ sourceId: string }> }>;
        };
        assert.ok(page.missingSourceIds.includes(sourceId), 'an erased source is named as missing, not hidden');
        for (const claim of page.claims.filter((c) => c.citations.some((citation) => citation.sourceId === sourceId))) {
          assert.equal(claim.assertable, false, 'a claim resting on an erased source is withheld');
          assert.equal(claim.reason, 'unresolved_source');
        }
      } else {
        test.info().annotations.push({ type: 'note', description: 'no compiled page cites the ingested note — dependent-erasure check skipped' });
      }
    }

    // ---- offline unlock: the entitlement fetched at device sign-in opens the vault offline ----
    const offline = await fetch(`${ENGINE_URL}/api/auth/offline-login`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ profileId: aliceSession.profileId }),
    });
    const offlineSession = (await offline.json().catch(() => null)) as { mode: string; token: string } | null;
    assert.ok(offline.status === 200 && offlineSession, `offline unlock failed: ${offline.status}`);
    assert.equal(offlineSession.mode, 'offline');
    const offlineVault = await api({ token: offlineSession.token, profileId: aliceSession.profileId }, 'POST', '/api/vault/export', {});
    assert.equal(offlineVault.status, 200, 'an expired-or-offline session still exports its own vault');

    await api(aliceSession, 'POST', '/api/auth/logout');
    const afterLogout = await api(aliceSession, 'GET', '/api/auth/me');
    assert.equal(afterLogout.status, 401, 'a revoked engine session must not resolve');
  });
});

test.describe('device confirmation page ergonomics', () => {
  test('works at phone width and by keyboard alone', async ({ page }) => {
    await needsStack();
    await page.setViewportSize({ width: 375, height: 667 });
    await page.goto(`${UNI_URL}/device?user_code=WXYZ-1234`);
    await expect(page.getByRole('heading', { name: /confirm this device/i })).toBeVisible();
    // Nothing may spill off the right edge at a phone viewport.
    const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
    expect(overflow).toBeLessThanOrEqual(1);

    // Keyboard-only: the code input is reachable and both decision buttons take focus in
    // DOM order (Deny is first; Approve is the primary action, not the first tab stop).
    await page.locator('#user-code').focus();
    await expect(page.locator('#user-code')).toBeFocused();
    await page.keyboard.press('Tab');
    await expect(page.getByRole('button', { name: /^deny$/i })).toBeFocused();
    await page.keyboard.press('Tab');
    const approve = page.getByRole('button', { name: /^approve$/i });
    await expect(approve).toBeFocused();
    // Signed out, a keyboard-submitted approve must still land on an honest refusal.
    await page.keyboard.press('Enter');
    await expect(page.locator('#status')).not.toHaveText('', { timeout: 10_000 });
    await expect(page.locator('#status')).not.toContainText(/approved\./i);
  });
});

test.describe('account mail on another device', () => {
  test('a magic link opened in a fresh browser context signs that device in — GET never consumes it', async () => {
    const status = await needsStack();
    if (!(await mailpitUp())) test.skip(true, `Mailpit is not reachable at ${MAILPIT_URL}.`);
    const carol = await registerVerifiedStudent(`carol-${Date.now()}@release.test`, 'Carol Release');

    // A second context is a second device: no shared cookies, no shared storage.
    const otherDevice = await uniCtx();
    const before = Date.now();
    const requested = await otherDevice.post('/v1/auth/sign-in/magic-link', { data: { email: carol.email } });
    assert.ok(requested.ok(), `magic link request failed: ${requested.status()} ${await requested.text()}`);

    const link = await latestLinkTo(carol.email, before);
    // The emailed URL is the confirmation page: fetching it must not consume the token.
    const confirmPage = await otherDevice.fetch(link);
    assert.ok(confirmPage.ok(), `confirmation page answered ${confirmPage.status()}`);
    const html = await confirmPage.text();
    assert.match(html, /confirm|sign in/i);
    assert.ok(!html.includes('magic-link/verify'), 'the page itself must not carry the consuming URL');

    // The student's own click POSTs the token — that is what consumes it. The context's
    // Origin header is the same-origin proof the endpoint demands.
    const params = new URLSearchParams(new URL(link).search);
    const confirmed = await otherDevice.post('/v1/auth/magic-link/confirm', {
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      data: params.toString(),
      maxRedirects: 0,
    });
    assert.ok([200, 302].includes(confirmed.status()), `confirm answered ${confirmed.status()}: ${await confirmed.text()}`);

    const session = await otherDevice.get('/v1/auth/get-session');
    const body = (await session.json()) as { user?: { email: string } } | null;
    assert.equal(body?.user?.email, carol.email, 'the other device holds a real session now');
    await carol.ctx.dispose();
    await otherDevice.dispose();
    expect(status.ok).toBe(true);
  });
});
