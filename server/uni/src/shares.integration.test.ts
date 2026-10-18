// Authenticated cohort sharing: publish authority, isolation, quotas, idempotency,
// withdrawal and staff moderation against a disposable database.
// Run only inside `pnpm --filter @sef/uni-server db:test:integration`.

import assert from 'node:assert/strict';
import { generateKeyPairSync, randomUUID } from 'node:crypto';
import { mkdtemp } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { Hono } from 'hono';
import test from 'node:test';
import { CONTRACT_VERSION, DEMO_ADMIN, type AdminSharePage, type Enrolment, type PublishedShare, type ShareFeedPage } from '@sef/shared';
import { issueToken } from './auth';
import { demoProfileId, seedDemoAdmission } from './demo-admission';
import { AccountStore } from './store/accounts';
import type { UniDeps } from './deps';
import { publishShare, ShareError } from './shares';
import { meRoutes } from './routes/me';
import { adminRoutes } from './routes/admin';
import { shareRoutes } from './routes/shares';
import { staffRoutes } from './routes/staff';
import { studentRoutes } from './routes/student';
import { grantStaffMembership } from './staff';
import { AuditLog } from './store/audit';
import { DispersalStore } from './store/dispersal';
import { ReleaseStore } from './store/releases';
import { ShareStore } from './store/shares';
import {
  signUpVerified,
  testOptions,
  withAuthSchema,
  type AuthContext,
} from './testing/auth-fixture';

const PROGRAMME_ID = 'bsc-test';
const COHORT = 'bsc-pma-2026';
const OTHER_COHORT = 'bsc-pma-2025';

let cachedDeps: Promise<{ keys: UniDeps['keys']; releases: ReleaseStore; tmp: string }> | null = null;
function staticDeps() {
  cachedDeps ??= (async () => {
    const tmp = await mkdtemp(path.join(os.tmpdir(), 'sef-shares-'));
    const releases = new ReleaseStore(undefined, tmp);
    await releases.load();
    const { privateKey, publicKey } = generateKeyPairSync('ed25519');
    return {
      keys: { privateKey, publicKeyPem: publicKey.export({ type: 'spki', format: 'pem' }).toString() },
      releases,
      tmp,
    };
  })();
  return cachedDeps;
}

function deps(context: AuthContext, extra: { keys: UniDeps['keys']; releases: ReleaseStore; tmp: string }, shares: ShareStore): UniDeps {
  return {
    pool: context.pool,
    accountAuth: context.auth,
    releases: extra.releases,
    keys: extra.keys,
    programme: {
      programme: {
        schemaVersion: CONTRACT_VERSION,
        id: PROGRAMME_ID,
        name: 'BSc Test',
        institution: 'Saint Elms',
        manifestVersion: '2026.1',
        sourceDocuments: ['programme.yaml'],
        rows: [],
        optionGroups: [],
      },
      semesters: [],
      declaredCounts: { total: 0, bySemester: {}, byStatus: {} },
      derivedCounts: { rows: 0, bySemester: {}, byStatus: {}, degreeRows: 0, degreeCredits: { min: 0, max: 0 } },
      diagnostics: [],
      resolveContentDir: () => null,
    },
    availability: {},
    courseware: { programmeId: PROGRAMME_ID, programmeName: 'BSc Test', courses: new Map() } as never,
    shares,
    accounts: null as never,
    audit: new AuditLog(extra.tmp),
    dispersal: new DispersalStore(extra.tmp),
  };
}

function mount(app: Hono, deps: UniDeps) {
  // Production order (app.ts): adminRoutes mounts first — its per-route guard
  // claims admin paths, and session requests fall through to staffRoutes.
  app.route('/v1/admin', adminRoutes(deps));
  app.route('/v1/admin', staffRoutes(deps));
  app.route('/v1', meRoutes(deps));
  app.route('/v1', shareRoutes(deps));
  app.route('/v1', studentRoutes(deps));
}

const authed = (context: AuthContext, path: string, cookie: string, init: RequestInit = {}) =>
  context.app.request(`${context.origin}${path}`, { ...init, headers: { cookie, ...(init.headers ?? {}) } });

const staffToken = async (context: AuthContext, email: string, role: 'owner' | 'registrar' = 'owner') => {
  const cookie = await signUpVerified(context, email, `Staff ${email}`);
  const user = await context.pool.query<{ id: string }>('SELECT id FROM "user" WHERE email = $1', [email]);
  await grantStaffMembership(context.pool, { email, role, actor: 'bootstrap' });
  return { cookie, userId: user.rows[0]!.id };
};

const apply = (context: AuthContext, cookie: string) =>
  authed(context, '/v1/applications', cookie, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ schemaVersion: CONTRACT_VERSION, programmeId: PROGRAMME_ID }),
  });

const decide = (context: AuthContext, staffCookie: string, enrolmentId: string, body: Record<string, unknown>) =>
  authed(context, `/v1/admin/enrolments/${enrolmentId}/decision`, staffCookie, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ schemaVersion: CONTRACT_VERSION, ...body }),
  });

/** Signs a student up, verifies them, applies and gets them approved into a cohort. */
const admit = async (context: AuthContext, email: string, name: string, cohort: string, staffCookie: string) => {
  const cookie = await signUpVerified(context, email, name);
  const applied = await apply(context, cookie);
  assert.equal(applied.status, 201);
  const enrolment = (await applied.json()) as Enrolment;
  const approved = await decide(context, staffCookie, enrolment.id, {
    action: 'approve',
    reason: 'admitted',
    expectedVersion: enrolment.version,
    cohortId: cohort,
  });
  assert.equal(approved.status, 200);
  return { cookie, enrolment };
};

const shareBody = (key: string, payload: Record<string, unknown> = {}) => ({
  schemaVersion: CONTRACT_VERSION,
  programmeId: PROGRAMME_ID,
  idempotencyKey: key,
  payload: { title: 'A study note', markdown: 'Something I worked out.', citations: [], attachments: [], ...payload },
});

const publish = (context: AuthContext, cookie: string, body: Record<string, unknown>) =>
  authed(context, '/v1/shares', cookie, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });

const feed = async (context: AuthContext, cookie: string, query = '') =>
  (await (await authed(context, `/v1/shares${query}`, cookie)).json()) as ShareFeedPage;

const profileIdFor = async (context: AuthContext, email: string) => {
  const rows = await context.pool.query<{ id: string }>(
    'SELECT p.id FROM student_profiles p JOIN "user" u ON u.id = p.account_user_id WHERE u.email = $1',
    [email],
  );
  return rows.rows[0]!.id;
};

test('shares derive authority from the enrolment and reject client-spoofed fields', testOptions, async () => {
  await withAuthSchema(async (context) => {
    const extra = await staticDeps();
    mount(context.app, deps(context, extra, new ShareStore(extra.tmp)));
    const { cookie: ownerCookie } = await staffToken(context, 'owner@example.test');
    const { cookie } = await admit(context, 'ada@example.test', 'Ada Lovelace', COHORT, ownerCookie);

    const anonymous = await context.app.request(`${context.origin}/v1/shares`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(shareBody('anon')),
    });
    assert.equal(anonymous.status, 401);

    for (const spoof of [
      { ...shareBody('s1'), senderId: 'somebody-else' },
      { ...shareBody('s2'), cohortId: OTHER_COHORT },
      { ...shareBody('s3'), fromStudent: 'Ghost Writer' },
      { ...shareBody('s4'), programmeId: 'not-my-programme' },
    ]) {
      const res = await publish(context, cookie, spoof);
      assert.ok([400, 403].includes(res.status), `spoof rejected with ${res.status}`);
    }
    const ok = await publish(context, cookie, shareBody('first-share'));
    assert.equal(ok.status, 201);
    const share = (await ok.json()) as PublishedShare;
    assert.equal(share.schemaVersion, CONTRACT_VERSION);
    assert.equal(share.senderId, await profileIdFor(context, 'ada@example.test'));
    assert.equal(share.senderName, 'Ada Lovelace');
    assert.equal(share.programmeId, PROGRAMME_ID);
    assert.equal(share.cohortId, COHORT);
    assert.equal(share.state, 'published');
    assert.equal(share.revision, '1');
  });
});

test('programme mismatches and oversized content are refused before publish', testOptions, async () => {
  await withAuthSchema(async (context) => {
    const extra = await staticDeps();
    mount(context.app, deps(context, extra, new ShareStore(extra.tmp)));
    const { cookie: ownerCookie } = await staffToken(context, 'owner@example.test');
    const { cookie } = await admit(context, 'grace@example.test', 'Grace', COHORT, ownerCookie);

    const mismatch = await publish(context, cookie, { ...shareBody('m1'), programmeId: 'other-programme' });
    assert.equal(mismatch.status, 403);
    assert.equal(((await mismatch.json()) as { error: string }).error, 'programme_mismatch');

    // 4,000 three-byte chars stay under the schema's 10,000-char cap but break the byte limit.
    const tooBig = await publish(context, cookie, shareBody('m2', { markdown: '☃'.repeat(4000) }));
    assert.equal(tooBig.status, 413);

    const fatAttachment = await publish(context, cookie, shareBody('m3', {
      attachments: [{ id: 'att-1', name: 'scan.pdf', mediaType: 'application/pdf', sha256: 'a'.repeat(64), bytes: 30 * 1024 * 1024 }],
    }));
    assert.equal(fatAttachment.status, 400);
    assert.equal(((await fatAttachment.json()) as { error: string }).error, 'attachment_too_large');

    const tooManyAttachments = await publish(context, cookie, shareBody('m4', {
      attachments: Array.from({ length: 9 }, (_, i) => ({
        id: `att-${i}`, name: `f${i}.txt`, mediaType: 'text/plain', sha256: 'b'.repeat(64), bytes: 10,
      })),
    }));
    assert.equal(tooManyAttachments.status, 400);
  });
});

test('cohorts cannot see each other\'s shares and suspended students are locked out', testOptions, async () => {
  await withAuthSchema(async (context) => {
    const extra = await staticDeps();
    mount(context.app, deps(context, extra, new ShareStore(extra.tmp)));
    const { cookie: ownerCookie } = await staffToken(context, 'owner@example.test');
    const a = await admit(context, 'a@example.test', 'A Student', COHORT, ownerCookie);
    const b = await admit(context, 'b@example.test', 'B Student', OTHER_COHORT, ownerCookie);

    const posted = await publish(context, a.cookie, shareBody('cohort-a-share'));
    assert.equal(posted.status, 201);
    const share = (await posted.json()) as PublishedShare;

    const aFeed = await feed(context, a.cookie);
    assert.equal(aFeed.items.length, 1);
    assert.equal(aFeed.items[0]!.id, share.id);

    const bFeed = await feed(context, b.cookie);
    assert.equal(bFeed.items.length, 0);
    const bDetail = await authed(context, `/v1/shares/${share.id}`, b.cookie);
    assert.equal(bDetail.status, 404, 'cross-cohort detail is indistinguishable from missing');
    const bWithdraw = await authed(context, `/v1/shares/${share.id}/withdraw`, b.cookie, { method: 'POST' });
    assert.equal(bWithdraw.status, 404);

    // Suspension at either level closes the whole surface for the account.
    await context.pool.query(`UPDATE student_profiles SET status = 'suspended' WHERE legal_name = 'A Student'`);
    assert.equal((await publish(context, a.cookie, shareBody('suspended-1'))).status, 403);
    assert.equal((await authed(context, '/v1/shares', a.cookie)).status, 403);
    await context.pool.query(`UPDATE student_profiles SET status = 'active' WHERE legal_name = 'A Student'`);
    await context.pool.query(`UPDATE enrolments SET status = 'suspended' WHERE student_profile_id = $1`, [await profileIdFor(context, 'a@example.test')]);
    assert.equal((await authed(context, '/v1/shares', a.cookie)).status, 403);
    await context.pool.query(`UPDATE enrolments SET status = 'approved' WHERE student_profile_id = $1`, [await profileIdFor(context, 'a@example.test')]);
    assert.equal((await authed(context, '/v1/shares', a.cookie)).status, 200);
  });
});

test('duplicate publishes replay one record and the daily quota cannot be bypassed', testOptions, async () => {
  await withAuthSchema(async (context) => {
    const extra = await staticDeps();
    mount(context.app, deps(context, extra, new ShareStore(extra.tmp)));
    const { cookie: ownerCookie } = await staffToken(context, 'owner@example.test');
    const { cookie } = await admit(context, 'ida@example.test', 'Ida', COHORT, ownerCookie);

    const first = await publish(context, cookie, shareBody('dup-key'));
    assert.equal(first.status, 201);
    const share = (await first.json()) as PublishedShare;
    const replay = await publish(context, cookie, shareBody('dup-key'));
    assert.equal(replay.status, 200);
    assert.equal(((await replay.json()) as PublishedShare).id, share.id);

    const conflict = await publish(context, cookie, shareBody('dup-key', { title: 'A different payload' }));
    assert.equal(conflict.status, 409);
    assert.equal(((await conflict.json()) as { error: string }).error, 'idempotency_conflict');
    assert.equal((await feed(context, cookie)).items.length, 1);

    // Route-level quota: 'dup-key' already consumed one of ten slots; nine more
    // land and the next is refused. The replay/conflict above never inserted.
    for (let i = 0; i < 9; i += 1) {
      assert.equal((await publish(context, cookie, shareBody(`quota-${i}`))).status, 201);
    }
    const overQuota = await publish(context, cookie, shareBody('quota-eleven'));
    assert.equal(overQuota.status, 429);
    assert.equal(((await overQuota.json()) as { error: string }).error, 'quota_exceeded');

    // Store-level quota holds under a concurrent race: exactly one write wins.
    // A fresh profile starts at zero so the assertion is not polluted by the 11 above.
    await admit(context, 'racer@example.test', 'Racer', COHORT, ownerCookie);
    const base = {
      profileId: await profileIdFor(context, 'racer@example.test'),
      senderName: 'Ida',
      programmeCode: PROGRAMME_ID,
      cohortCode: COHORT,
      payload: { title: 'r', markdown: 'r', citations: [], attachments: [] },
      payloadBytes: 40,
      perDay: 1,
      actor: 'test',
    };
    const results = await Promise.allSettled([
      publishShare(context.pool, { ...base, idempotencyKey: 'race-1' }),
      publishShare(context.pool, { ...base, idempotencyKey: 'race-2' }),
    ]);
    assert.equal(results.filter((r) => r.status === 'fulfilled').length, 1);
    assert.ok(
      results.some((r) => r.status === 'rejected' && r.reason instanceof ShareError && r.reason.code === 'quota_exceeded'),
    );
  });
});

test('the feed paginates by keyset cursor without gaps or repeats', testOptions, async () => {
  await withAuthSchema(async (context) => {
    const extra = await staticDeps();
    mount(context.app, deps(context, extra, new ShareStore(extra.tmp)));
    const { cookie: ownerCookie } = await staffToken(context, 'owner@example.test');
    const { cookie } = await admit(context, 'pam@example.test', 'Pam', COHORT, ownerCookie);

    for (let i = 0; i < 3; i += 1) {
      assert.equal((await publish(context, cookie, shareBody(`page-${i}`))).status, 201);
    }

    const page1 = await feed(context, cookie, '?limit=2');
    assert.equal(page1.items.length, 2);
    assert.ok(page1.nextCursor);
    const page2 = await feed(context, cookie, `?limit=2&cursor=${encodeURIComponent(page1.nextCursor!)}`);
    assert.equal(page2.items.length, 1);
    assert.equal(page2.nextCursor, null);
    const seen = new Set([...page1.items, ...page2.items].map((item) => item.id));
    assert.equal(seen.size, 3);

    const bad = await authed(context, '/v1/shares?cursor=%%%garbage%%%', cookie);
    assert.equal(bad.status, 400);
    assert.equal(((await bad.json()) as { error: string }).error, 'invalid_cursor');
  });
});

test('withdrawal stops peer downloads but keeps the author\'s copy inspectable', testOptions, async () => {
  await withAuthSchema(async (context) => {
    const extra = await staticDeps();
    mount(context.app, deps(context, extra, new ShareStore(extra.tmp)));
    const { cookie: ownerCookie } = await staffToken(context, 'owner@example.test');
    const author = await admit(context, 'wren@example.test', 'Wren', COHORT, ownerCookie);
    const peer = await admit(context, 'peer@example.test', 'Peer', COHORT, ownerCookie);

    const posted = await publish(context, author.cookie, shareBody('withdraw-me'));
    const share = (await posted.json()) as PublishedShare;
    assert.equal((await feed(context, peer.cookie)).items.length, 1);

    assert.equal((await authed(context, `/v1/shares/${share.id}/withdraw`, peer.cookie, { method: 'POST' })).status, 404);

    const withdrawn = await authed(context, `/v1/shares/${share.id}/withdraw`, author.cookie, { method: 'POST' });
    assert.equal(withdrawn.status, 200);
    const body = (await withdrawn.json()) as PublishedShare;
    assert.equal(body.state, 'withdrawn');
    assert.equal(body.revision, '2');

    assert.equal((await feed(context, peer.cookie)).items.length, 0);
    assert.equal((await authed(context, `/v1/shares/${share.id}`, peer.cookie)).status, 404);
    const ownCopy = await authed(context, `/v1/shares/${share.id}`, author.cookie);
    assert.equal(ownCopy.status, 200);
    assert.equal(((await ownCopy.json()) as PublishedShare).state, 'withdrawn');

    // Re-withdrawing is idempotent and journals exactly one event.
    assert.equal((await authed(context, `/v1/shares/${share.id}/withdraw`, author.cookie, { method: 'POST' })).status, 200);
    const events = await context.pool.query<{ action: string }>(
      'SELECT action FROM share_moderation_events WHERE share_id = $1',
      [share.id],
    );
    assert.deepEqual(events.rows.map((r) => r.action), ['withdraw']);
  });
});

test('staff removal is audited, scoped to published shares, and closed to students', testOptions, async () => {
  await withAuthSchema(async (context) => {
    const extra = await staticDeps();
    mount(context.app, deps(context, extra, new ShareStore(extra.tmp)));
    const { cookie: ownerCookie } = await staffToken(context, 'owner@example.test');
    const { cookie } = await admit(context, 'mia@example.test', 'Mia', COHORT, ownerCookie);

    const posted = await publish(context, cookie, shareBody('moderate-me'));
    const share = (await posted.json()) as PublishedShare;

    assert.equal((await authed(context, '/v1/admin/published-shares', cookie)).status, 403);
    assert.equal((await authed(context, `/v1/admin/published-shares/${share.id}/remove`, cookie, { method: 'POST' })).status, 403);

    const listed = (await (await authed(context, '/v1/admin/published-shares', ownerCookie)).json()) as AdminSharePage;
    assert.equal(listed.items.length, 1);
    assert.equal(listed.items[0]!.id, share.id);
    assert.equal(listed.items[0]!.lastModeration, null);

    const removed = await authed(context, `/v1/admin/published-shares/${share.id}/remove`, ownerCookie, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ note: 'Off-topic material' }),
    });
    assert.equal(removed.status, 200);
    assert.equal(((await removed.json()) as PublishedShare).state, 'withdrawn');

    const detail = (await (await authed(context, `/v1/admin/published-shares/${share.id}`, ownerCookie)).json()) as {
      events: { action: string; actorSubject: string; note: string | null }[];
      lastModeration: { action: string } | null;
    };
    assert.equal(detail.events.length, 1);
    assert.equal(detail.events[0]!.action, 'remove');
    assert.equal(detail.events[0]!.note, 'Off-topic material');
    assert.equal(detail.lastModeration!.action, 'remove');

    assert.equal((await feed(context, cookie)).items.length, 0);
    assert.equal((await authed(context, `/v1/shares/${share.id}`, cookie)).status, 200, 'author keeps their own record');

    const again = await authed(context, `/v1/admin/published-shares/${share.id}/remove`, ownerCookie, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({}),
    });
    assert.equal(again.status, 409);
    assert.equal(((await again.json()) as { error: string }).error, 'not_published');
    const missing = await authed(context, `/v1/admin/published-shares/${randomUUID()}/remove`, ownerCookie, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({}),
    });
    assert.equal(missing.status, 404);

    const withdrawnOnly = (await (await authed(context, '/v1/admin/published-shares?state=withdrawn', ownerCookie)).json()) as AdminSharePage;
    assert.equal(withdrawnOnly.items.length, 1);
    const publishedOnly = (await (await authed(context, '/v1/admin/published-shares?state=published', ownerCookie)).json()) as AdminSharePage;
    assert.equal(publishedOnly.items.length, 0);

    const audit = await context.pool.query<{ event_type: string }>(
      `SELECT event_type FROM audit_events WHERE subject_id = $1 ORDER BY occurred_at`,
      [share.id],
    );
    assert.deepEqual(audit.rows.map((r) => r.event_type), ['share.published', 'share.removed']);
  });
});

test('legacy relay shares stay quarantined and are never attributed to accounts', testOptions, async () => {
  await withAuthSchema(async (context) => {
    const extra = await staticDeps();
    const legacy = new ShareStore(extra.tmp);
    await legacy.add({
      title: 'Old relay share',
      markdown: 'Posted before admission existed.',
      cohortId: COHORT,
      fromStudent: 'Ghost Author',
    });
    mount(context.app, deps(context, extra, legacy));
    const { cookie: ownerCookie } = await staffToken(context, 'owner@example.test');
    const { cookie } = await admit(context, 'nina@example.test', 'Nina', COHORT, ownerCookie);

    const quarantine = (await (await authed(context, '/v1/admin/legacy-shares', ownerCookie)).json()) as {
      quarantined: boolean;
      items: { fromStudent: string; title: string }[];
    };
    assert.equal(quarantine.quarantined, true);
    assert.equal(quarantine.items.length, 1);
    assert.equal(quarantine.items[0]!.fromStudent, 'Ghost Author');

    // The authenticated feed never surfaces quarantined items, even same-cohort.
    assert.equal((await feed(context, cookie)).items.length, 0);
    assert.equal((await publish(context, cookie, shareBody('n1'))).status, 201);
    const afterPublish = await feed(context, cookie);
    assert.equal(afterPublish.items.length, 1);
    assert.notEqual(afterPublish.items[0]!.senderName, 'Ghost Author');
  });
});

// SEED_DEMO personas sign in through the legacy password path; their own student tokens
// resolve to seeded, unlinked admission rows so Peers works for them on a demo stack.
const bearerRequest = (context: AuthContext, path: string, token: string, init: RequestInit = {}) =>
  context.app.request(`${context.origin}${path}`, { ...init, headers: { authorization: `Bearer ${token}`, ...(init.headers ?? {}) } });

const demoPublish = (context: AuthContext, token: string, programmeId: string, key: string) =>
  bearerRequest(context, '/v1/shares', token, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ ...shareBody(key), programmeId }),
  });

async function demoAccounts(tmp: string) {
  const accounts = new AccountStore(await mkdtemp(path.join(tmp, 'demo-accounts-')), { seedDemo: true });
  await accounts.load();
  return accounts;
}

test('demo personas publish and read their cohort feed with legacy tokens when SEED_DEMO is on', testOptions, async () => {
  await withAuthSchema(async (context) => {
    const extra = await staticDeps();
    const accounts = await demoAccounts(extra.tmp);
    mount(context.app, { ...deps(context, extra, new ShareStore(extra.tmp)), accounts, seedDemo: true });
    await seedDemoAdmission(context.pool);
    await seedDemoAdmission(context.pool); // idempotent across reboots
    const counts = await context.pool.query<{ n: string }>(
      `SELECT count(*)::text AS n FROM enrolments WHERE decision_actor_subject = 'demo-seed' AND status = 'approved'`,
    );
    assert.equal(counts.rows[0]!.n, '3');

    const ananya = issueToken(accounts.get('ananya')!, extra.keys).token;
    const brinda = issueToken(accounts.get('brinda')!, extra.keys).token;

    // The engine stamps legacy profiles with programmeId = cohortId.
    const posted = await demoPublish(context, ananya, 'bsc-pma-2026', 'ananya-1');
    assert.equal(posted.status, 201);
    const share = (await posted.json()) as PublishedShare;
    assert.equal(share.senderId, demoProfileId('ananya'));
    assert.equal(share.senderName, 'Ananya');
    assert.equal(share.cohortId, 'bsc-pma-2026');

    const spoofed = await demoPublish(context, ananya, 'bsc-pma-2025', 'ananya-spoof');
    assert.equal(spoofed.status, 403, 'a demo token cannot publish into another persona\'s programme');

    const brindaPosted = await demoPublish(context, brinda, 'bsc-pma-2025', 'brinda-1');
    assert.equal(brindaPosted.status, 201);
    const brindaShare = (await brindaPosted.json()) as PublishedShare;
    assert.equal(brindaShare.senderId, demoProfileId('brinda'));

    // The seeded personas sit in three different cohorts, so cohort scoping keeps them apart.
    const ananyaFeed = (await (await bearerRequest(context, '/v1/shares', ananya)).json()) as ShareFeedPage;
    assert.deepEqual(ananyaFeed.items.map((item) => item.id), [share.id]);
    const brindaFeed = (await (await bearerRequest(context, '/v1/shares', brinda)).json()) as ShareFeedPage;
    assert.deepEqual(brindaFeed.items.map((item) => item.id), [brindaShare.id]);
    assert.equal((await bearerRequest(context, `/v1/shares/${brindaShare.id}`, ananya)).status, 404);
    assert.equal((await bearerRequest(context, `/v1/shares/${brindaShare.id}/withdraw`, ananya, { method: 'POST' })).status, 404);

    // A real admitted classmate in Ananya's cohort sees her share through the unchanged cohort rule.
    const { cookie: ownerCookie } = await staffToken(context, 'owner@example.test');
    const classmate = await admit(context, 'classmate@example.test', 'Classmate', 'bsc-pma-2026', ownerCookie);
    assert.deepEqual((await feed(context, classmate.cookie)).items.map((item) => item.id), [share.id]);

    assert.equal((await bearerRequest(context, `/v1/shares/${share.id}/withdraw`, ananya, { method: 'POST' })).status, 200);
  });
});

test('legacy tokens outside the demo personas, or with SEED_DEMO off, stay refused', testOptions, async () => {
  await withAuthSchema(async (context) => {
    const extra = await staticDeps();
    const accounts = await demoAccounts(extra.tmp);
    await seedDemoAdmission(context.pool);
    const base = { ...deps(context, extra, new ShareStore(extra.tmp)), accounts };
    mount(context.app, { ...base, seedDemo: true });

    const now = new Date().toISOString();
    const unknown = issueToken(
      { id: 'zed', email: 'zed@saintelms.local', name: 'Zed', role: 'student', cohortId: 'bsc-pma-2026', createdAt: now },
      extra.keys,
    ).token;
    const admin = issueToken({ ...DEMO_ADMIN, role: 'admin', createdAt: now }, extra.keys).token;
    const wrongEmail = issueToken({ ...accounts.get('ananya')!, email: 'someone@else.test' }, extra.keys).token;
    const adminAsPersona = issueToken({ ...accounts.get('ananya')!, role: 'admin' }, extra.keys).token;
    for (const [label, token] of [['unknown subject', unknown], ['legacy admin', admin], ['mismatched email', wrongEmail], ['admin-role persona', adminAsPersona]] as const) {
      assert.equal((await bearerRequest(context, '/v1/shares', token)).status, 401, `${label}: feed refused`);
      assert.equal((await demoPublish(context, token, 'bsc-pma-2026', 'nope')).status, 401, `${label}: publish refused`);
    }

    const ananya = issueToken(accounts.get('ananya')!, extra.keys).token;
    // Only the share routes opt in: entitlement and staff surfaces still refuse the demo token.
    assert.equal((await bearerRequest(context, '/v1/entitlement', ananya, { method: 'POST' })).status, 401);
    assert.notEqual((await bearerRequest(context, '/v1/admin/published-shares', ananya)).status, 200);

    // A disabled demo account loses Peers immediately, token or not.
    await accounts.update('ananya', { disabled: true });
    assert.equal((await bearerRequest(context, '/v1/shares', ananya)).status, 401);
    await accounts.update('ananya', { disabled: false });
    assert.equal((await bearerRequest(context, '/v1/shares', ananya)).status, 200);

    // A staff suspension of the seeded enrolment is honoured like any other.
    await context.pool.query(`UPDATE enrolments SET status = 'suspended' WHERE student_profile_id = $1`, [demoProfileId('ananya')]);
    assert.equal((await bearerRequest(context, '/v1/shares', ananya)).status, 403);
    await context.pool.query(`UPDATE enrolments SET status = 'approved' WHERE student_profile_id = $1`, [demoProfileId('ananya')]);

    // With SEED_DEMO off the same token is refused exactly as before.
    const off = new Hono();
    mount(off, { ...base, seedDemo: false });
    const offRes = await off.request(`${context.origin}/v1/shares`, { headers: { authorization: `Bearer ${ananya}` } });
    assert.equal(offRes.status, 401);
  });
});
