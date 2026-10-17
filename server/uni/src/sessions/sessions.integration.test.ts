// Session orchestrator integration tests (PR-42): routes, lease, spawn state machine and
// teardown against a disposable Postgres and the in-repo fake Instabox. Run only inside
// `pnpm --filter @sef/uni-server db:test:integration` (skipped without a database).

import assert from 'node:assert/strict';
import { generateKeyPairSync, randomUUID } from 'node:crypto';
import { mkdtemp } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import type { Hono } from 'hono';
import { CONTRACT_VERSION, type Enrolment, type StudentSessionStatus } from '@sef/shared';
import { signToken, verifyGatewayToken } from '@sef/shared/node';
import type { UniDeps } from '../deps';
import { InstaboxClient } from '../instabox/client';
import { FAKE_KEY, FakeInstabox } from '../instabox/fake';
import { meRoutes } from '../routes/me';
import { staffRoutes } from '../routes/staff';
import { grantStaffMembership } from '../staff';
import { AuditLog } from '../store/audit';
import { ReleaseStore } from '../store/releases';
import { signUpVerified, testOptions, withAuthSchema, type AuthContext } from '../testing/auth-fixture';
import type { SessionConfig } from './config';
import { SessionOrchestrator, type HealthProbe } from './orchestrator';
import { SessionReaper } from './reaper';
import { sessionAdminRoutes, sessionRoutes } from './routes';
import { sessionById, type SessionRow } from './store';

const PROGRAMME_ID = 'bsc-test';
const COHORT = 'bsc-pma-2026';
const GATEWAY_SECRET = 'gateway-integration-secret-0123456789-abcdef';
const SNAPSHOT = 'sn_agquvqu6h2bc33n7w2bfctcxni';

function testConfig(overrides: Partial<SessionConfig> = {}): SessionConfig {
  return {
    apiKey: FAKE_KEY,
    snapshotId: SNAPSHOT,
    maxConcurrent: 3,
    idleMinutes: 15,
    reaperIntervalMs: 60_000,
    autoSuspendSeconds: 1800,
    uniPublicUrl: 'https://uni.example.test',
    gatewayUrl: 'https://gateway.example.test/v1',
    gatewaySecret: GATEWAY_SECRET,
    gatewayTokenMinutes: 60,
    objectStore: { OBJECT_STORE_ENDPOINT: 'https://store.example.test', OBJECT_STORE_BUCKET: 'sef-vaults', OBJECT_STORE_SECRET_KEY: 'store-secret-value' },
    seatHome: '/data/home/sef-seat',
    timeouts: { create: 3000, start: 3000, publish: 1000, sessionStart: 3000, health: 1500, flush: 3000, delete: 3000 },
    capacityWaitMs: 3000,
    retryBaseMs: 5,
    ...overrides,
  };
}

interface Harness {
  context: AuthContext;
  fake: FakeInstabox;
  client: InstaboxClient;
  orchestrator: SessionOrchestrator;
  deps: UniDeps;
  /** A new orchestrator over the same database and fake: what a uni restart looks like. */
  restart: () => SessionOrchestrator;
  probes: string[];
}

let staticDeps: Promise<{ keys: UniDeps['keys']; releases: ReleaseStore; tmp: string }> | null = null;
function statics() {
  staticDeps ??= (async () => {
    const tmp = await mkdtemp(path.join(os.tmpdir(), 'sef-sessions-'));
    const releases = new ReleaseStore(undefined, tmp);
    await releases.load();
    const { privateKey, publicKey } = generateKeyPairSync('ed25519');
    return { keys: { privateKey, publicKeyPem: publicKey.export({ type: 'spki', format: 'pem' }).toString() }, releases, tmp };
  })();
  return staticDeps;
}

const LEGACY_ACCOUNTS: Record<string, { id: string; role: string; disabled: boolean; cohortId?: string }> = {
  ananya: { id: 'ananya', role: 'student', disabled: false, cohortId: COHORT },
  gone: { id: 'gone', role: 'student', disabled: true, cohortId: COHORT },
  orphaned: { id: 'orphaned', role: 'student', disabled: false, cohortId: 'retired-cohort' },
};

async function withSessions(run: (h: Harness) => Promise<void>, overrides: Partial<SessionConfig> = {}): Promise<void> {
  const extra = await statics();
  const fake = new FakeInstabox();
  await fake.listen();
  const probes: string[] = [];
  try {
    await withAuthSchema(async (context) => {
      const client = new InstaboxClient({ apiKey: FAKE_KEY, baseUrl: fake.base });
      const config = testConfig(overrides);
      const probeHealth = async (url: string): Promise<HealthProbe> => {
        probes.push(url);
        const response = await fetch(`${url}/api/health`);
        return { status: response.status, body: await response.json().catch(() => null) };
      };
      const make = () => new SessionOrchestrator({ pool: context.pool, client, config, probeHealth, pollMs: 5 });
      const orchestrator = make();
      const deps: UniDeps = {
        pool: context.pool,
        accountAuth: context.auth,
        releases: extra.releases,
        keys: extra.keys,
        programme: {
          programme: {
            schemaVersion: CONTRACT_VERSION, id: PROGRAMME_ID, name: 'BSc Test', institution: 'Saint Elms', manifestVersion: '2026.1',
            sourceDocuments: ['programme.yaml'], rows: [], optionGroups: [],
          },
          semesters: [],
          declaredCounts: { total: 0, bySemester: {}, byStatus: {} },
          derivedCounts: { rows: 0, bySemester: {}, byStatus: {}, degreeRows: 0, degreeCredits: { min: 0, max: 0 } },
          diagnostics: [],
          resolveContentDir: () => null,
        },
        availability: {},
        courseware: { programmeId: PROGRAMME_ID, programmeName: 'BSc Test', courses: new Map() } as never,
        shares: null as never,
        accounts: { get: (id: string) => LEGACY_ACCOUNTS[id] } as never,
        audit: new AuditLog(extra.tmp),
        dispersal: null as never,
        sessions: orchestrator,
      };
      mount(context.app, deps);
      await run({ context, fake, client, orchestrator, deps, restart: make, probes });
      await orchestrator.idle();
    });
  } finally {
    await fake.close();
  }
}

function mount(app: Hono, deps: UniDeps) {
  app.route('/v1/admin', staffRoutes(deps));
  app.route('/v1/admin', sessionAdminRoutes(deps));
  app.route('/v1', meRoutes(deps));
  app.route('/v1', sessionRoutes(deps));
}

const call = (h: Harness, method: string, url: string, auth: string, body?: unknown) =>
  h.context.app.request(`${h.context.origin}${url}`, {
    method,
    headers: {
      ...(auth.startsWith('sef1') ? { authorization: `Bearer ${auth}` } : { cookie: auth }),
      ...(body === undefined ? {} : { 'content-type': 'application/json' }),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });

const json = async <T = StudentSessionStatus>(response: Response) => (await response.json()) as T;

let staffCookie: string | null = null;
let staffContext: AuthContext | null = null;
async function staff(h: Harness): Promise<string> {
  if (staffContext !== h.context) {
    const email = `owner-${randomUUID().slice(0, 8)}@example.test`;
    staffCookie = await signUpVerified(h.context, email, 'Owner');
    await grantStaffMembership(h.context.pool, { email, role: 'owner', actor: 'bootstrap' });
    staffContext = h.context;
  }
  return staffCookie!;
}

/** Signs up, applies and gets approved. Returns the student's cookie and user id. */
async function approvedStudent(h: Harness, name: string): Promise<{ cookie: string; userId: string }> {
  const email = `${name}-${randomUUID().slice(0, 8)}@example.test`;
  const cookie = await signUpVerified(h.context, email, name);
  const applied = await call(h, 'POST', '/v1/applications', cookie, { schemaVersion: CONTRACT_VERSION, programmeId: PROGRAMME_ID });
  assert.equal(applied.status, 201);
  const enrolment = await json<Enrolment>(applied);
  const decided = await call(h, 'POST', `/v1/admin/enrolments/${enrolment.id}/decision`, await staff(h), {
    schemaVersion: CONTRACT_VERSION, action: 'approve', reason: 'welcome', expectedVersion: enrolment.version, cohortId: COHORT,
  });
  assert.equal(decided.status, 200);
  const user = await h.context.pool.query<{ id: string }>('SELECT id FROM "user" WHERE email = $1', [email]);
  return { cookie, userId: user.rows[0]!.id };
}

const row = async (h: Harness, id: string): Promise<SessionRow> => (await sessionById(h.context.pool, id))!;

/** The session-start exec the orchestrator sent, if any. */
const sessionStartExecs = (h: Harness) => h.fake.requests('POST', '/v1/machines/').filter((r) => r.path.endsWith('/exec') && String(r.body.cmd).includes('session-start.sh'));
const stopExecs = (h: Harness) => h.fake.requests('POST', '/v1/machines/').filter((r) => r.path.endsWith('/exec') && String(r.body.cmd).includes('session-stop.sh'));

test('spawn: create → start → publish → session-start → health, with per-session values only in envs', testOptions, async () => {
  await withSessions(async (h) => {
    const { cookie, userId } = await approvedStudent(h, 'ada');
    const first = await call(h, 'POST', '/v1/session', cookie);
    assert.equal(first.status, 202);
    const started = await json(first);
    assert.equal(started.state, 'spawning');
    assert.equal(started.url, undefined, 'no URL before the engine is ready');
    await h.orchestrator.idle();

    const status = await json(await call(h, 'GET', '/v1/session', cookie));
    assert.equal(status.state, 'ready');
    assert.ok(status.url?.includes('/engine/m_'));
    assert.ok(status.steps.every((s) => s.status === 'done'));

    // The order matters: publish first, because ENGINE_PUBLIC_HOST comes from the published URL.
    const sequence = h.fake.seen
      .filter((r) => !r.path.startsWith('/v1/operations/') && !(r.path.endsWith('/exec') && r.body.cmd === 'true') && r.method !== 'GET')
      .map((r) => `${r.method} ${r.path.replace(/m_[a-z0-9]{26}/, 'M').replace(/\/v1\/machines$/, '/create')}`);
    assert.deepEqual(sequence, ['POST /create', 'POST /v1/machines/M/start', 'POST /v1/machines/M/ports', 'POST /v1/machines/M/exec']);

    const [create] = h.fake.requests('POST', '/v1/machines');
    const session = await row(h, started.id);
    assert.deepEqual(create!.body.metadata, { app: 'sef-session', account: userId, session: started.id });
    assert.equal(create!.body.vault, false);
    assert.equal(create!.body.snapshotId, SNAPSHOT);
    assert.equal(create!.headers['idempotency-key'], session.create_idempotency_key);

    const [exec] = sessionStartExecs(h);
    const envs = exec!.body.envs as Record<string, string>;
    assert.equal(exec!.body.cmd, 'bash /data/home/sef-seat/session-start.sh');
    assert.equal(envs.ENGINE_PUBLIC_HOST, new URL(status.url!).host);
    assert.equal(envs.ENGINE_SEAT_OWNER, userId);
    assert.equal(envs.VAULT_SYNC_ACCOUNT, userId);
    assert.equal(envs.UNI_SERVER_URL, 'https://uni.example.test');
    assert.equal(envs.MODEL_GATEWAY_URL, 'https://gateway.example.test/v1');
    assert.equal(envs.OBJECT_STORE_BUCKET, 'sef-vaults');
    assert.equal(envs.SYNC_FLUSH_TOKEN, session.flush_token);
    assert.match(envs.SYNC_FLUSH_TOKEN!, /^[A-Za-z0-9_-]{43}$/);
    assert.match(envs.MODEL_GATEWAY_TOKEN!, /^sefgw1\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/);
    const verified = verifyGatewayToken(`Bearer ${envs.MODEL_GATEWAY_TOKEN}`, { secret: GATEWAY_SECRET, devTokens: [] });
    assert.ok(verified.ok, 'the gateway (PR-43a) accepts the minted token');
    const claims = verified.claims;
    assert.equal(claims.sub, userId);
    assert.equal(claims.vm, session.machine_id);
    assert.ok(claims.exp * 1000 > Date.now() && claims.exp * 1000 <= Date.now() + 61 * 60_000, 'short-lived');
    // No value of any kind on a command line.
    for (const r of h.fake.requests('POST', '/v1/machines/').filter((x) => x.path.endsWith('/exec'))) {
      for (const secret of [envs.SYNC_FLUSH_TOKEN, envs.MODEL_GATEWAY_TOKEN, 'store-secret-value', userId]) assert.equal(String(r.body.cmd).includes(secret!), false);
    }

    // A second POST returns the same ready session and creates nothing.
    const again = await call(h, 'POST', '/v1/session', cookie);
    assert.equal(again.status, 200);
    assert.equal((await json(again)).id, started.id);
    assert.equal(h.fake.created.length, 1);
  });
});

test('the lease: concurrent POSTs for one student make one row and one machine', testOptions, async () => {
  await withSessions(async (h) => {
    const { cookie } = await approvedStudent(h, 'tabs');
    const responses = await Promise.all(Array.from({ length: 8 }, () => call(h, 'POST', '/v1/session', cookie)));
    const ids = new Set(await Promise.all(responses.map(async (r) => (await json(r)).id)));
    assert.equal(ids.size, 1);
    await h.orchestrator.idle();
    assert.equal(h.fake.created.length, 1);
    const rows = await h.context.pool.query('SELECT id FROM student_sessions');
    assert.equal(rows.rowCount, 1);
    assert.equal(sessionStartExecs(h).length, 1);
  });
});

test('progress: GET names the active step while the vault restores; sync ready makes it ready', testOptions, async () => {
  let sync = 'restoring';
  await withSessions(async (h) => {
    h.fake.health = () => ({ ok: true, engine: '0.3.0', uni: { reachable: true }, sync: { state: sync } });
    const { cookie } = await approvedStudent(h, 'restore');
    const { id } = await json(await call(h, 'POST', '/v1/session', cookie));
    for (let i = 0; i < 200 && (await row(h, id)).step !== 'health'; i += 1) await new Promise((r) => setTimeout(r, 10));
    const progress = await json(await call(h, 'GET', '/v1/session', cookie));
    assert.equal(progress.state, 'spawning');
    assert.equal(progress.step, 'health');
    assert.deepEqual(progress.steps.map((s) => s.status), ['done', 'done', 'done', 'done', 'active']);
    assert.equal(progress.steps[4]!.label, 'Restoring your vault');
    sync = 'ready';
    await h.orchestrator.idle();
    assert.equal((await row(h, id)).state, 'ready');
  }, { timeouts: { create: 3000, start: 3000, publish: 1000, sessionStart: 3000, health: 5000, flush: 3000, delete: 3000 } });
});

/** Runs one spawn that fails at a step; asserts the row is failed and the machine is gone. */
async function failingSpawn(h: Harness, name: string, expectedStep: string, expectedError: RegExp) {
  const { cookie } = await approvedStudent(h, name);
  const { id } = await json(await call(h, 'POST', '/v1/session', cookie));
  await h.orchestrator.idle();
  const failed = await row(h, id);
  assert.equal(failed.state, 'failed', `state after a ${expectedStep} failure`);
  assert.equal(failed.step, expectedStep);
  assert.match(failed.last_error ?? '', expectedError);
  assert.equal([...h.fake.machines.values()].filter((m) => m.metadata?.app === 'sef-session').length, 0, 'the failed machine is deleted');
  assert.equal(stopExecs(h).length, 0, 'a session never handed out is not flushed');
  const status = await json(await call(h, 'GET', '/v1/session', cookie));
  assert.equal(status.state, 'failed');
  assert.equal(status.error?.code, 'spawn_failed');
  assert.equal(status.steps.find((s) => s.name === expectedStep)?.status, 'failed');
  assert.equal(JSON.stringify(status).includes(failed.last_error!), false, 'internals stay out of the student view');
  return { cookie, id };
}

test('step failures: each leaves a failed row and no machine', testOptions, async () => {
  await withSessions(async (h) => {
    h.fake.quota = 0;
    await failingSpawn(h, 'quota', 'create', /quota_exceeded/);
  }, { capacityWaitMs: 50 });
  await withSessions(async (h) => {
    h.fake.onExec = (machine) => {
      machine.state = 'error';
      return { status: 409, code: 'machine_not_running' };
    };
    await failingSpawn(h, 'broken', 'start', /machine_unusable/);
  });
  await withSessions(async (h) => {
    h.fake.injections.push({ match: (r) => r.path.endsWith('/ports'), respond: { status: 503, code: 'ports_disabled' }, times: 1 });
    await failingSpawn(h, 'noports', 'publish', /ports_disabled/);
  });
  await withSessions(async (h) => {
    h.fake.onExec = (_m, body) => ({ stdout: '', stderr: 'error: UNI_SERVER_URL is not valid', exitCode: body.cmd === 'true' ? 0 : 1 });
    await failingSpawn(h, 'script', 'session_start', /session-start.sh exited 1/);
    assert.equal(sessionStartExecs(h).length, 2, 'the re-runnable script is retried once');
  });
  await withSessions(async (h) => {
    h.fake.health = () => 502;
    await failingSpawn(h, 'nohealth', 'health', /health_timeout/);
  }, { timeouts: { create: 3000, start: 3000, publish: 1000, sessionStart: 3000, health: 100, flush: 3000, delete: 3000 } });
  await withSessions(async (h) => {
    h.fake.health = () => ({ ok: true, engine: '0.3.0', uni: { reachable: true }, sync: { state: 'error' } });
    await failingSpawn(h, 'syncerr', 'health', /sync_error/);
  });
});

test('no_capacity: backs off and retries with a fresh key after each refusal; one machine in the end', testOptions, async () => {
  await withSessions(async (h) => {
    h.fake.noCapacity = 2;
    const { cookie } = await approvedStudent(h, 'busy');
    const { id } = await json(await call(h, 'POST', '/v1/session', cookie));
    await h.orchestrator.idle();
    assert.equal((await row(h, id)).state, 'ready');
    const keys = h.fake.requests('POST', '/v1/machines').filter((r) => r.path === '/v1/machines').map((r) => r.headers['idempotency-key']);
    assert.equal(keys.length, 3);
    assert.equal(new Set(keys).size, 3, 'a refused key is never replayed (it would replay the refusal)');
    assert.equal(h.fake.created.length, 1);
  });
  // A create whose outcome is unknown (the connection dropped) keeps its key.
  await withSessions(async (h) => {
    h.fake.injections.push({ match: (r) => r.method === 'POST' && r.path === '/v1/machines', respond: 'drop', times: 1 });
    const { cookie } = await approvedStudent(h, 'flaky');
    const { id } = await json(await call(h, 'POST', '/v1/session', cookie));
    await h.orchestrator.idle();
    assert.equal((await row(h, id)).state, 'ready');
    const keys = h.fake.requests('POST', '/v1/machines').filter((r) => r.path === '/v1/machines').map((r) => r.headers['idempotency-key']);
    assert.equal(keys.length, 2);
    assert.equal(keys[0], keys[1]);
  });
});

test('resume after a restart: each persisted step is re-driven without a second machine', testOptions, async () => {
  for (const crashAt of ['create-before-persist', 'create-after-persist', 'start', 'publish', 'session_start', 'health'] as const) {
    await withSessions(async (h) => {
      const { cookie } = await approvedStudent(h, `crash-${crashAt.replaceAll('_', '-')}`);
      // Take the lease without driving it, then fake the state a crashed process left behind.
      h.deps.sessions = null;
      const leased = await h.context.pool.query<SessionRow>('SELECT * FROM student_sessions');
      assert.equal(leased.rowCount, 0);
      const { acquireLease } = await import('./store');
      const { row: lease } = await acquireLease(h.context.pool, { id: 'crash-account', kind: 'user' }, { maxConcurrent: 3, idleMinutes: 15 });
      const op = await h.client.createMachine({ name: lease.machine_name, snapshotId: SNAPSHOT, metadata: { app: 'sef-session', account: 'crash-account', session: lease.id } }, lease.create_idempotency_key);
      const mid = op.machineId!;
      const set = (sql: string, ...params: unknown[]) => h.context.pool.query(`UPDATE student_sessions SET ${sql} WHERE id = $1`, [lease.id, ...params]);
      if (crashAt !== 'create-before-persist') await set('machine_id = $2', mid);
      if (['start', 'publish', 'session_start', 'health'].includes(crashAt)) await set('step = $2', crashAt);
      if (['session_start', 'health'].includes(crashAt)) {
        const port = await h.client.createPort(mid, 4100, 'engine');
        await set('url = $2', port.url);
      }
      if (crashAt === 'health') {
        await h.client.waitOperation(await h.client.start(mid, 'k-start'), Date.now() + 2000);
      }
      const before = sessionStartExecs(h).length;
      const restarted = h.restart();
      await restarted.recover();
      await restarted.idle();
      const resumed = await row(h, lease.id);
      assert.equal(resumed.state, 'ready', `resume from ${crashAt}`);
      assert.equal(resumed.machine_id, mid, `adopted the same machine from ${crashAt}`);
      assert.equal(h.fake.created.length, 1, `no second machine from ${crashAt}`);
      assert.equal(sessionStartExecs(h).length - before, crashAt === 'health' ? 0 : 1);
      void cookie;
    });
  }
});

test('logout: DELETE flushes, then deletes the machine, then ends the row', testOptions, async () => {
  await withSessions(async (h) => {
    const flushOrder: string[] = [];
    h.fake.onExec = (_m, body) => {
      if (String(body.cmd).includes('session-stop.sh')) flushOrder.push(`flush:${body.envs.SYNC_FLUSH_TOKEN ? 'token' : 'none'}`);
      return { stdout: '{"ok":true,"pushed":3,"version":7}', stderr: '', exitCode: 0 };
    };
    const { cookie } = await approvedStudent(h, 'bye');
    const { id } = await json(await call(h, 'POST', '/v1/session', cookie));
    await h.orchestrator.idle();
    const mid = (await row(h, id)).machine_id!;
    const ended = await call(h, 'DELETE', '/v1/session', cookie);
    assert.equal(ended.status, 202);
    assert.equal((await json(ended)).state, 'stopping');
    await h.orchestrator.idle();
    const final = await row(h, id);
    assert.equal(final.state, 'ended');
    assert.equal(final.end_reason, 'logout');
    assert.equal(final.last_error, null);
    const stop = stopExecs(h).at(-1)!;
    const del = h.fake.requests('DELETE', `/v1/machines/${mid}`)[0]!;
    assert.ok(h.fake.seen.indexOf(stop) < h.fake.seen.indexOf(del), 'flush before delete');
    assert.deepEqual(flushOrder, ['flush:token']);
    assert.equal(h.fake.machines.has(mid), false);
    // The lease is free: a new login spawns a new VM.
    const next = await json(await call(h, 'POST', '/v1/session', cookie));
    assert.notEqual(next.id, id);
  });
});

test('logout during a spawn stops the spawn and deletes what it made', testOptions, async () => {
  await withSessions(async (h) => {
    h.fake.health = () => 502;
    const { cookie } = await approvedStudent(h, 'early');
    const { id } = await json(await call(h, 'POST', '/v1/session', cookie));
    for (let i = 0; i < 200 && (await row(h, id)).step !== 'health'; i += 1) await new Promise((r) => setTimeout(r, 10));
    await call(h, 'DELETE', '/v1/session', cookie);
    await h.orchestrator.idle();
    const final = await row(h, id);
    assert.equal(final.state, 'ended');
    assert.equal(h.fake.machines.size, 0);
  }, { timeouts: { create: 3000, start: 3000, publish: 1000, sessionStart: 3000, health: 30_000, flush: 3000, delete: 3000 } });
});

test('reaper: an idle session is flushed, then deleted; a failed flush is retried once and the delete still happens', testOptions, async () => {
  for (const flush of ['ok', 'fails', 'missing'] as const) {
    await withSessions(async (h) => {
      h.fake.onExec = (_m, body) => {
        if (!String(body.cmd).includes('session-stop.sh')) return { stdout: '', stderr: '', exitCode: 0 };
        if (flush === 'fails') return { stdout: '', stderr: 'flush: store unreachable', exitCode: 1 };
        if (flush === 'missing') return { stdout: '', stderr: 'session-stop.sh not found', exitCode: 127 };
        return { stdout: '{"ok":true}', stderr: '', exitCode: 0 };
      };
      const { cookie } = await approvedStudent(h, `idle-${flush}`);
      const { id } = await json(await call(h, 'POST', '/v1/session', cookie));
      await h.orchestrator.idle();
      const mid = (await row(h, id)).machine_id!;
      const reaper = new SessionReaper(h.orchestrator, h.context.pool, h.client);
      await reaper.tick();
      await h.orchestrator.idle();
      assert.equal((await row(h, id)).state, 'ready', 'a fresh heartbeat keeps it');

      await h.context.pool.query("UPDATE student_sessions SET heartbeat_at = now() - interval '16 minutes' WHERE id = $1", [id]);
      await reaper.tick();
      await h.orchestrator.idle();
      const final = await row(h, id);
      assert.equal(final.state, 'ended', `ended after flush ${flush}`);
      assert.equal(final.end_reason, 'idle');
      assert.equal(stopExecs(h).length, flush === 'fails' ? 2 : 1);
      const del = h.fake.requests('DELETE', `/v1/machines/${mid}`)[0];
      assert.ok(del, 'deleted regardless of the flush');
      assert.ok(h.fake.seen.indexOf(stopExecs(h).at(-1)!) < h.fake.seen.indexOf(del));
      if (flush === 'fails') assert.match(final.last_error ?? '', /flush: session-stop.sh exited 1/);
      if (flush === 'missing') assert.match(final.last_error ?? '', /not found/);
    });
  }
});

test('reaper: an expired lease ends the session too, and a heartbeat extends it', testOptions, async () => {
  await withSessions(async (h) => {
    const { cookie } = await approvedStudent(h, 'lease');
    const { id } = await json(await call(h, 'POST', '/v1/session', cookie));
    await h.orchestrator.idle();
    await h.context.pool.query("UPDATE student_sessions SET lease_expires_at = now() + interval '1 minute' WHERE id = $1", [id]);
    const beat = await call(h, 'POST', '/v1/session/heartbeat', cookie);
    assert.equal(beat.status, 200);
    assert.ok((await row(h, id)).lease_expires_at.getTime() > Date.now() + 14 * 60_000);
    await h.context.pool.query("UPDATE student_sessions SET lease_expires_at = now() - interval '1 second' WHERE id = $1", [id]);
    await new SessionReaper(h.orchestrator, h.context.pool, h.client).tick();
    await h.orchestrator.idle();
    const final = await row(h, id);
    assert.equal(final.state, 'ended');
    assert.equal(final.end_reason, 'lease_expired');
    assert.equal((await call(h, 'POST', '/v1/session/heartbeat', cookie)).status, 404);
  });
});

test('orphan sweep: deletes only unowned app:sef-session machines; the user box and other labels are untouched', testOptions, async () => {
  await withSessions(async (h) => {
    const userBox = h.fake.addForeignMachine({}, 'suspended');
    const otherApp = h.fake.addForeignMachine({ app: 'sef-seat' }, 'running');
    const golden = h.fake.addForeignMachine({ app: 'sef-golden' }, 'stopped');
    const orphan = h.fake.addForeignMachine({ app: 'sef-session', session: randomUUID() }, 'running');
    const { cookie } = await approvedStudent(h, 'owner');
    const { id } = await json(await call(h, 'POST', '/v1/session', cookie));
    await h.orchestrator.idle();
    const owned = (await row(h, id)).machine_id!;
    // A labelled machine whose live row has not recorded its id yet (mid-create) is kept too.
    const { acquireLease } = await import('./store');
    const { row: pending } = await acquireLease(h.context.pool, { id: 'pending-account', kind: 'user' }, { maxConcurrent: 3, idleMinutes: 15 });
    const inFlight = h.fake.addForeignMachine({ app: 'sef-session', session: pending.id }, 'creating');

    const deleted = await new SessionReaper(h.orchestrator, h.context.pool, h.client).sweepOrphans();
    assert.deepEqual(deleted, [orphan.id]);
    const touched = new Set(h.fake.seen.filter((r) => r.method !== 'GET' || /\/v1\/machines\/m_/.test(r.path)).map((r) => r.path.match(/m_[a-z0-9]{26}/)?.[0]));
    for (const untouched of [userBox.id, otherApp.id, golden.id, inFlight.id]) assert.equal(touched.has(untouched), false, `never touched ${untouched}`);
    assert.ok(h.fake.machines.has(owned));
    assert.equal(h.fake.requests('GET', '/v1/machines?')[0]!.path.includes('metadata=app%3Asef-session'), true);
  });
});

test('capacity: beyond SESSION_MAX_CONCURRENT a login is queued with an honest position, then promoted', testOptions, async () => {
  await withSessions(async (h) => {
    const a = await approvedStudent(h, 'qa');
    const b = await approvedStudent(h, 'qb');
    const c = await approvedStudent(h, 'qc');
    const sa = await json(await call(h, 'POST', '/v1/session', a.cookie));
    assert.equal(sa.state, 'spawning');
    const sb = await json(await call(h, 'POST', '/v1/session', b.cookie));
    const sc = await json(await call(h, 'POST', '/v1/session', c.cookie));
    assert.deepEqual([sb.state, sb.position], ['queued', 1]);
    assert.deepEqual([sc.state, sc.position], ['queued', 2]);
    assert.ok(sb.steps.every((s) => s.status === 'pending'));
    await h.orchestrator.idle();
    assert.equal(h.fake.created.length, 1, 'queued sessions make no machine');

    await call(h, 'DELETE', '/v1/session', a.cookie);
    await h.orchestrator.idle();
    assert.equal((await json(await call(h, 'GET', '/v1/session', b.cookie))).state, 'ready');
    const cNow = await json(await call(h, 'GET', '/v1/session', c.cookie));
    assert.deepEqual([cNow.state, cNow.position], ['queued', 1]);
    // Leaving the queue ends the lease without touching Instabox.
    const before = h.fake.seen.length;
    await call(h, 'DELETE', '/v1/session', c.cookie);
    assert.equal((await json(await call(h, 'GET', '/v1/session', c.cookie))).state, 'ended');
    assert.equal(h.fake.seen.length, before);
  }, { maxConcurrent: 1 });
});

test('auth: only approved students; one student cannot see or end another\'s session; staff list has no URL or token', testOptions, async () => {
  await withSessions(async (h) => {
    assert.equal((await h.context.app.request(`${h.context.origin}/v1/session`, { method: 'POST' })).status, 401);
    const applicant = await signUpVerified(h.context, `applicant-${randomUUID().slice(0, 6)}@example.test`, 'Applicant');
    const refused = await call(h, 'POST', '/v1/session', applicant);
    assert.equal(refused.status, 403);
    assert.equal((await json<{ error: string }>(refused)).error, 'unapproved');

    const a = await approvedStudent(h, 'alice');
    const b = await approvedStudent(h, 'bob');
    const sa = await json(await call(h, 'POST', '/v1/session', a.cookie));
    await h.orchestrator.idle();
    assert.equal((await call(h, 'GET', '/v1/session', b.cookie)).status, 404, 'bob sees nothing of alice');
    assert.equal((await call(h, 'DELETE', '/v1/session', b.cookie)).status, 404, 'bob cannot end alice\'s session');
    assert.equal((await call(h, 'POST', '/v1/session/heartbeat', b.cookie)).status, 404);
    assert.equal((await row(h, sa.id)).state, 'ready');
    // Students cannot use the staff routes, not even with an id.
    assert.equal((await call(h, 'GET', '/v1/admin/sessions', b.cookie)).status, 403);
    assert.equal((await call(h, 'POST', `/v1/admin/sessions/${sa.id}/end`, b.cookie)).status, 403);
    assert.equal((await row(h, sa.id)).state, 'ready');

    const staffCookie = await staff(h);
    const list = await call(h, 'GET', '/v1/admin/sessions', staffCookie);
    assert.equal(list.status, 200);
    const text = await list.text();
    const session = await row(h, sa.id);
    assert.ok(text.includes(sa.id));
    for (const secret of [session.url!, session.flush_token, session.create_idempotency_key]) assert.equal(text.includes(secret), false);
    const forced = await call(h, 'POST', `/v1/admin/sessions/${sa.id}/end`, staffCookie);
    assert.equal(forced.status, 202);
    await h.orchestrator.idle();
    assert.equal((await row(h, sa.id)).state, 'ended');
    assert.equal((await row(h, sa.id)).end_reason, 'staff_ended');
  });
});

test('legacy student tokens pin the session to account.id; disabled and admin-free tokens are refused', testOptions, async () => {
  await withSessions(async (h) => {
    const { keys } = await statics();
    const now = Math.floor(Date.now() / 1000);
    const token = (sub: string, role: 'student' | 'admin') =>
      signToken({ iss: 'Saint Elms University', sub, role, name: sub, email: `${sub}@saintelms.local`, cohortId: COHORT, stage: '', iat: now, exp: now + 3600 }, keys.privateKey);
    const status = await json(await call(h, 'POST', '/v1/session', token('ananya', 'student')));
    await h.orchestrator.idle();
    assert.equal((await row(h, status.id)).account_id, 'ananya');
    assert.equal((await row(h, status.id)).account_kind, 'legacy');
    assert.equal(sessionStartExecs(h)[0]!.body.envs.ENGINE_SEAT_OWNER, 'ananya');
    assert.equal((await call(h, 'POST', '/v1/session', token('gone', 'student'))).status, 403);
    assert.equal((await call(h, 'POST', '/v1/session', token('orphaned', 'student'))).status, 403, 'a cohort no longer in the release plan');
    assert.equal((await call(h, 'POST', '/v1/session', token('admin', 'admin'))).status, 403);
    // A legacy admin can list and end sessions.
    const list = await json<{ sessions: Array<{ id: string }> }>(await call(h, 'GET', '/v1/admin/sessions', token('admin', 'admin')));
    assert.deepEqual(list.sessions.map((s) => s.id), [status.id]);
  });
});

test('without the orchestrator the routes answer 503 after auth', testOptions, async () => {
  await withSessions(async (h) => {
    const { cookie } = await approvedStudent(h, 'off');
    h.deps.sessions = null;
    const off = await call(h, 'POST', '/v1/session', cookie);
    assert.equal(off.status, 503);
    assert.equal((await json<{ error: string }>(off)).error, 'session_orchestrator_unavailable');
  });
});
