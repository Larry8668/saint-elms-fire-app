import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { Pool } from 'pg';
import type { AccountAuth } from './account-auth';
import { createApp } from './app';
import { config } from './config';
import type { UniDeps } from './deps';

/**
 * The readiness surface itself: `/health` is liveness only, `/ready` must answer 503
 * whenever a promised dependency is absent — a healthy-but-unaccountable server is how
 * a broken deployment hides behind a balancer.
 */
const minDeps = (over: Partial<UniDeps> = {}): UniDeps =>
  ({
    courseware: { programmeId: 'p', programmeName: 'P', courses: new Map(), skipped: [] },
    releases: {},
    keys: { publicKeyPem: 'test-key' },
    shares: {},
    accounts: {},
    audit: {},
    dispersal: {},
    ...over,
  }) as unknown as UniDeps;

test('/health stays liveness while /ready fails closed without account auth', async () => {
  const app = createApp(minDeps());
  const health = await app.request('/health');
  assert.equal(health.status, 200);

  const ready = await app.request('/ready');
  assert.equal(ready.status, 503);
  const body = (await ready.json()) as { ok: boolean; checks: Record<string, boolean> };
  assert.equal(body.ok, false);
  assert.equal(body.checks.accountAuth, false);
});

test('/ready is 200 only when account auth is mounted and the database answers', async () => {
  const answering = { query: async () => ({ rows: [] }) } as unknown as Pool;
  const auth = {} as AccountAuth;
  const ok = await createApp(minDeps({ pool: answering, accountAuth: auth })).request('/ready');
  assert.equal(ok.status, 200);
  assert.deepEqual(((await ok.json()) as { checks: Record<string, boolean> }).checks, { accountAuth: true, database: true });

  const dead = { query: async () => Promise.reject(new Error('db down')) } as unknown as Pool;
  const down = await createApp(minDeps({ pool: dead, accountAuth: auth })).request('/ready');
  assert.equal(down.status, 503);
  const body = (await down.json()) as { checks: Record<string, boolean> };
  assert.equal(body.checks.accountAuth, true);
  assert.equal(body.checks.database, false);
});

test('the legacy login carries the same 64KB body cap as every auth path', async () => {
  const app = createApp(minDeps());
  const oversized = await app.request('/v1/auth/login', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ email: 'a@b.test', password: `x${'y'.repeat(70 * 1024)}` }),
  });
  assert.equal(oversized.status, 413);
});

test('onError keeps internals out of client responses on non-auth paths too', async () => {
  const app = createApp(
    minDeps({
      releases: {
        cohorts: () => {
          throw new Error('relation "cohorts" does not exist for role sef with password hunter2');
        },
      } as unknown as UniDeps['releases'],
    }),
  );
  const res = await app.request('/v1/cohorts');
  assert.equal(res.status, 500);
  const body = (await res.json()) as Record<string, unknown>;
  assert.deepEqual(body, { error: 'internal_error' });
  assert.ok(!JSON.stringify(body).includes('hunter2'), 'database internals stay server-side');
});

test('/health says whether demo students are seeded, and nothing about their password', async () => {
  const body = (await (await createApp(minDeps()).request('/health')).json()) as Record<string, unknown>;
  assert.equal(body.demo, config.seedDemo);
  assert.equal(JSON.stringify(body).includes(config.demoPassword), false);
});
