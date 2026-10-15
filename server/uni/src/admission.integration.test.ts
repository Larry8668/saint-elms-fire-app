// Admission integration tests: enrolment lifecycle, staff authz and audit against a
// disposable database. Run only inside `pnpm --filter @sef/uni-server db:test:integration`.

import assert from 'node:assert/strict';
import { generateKeyPairSync } from 'node:crypto';
import { mkdtemp } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { Hono } from 'hono';
import test from 'node:test';
import { signToken } from '@sef/shared/node';
import { CONTRACT_VERSION, type Enrolment } from '@sef/shared';
import type { AccountAuth } from './account-auth';
import type { UniDeps } from './deps';
import { meRoutes } from './routes/me';
import { adminRoutes } from './routes/admin';
import { staffRoutes } from './routes/staff';
import { studentRoutes } from './routes/student';
import { grantStaffMembership } from './staff';
import { AuditLog } from './store/audit';
import { DispersalStore } from './store/dispersal';
import { ReleaseStore } from './store/releases';
import { ShareStore } from './store/shares';
import {
  authPath,
  cookieFrom,
  jsonPost,
  signUpVerified,
  testOptions,
  withAuthSchema,
  type AuthContext,
} from './testing/auth-fixture';

const PROGRAMME_ID = 'bsc-test';
const COHORT = 'bsc-pma-2026';

let cachedDeps: Promise<{ keys: UniDeps['keys']; releases: ReleaseStore; tmp: string }> | null = null;
function staticDeps() {
  cachedDeps ??= (async () => {
    const tmp = await mkdtemp(path.join(os.tmpdir(), 'sef-admission-'));
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

function deps(context: AuthContext, extra: { keys: UniDeps['keys']; releases: ReleaseStore; tmp: string }): UniDeps {
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
    shares: new ShareStore(extra.tmp),
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

test('a verified applicant can list programmes but still cannot read the curriculum', testOptions, async () => {
  await withAuthSchema(async (context) => {
    const extra = await staticDeps();
    mount(context.app, deps(context, extra));
    const cookie = await signUpVerified(context, 'applicant@example.test', 'Applicant');

    const list = await authed(context, '/v1/programmes', cookie);
    assert.equal(list.status, 200);
    const body = (await list.json()) as { programmes: Array<{ id: string; name: string; institution: string }> };
    assert.equal(body.programmes.length, 1);
    assert.equal(body.programmes[0]!.id, PROGRAMME_ID);
    assert.ok(body.programmes[0]!.name.length > 0);
    // Identity only: no rows, no semesters, no release state may leak before approval.
    assert.deepEqual(Object.keys(body.programmes[0]!).sort(), ['id', 'institution', 'name']);

    // The full manifest stays behind the approval gate for the same applicant.
    const full = await authed(context, '/v1/programme', cookie);
    assert.equal(full.status, 403);
  });
});

test('an unauthenticated caller cannot list programmes', testOptions, async () => {
  await withAuthSchema(async (context) => {
    const extra = await staticDeps();
    mount(context.app, deps(context, extra));
    assert.equal((await context.app.request(`${context.origin}/v1/programmes`)).status, 401);
  });
});

test('unauthenticated callers get 401 on every admission surface', testOptions, async () => {
  await withAuthSchema(async (context) => {
    const extra = await staticDeps();
    mount(context.app, deps(context, extra));
    for (const path of [
      '/v1/me',
      '/v1/admin/students',
      '/v1/admin/staff',
      '/v1/admin/audit-events',
      '/v1/admin/erasure-requests',
    ]) {
      const res = await context.app.request(`${context.origin}${path}`);
      assert.equal(res.status, 401, path);
    }
    const applyAnon = await apply(context, 'x=1');
    assert.equal(applyAnon.status, 401);
  });
});

test('verified applicants apply once, see pending state, and cannot self-approve', testOptions, async () => {
  await withAuthSchema(async (context) => {
    const extra = await staticDeps();
    mount(context.app, deps(context, extra));
    const cookie = await signUpVerified(context, 'ada@example.test', 'Ada');

    const me = await authed(context, '/v1/me', cookie);
    const meBody = (await me.json()) as { studentId: string | null; enrolment: null; staffRoles: string[] };
    assert.equal(meBody.studentId, null);
    assert.equal(meBody.enrolment, null);
    assert.deepEqual(meBody.staffRoles, []);

    const first = await apply(context, cookie);
    assert.equal(first.status, 201);
    const enrolment = (await first.json()) as Enrolment;
    assert.equal(enrolment.status, 'pending');
    assert.equal(enrolment.cohortId, null);
    assert.equal(enrolment.curriculumVersion, '2026.1');

    const again = await apply(context, cookie);
    assert.equal(again.status, 200, 'a repeated application is idempotent');
    assert.equal(((await again.json()) as Enrolment).id, enrolment.id);

    // A student cannot act on their own application.
    const selfApprove = await decide(context, cookie, enrolment.id, {
      action: 'approve', reason: 'self', expectedVersion: enrolment.version, cohortId: COHORT,
    });
    assert.equal(selfApprove.status, 403);

    const unknown = await authed(context, '/v1/applications', cookie, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ schemaVersion: CONTRACT_VERSION, programmeId: 'no-such-programme' }),
    });
    assert.equal(unknown.status, 400);
  });
});

test('unverified accounts cannot apply', testOptions, async () => {
  await withAuthSchema(async (context) => {
    const extra = await staticDeps();
    mount(context.app, deps(context, extra));
    const signUp = await jsonPost(context, '/sign-up/email', { email: 'unverified@example.test', password: 'x'.repeat(24), name: 'Un' });
    assert.equal(signUp.status, 200);
    // better-auth never signs unverified users in, so exercise the guard with a session
    // row planted directly and presented through the bearer plugin.
    const user = await context.pool.query<{ id: string }>('SELECT id FROM "user" WHERE email = $1', ['unverified@example.test']);
    const token = 'tok-' + Math.random().toString(36).slice(2);
    await context.pool.query(
      `INSERT INTO session (id, "expiresAt", token, "createdAt", "updatedAt", "userId") VALUES ($1, now() + interval '1 day', $2, now(), now(), $3)`,
      [`sess-${token}`, token, user.rows[0]!.id],
    );
    const res = await context.app.request(`${context.origin}/v1/applications`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
      body: JSON.stringify({ schemaVersion: CONTRACT_VERSION, programmeId: PROGRAMME_ID }),
    });
    assert.equal(res.status, 403);
    assert.equal(((await res.json()) as { error: string }).error, 'verification_required');
  });
});

test('the full admission lifecycle is audited and optimistic versions gate decisions', testOptions, async () => {
  await withAuthSchema(async (context) => {
    const extra = await staticDeps();
    mount(context.app, deps(context, extra));
    const { cookie: ownerCookie } = await staffToken(context, 'owner@example.test', 'owner');
    const studentCookie = await signUpVerified(context, 'student@example.test', 'Stu Dent');

    const pending = (await (await apply(context, studentCookie)).json()) as Enrolment;

    const list = await authed(context, '/v1/admin/students?search=student@example', ownerCookie);
    assert.equal(list.status, 200);
    const page = (await list.json()) as { rows: Array<{ email: string; enrolment: Enrolment }> };
    assert.equal(page.rows.length, 1);
    assert.equal(page.rows[0]!.email, 'student@example.test');
    assert.equal(page.rows[0]!.enrolment.status, 'pending');

    const badVersion = await decide(context, ownerCookie, pending.id, {
      action: 'approve', reason: 'welcome', expectedVersion: pending.version + 9, cohortId: COHORT,
    });
    assert.equal(badVersion.status, 409);

    const unknownCohort = await decide(context, ownerCookie, pending.id, {
      action: 'approve', reason: 'welcome', expectedVersion: pending.version, cohortId: 'no-such-cohort',
    });
    assert.equal(unknownCohort.status, 400);

    const approved = await decide(context, ownerCookie, pending.id, {
      action: 'approve', reason: 'welcome aboard', expectedVersion: pending.version, cohortId: COHORT,
    });
    assert.equal(approved.status, 200);
    const approvedBody = (await approved.json()) as Enrolment;
    assert.equal(approvedBody.status, 'approved');
    assert.equal(approvedBody.cohortId, COHORT);
    assert.equal(approvedBody.version, pending.version + 1);
    assert.ok(approvedBody.decision?.reason === 'welcome aboard');

    const audit = await authed(context, '/v1/admin/audit-events', ownerCookie);
    const events = ((await audit.json()) as Array<{ event: string }>).map((e) => e.event);
    assert.ok(events.includes('enrolment.approved'));
    assert.ok(events.includes('application.submitted'));
    assert.ok(events.includes('staff.granted'));

    // Two parallel decisions on the same version: exactly one wins.
    const [a, b] = await Promise.all([
      decide(context, ownerCookie, pending.id, { action: 'suspend', reason: 'a', expectedVersion: approvedBody.version }),
      decide(context, ownerCookie, pending.id, { action: 'suspend', reason: 'b', expectedVersion: approvedBody.version }),
    ]);
    const statuses = [a.status, b.status].sort();
    assert.deepEqual(statuses, [200, 409], 'concurrent decisions cannot both land');
  });
});

test('suspension revokes live sessions; reinstatement restores access', testOptions, async () => {
  await withAuthSchema(async (context) => {
    const extra = await staticDeps();
    mount(context.app, deps(context, extra));
    const { cookie: ownerCookie } = await staffToken(context, 'owner2@example.test');
    const studentCookie = await signUpVerified(context, 'suspended@example.test');
    const pending = (await (await apply(context, studentCookie)).json()) as Enrolment;
    const approved = (await (await decide(context, ownerCookie, pending.id, {
      action: 'approve', reason: 'ok', expectedVersion: pending.version, cohortId: COHORT,
    })).json()) as Enrolment;

    // Programme visibility opens up for the approved student.
    const programme = await authed(context, '/v1/programme', studentCookie);
    assert.equal(programme.status, 200);
    const catalogue = await authed(context, '/v1/catalogue', studentCookie);
    assert.equal(catalogue.status, 200);
    assert.equal(((await catalogue.json()) as { cohortId: string }).cohortId, COHORT);

    const suspended = (await (await decide(context, ownerCookie, pending.id, {
      action: 'suspend', reason: 'investigation', expectedVersion: approved.version,
    })).json()) as Enrolment;
    assert.equal(suspended.status, 'suspended');
    assert.equal(suspended.cohortId, COHORT, 'the cohort survives suspension');

    const after = await authPath(context, '/get-session', { headers: { cookie: studentCookie } });
    assert.equal(await after.json(), null, 'suspension destroys the live session');

    // A fresh sign-in is still denied admission-scoped resources.
    const relogin = await jsonPost(context, '/sign-in/email', { email: 'suspended@example.test', password: 'correct-horse-battery-staple' });
    const freshCookie = cookieFrom(relogin);
    const denied = await authed(context, '/v1/catalogue', freshCookie);
    assert.equal(denied.status, 401);
    const deniedProgramme = await authed(context, '/v1/programme', freshCookie);
    assert.equal(deniedProgramme.status, 403);

    const reinstated = (await (await decide(context, ownerCookie, pending.id, {
      action: 'reinstate', reason: 'cleared', expectedVersion: suspended.version,
    })).json()) as Enrolment;
    assert.equal(reinstated.status, 'approved');

    const back = await authed(context, '/v1/programme', freshCookie);
    assert.equal(back.status, 200);
  });
});

test('withdrawal and reapplication keep one row per programme', testOptions, async () => {
  await withAuthSchema(async (context) => {
    const extra = await staticDeps();
    mount(context.app, deps(context, extra));
    const cookie = await signUpVerified(context, 'leaver@example.test');
    const pending = (await (await apply(context, cookie)).json()) as Enrolment;

    const withdrawn = await authed(context, '/v1/me/enrolment/withdraw', cookie, { method: 'POST' });
    assert.equal(withdrawn.status, 200);
    assert.equal(((await withdrawn.json()) as Enrolment).status, 'withdrawn');

    const reapplied = await apply(context, cookie);
    assert.equal(reapplied.status, 200, 'reapplication reopens the same row');
    const row = (await reapplied.json()) as Enrolment;
    assert.equal(row.id, pending.id);
    assert.equal(row.status, 'pending');
    assert.equal(row.version, pending.version + 2);

    const count = await context.pool.query<{ n: string }>('SELECT count(*)::text AS n FROM enrolments');
    assert.equal(count.rows[0]!.n, '1');
  });
});

test('staff capabilities: last-owner protection, role gates and fresh-session requirement', testOptions, async () => {
  await withAuthSchema(async (context) => {
    const extra = await staticDeps();
    mount(context.app, deps(context, extra));
    const { cookie: ownerCookie, userId: ownerId } = await staffToken(context, 'the-owner@example.test');
    const { cookie: registrarCookie, userId: registrarId } = await staffToken(context, 'reg@example.test', 'registrar');

    // Non-owner staff cannot grant the owner role.
    const escalate = await authed(context, '/v1/admin/staff', registrarCookie, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ schemaVersion: CONTRACT_VERSION, email: 'reg@example.test', role: 'owner' }),
    });
    assert.equal(escalate.status, 403);

    // A plain student session cannot touch staff APIs at all.
    const studentCookie = await signUpVerified(context, 'plain@example.test');
    const asStudent = await authed(context, '/v1/admin/staff', studentCookie);
    assert.equal(asStudent.status, 403);

    // Registrar grants registrar — allowed.
    const invite = await authed(context, '/v1/admin/staff', registrarCookie, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ schemaVersion: CONTRACT_VERSION, email: 'plain@example.test', role: 'support' }),
    });
    assert.equal(invite.status, 201);

    // The last owner cannot be suspended.
    const ownerMembership = await context.pool.query<{ id: string }>(
      `SELECT id FROM staff_memberships WHERE staff_subject = $1 AND role = 'owner'`, [ownerId],
    );
    const lastOwner = await authed(context, `/v1/admin/staff/${ownerMembership.rows[0]!.id}`, ownerCookie, {
      method: 'PATCH',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ schemaVersion: CONTRACT_VERSION, status: 'suspended', reason: 'test' }),
    });
    assert.equal(lastOwner.status, 409);

    // Registrar cannot modify the owner's membership even when more owners exist.
    await signUpVerified(context, 'second-owner@example.test');
    await grantStaffMembership(context.pool, { email: 'second-owner@example.test', role: 'owner', actor: 'bootstrap' });
    const asRegistrar = await authed(context, `/v1/admin/staff/${ownerMembership.rows[0]!.id}`, registrarCookie, {
      method: 'PATCH',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ schemaVersion: CONTRACT_VERSION, status: 'suspended', reason: 'test' }),
    });
    assert.equal(asRegistrar.status, 403);

    // Aged sessions must re-authenticate before mutating.
    await context.pool.query(`UPDATE session SET "createdAt" = now() - interval '1 hour' WHERE "userId" = $1`, [registrarId]);
    const stale = await authed(context, '/v1/admin/staff', registrarCookie, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ schemaVersion: CONTRACT_VERSION, email: 'plain@example.test', role: 'lecturer' }),
    });
    assert.equal(stale.status, 403);
    assert.equal(((await stale.json()) as { error: string }).error, 'reauthentication_required');
  });
});

test('erasure requests deduplicate and confirmation anonymizes the account', testOptions, async () => {
  await withAuthSchema(async (context) => {
    const extra = await staticDeps();
    mount(context.app, deps(context, extra));
    const { cookie: ownerCookie } = await staffToken(context, 'owner3@example.test');
    const cookie = await signUpVerified(context, 'gone@example.test', 'Gone Girl');
    await apply(context, cookie);

    const first = await authed(context, '/v1/me/erasure-requests', cookie, { method: 'POST' });
    assert.equal(first.status, 201);
    const again = await authed(context, '/v1/me/erasure-requests', cookie, { method: 'POST' });
    assert.equal(again.status, 200, 'a second request reports the pending one instead of duplicating');

    const requests = (await (await authed(context, '/v1/admin/erasure-requests', ownerCookie)).json()) as Array<{ id: string }>;
    assert.equal(requests.length, 1);

    const confirmed = await authed(context, `/v1/admin/erasure-requests/${requests[0]!.id}/confirm`, ownerCookie, { method: 'POST' });
    assert.equal(confirmed.status, 204);

    const user = await context.pool.query<{ email: string; name: string }>('SELECT email, name FROM "user" WHERE email LIKE $1 OR name = $2', ['erased-%@erased.invalid', '[erased]']);
    assert.equal(user.rows.length, 1);
    assert.match(user.rows[0]!.email, /^erased-[0-9a-f-]+@erased\.invalid$/);

    const sessions = await context.pool.query<{ n: string }>('SELECT count(*)::text AS n FROM session');
    assert.equal(sessions.rows[0]!.n, '1', 'only the owner session remains');
  });
});

test('the offline entitlement binds signature, audience, student, device and cohort', testOptions, async () => {
  await withAuthSchema(async (context) => {
    const extra = await staticDeps();
    mount(context.app, deps(context, extra));
    const { cookie: ownerCookie } = await staffToken(context, 'owner-ent@example.test');
    const cookie = await signUpVerified(context, 'entitled@example.test', 'Entitled');
    await apply(context, cookie);

    // Pending students get no entitlement.
    const pending = await authed(context, '/v1/entitlement', cookie, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ deviceId: 'device-1' }),
    });
    assert.equal(pending.status, 403);

    const mine = (await (await authed(context, '/v1/me', cookie)).json()) as { enrolment: Enrolment | null };
    const decided = await decide(context, ownerCookie, mine.enrolment!.id, { action: 'approve', reason: 'ok', cohortId: COHORT, expectedVersion: mine.enrolment!.version });
    assert.equal(decided.status, 200);

    const res = await authed(context, '/v1/entitlement', cookie, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ deviceId: 'device-1' }),
    });
    assert.equal(res.status, 200);
    const body = (await res.json()) as { token: string; expiresAt: string; cohortId: string };
    assert.equal(body.cohortId, COHORT);

    const { verifyToken } = await import('@sef/shared/node');
    const claims = verifyToken(body.token, extra.keys.publicKeyPem);
    const user = await context.pool.query<{ id: string }>('SELECT id FROM "user" WHERE email = $1', ['entitled@example.test']);
    assert.equal(claims.sub, user.rows[0]!.id);
    assert.equal(claims.role, 'student');
    assert.equal(claims.aud, 'sef-engine');
    assert.equal(claims.dev, 'device-1');
    assert.equal(claims.cohortId, COHORT);
    assert.ok(claims.exp * 1000 > Date.now());
  });
});

test('entitlement rejects anonymous callers, staff-only sessions and missing devices', testOptions, async () => {
  await withAuthSchema(async (context) => {
    const extra = await staticDeps();
    mount(context.app, deps(context, extra));
    const anon = await context.app.request(`${context.origin}/v1/entitlement`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ deviceId: 'd' }),
    });
    assert.equal(anon.status, 401);

    const { cookie: ownerCookie } = await staffToken(context, 'owner-noent@example.test');
    const staff = await authed(context, '/v1/entitlement', ownerCookie, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ deviceId: 'd' }),
    });
    assert.equal(staff.status, 403, 'staff without a student enrolment get no entitlement');

    const cookie = await signUpVerified(context, 'nodev@example.test', 'No Device');
    await apply(context, cookie);
    const { cookie: approver } = await staffToken(context, 'owner-ent2@example.test');
    const mine = (await (await authed(context, '/v1/me', cookie)).json()) as { enrolment: Enrolment | null };
    await decide(context, approver, mine.enrolment!.id, { action: 'approve', reason: 'ok', cohortId: COHORT, expectedVersion: mine.enrolment!.version });

    const noDevice = await authed(context, '/v1/entitlement', cookie, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({}),
    });
    assert.equal(noDevice.status, 400);
  });
});
