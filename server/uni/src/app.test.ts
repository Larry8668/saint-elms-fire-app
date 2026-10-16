import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { Pool } from 'pg';
import type { AccountAuth } from './account-auth';
import { createApp } from './app';
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
