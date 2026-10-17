// The session lease against a disposable Postgres (PR-42a). Run only inside
// `pnpm --filter @sef/uni-server db:test:integration` (skipped without a database).

import assert from 'node:assert/strict';
import test from 'node:test';
import { testOptions, withAuthSchema } from '../testing/auth-fixture';
import { acquireLease, heartbeat, liveSession, promoteQueued, queuePosition, updateSession } from './store';

const opts = { maxConcurrent: 2, idleMinutes: 15 };

test('one live lease per account, however many callers race for it', testOptions, async () => {
  await withAuthSchema(async ({ pool }) => {
    const results = await Promise.all(Array.from({ length: 12 }, () => acquireLease(pool, { id: 'ananya', kind: 'legacy' }, opts)));
    assert.equal(new Set(results.map((r) => r.row.id)).size, 1);
    assert.equal(results.filter((r) => r.created).length, 1);
    const rows = await pool.query('SELECT state FROM student_sessions');
    assert.deepEqual(rows.rows, [{ state: 'spawning' }]);
  });
});

test('the database itself refuses a second live row for an account', testOptions, async () => {
  await withAuthSchema(async ({ pool }) => {
    const { row } = await acquireLease(pool, { id: 'ananya', kind: 'legacy' }, opts);
    await assert.rejects(
      pool.query(
        `INSERT INTO student_sessions (account_id, account_kind, state, machine_name, create_idempotency_key, flush_token, lease_expires_at)
         VALUES ('ananya', 'legacy', 'queued', 'sef-session-other', 'k', 't', now())`,
      ),
      (error: { code?: string }) => error.code === '23505',
    );
    // Once it ends, the account may hold a new lease.
    await updateSession(pool, row.id, { state: 'ended', ended_at: new Date() });
    const next = await acquireLease(pool, { id: 'ananya', kind: 'legacy' }, opts);
    assert.equal(next.created, true);
    assert.notEqual(next.row.id, row.id);
  });
});

test('capacity: beyond the cap new leases queue in arrival order and are promoted as slots free', testOptions, async () => {
  await withAuthSchema(async ({ pool }) => {
    const a = await acquireLease(pool, { id: 'a', kind: 'user' }, opts);
    const b = await acquireLease(pool, { id: 'b', kind: 'user' }, opts);
    const c = await acquireLease(pool, { id: 'c', kind: 'user' }, opts);
    const d = await acquireLease(pool, { id: 'd', kind: 'user' }, opts);
    assert.deepEqual([a, b, c, d].map((r) => r.row.state), ['spawning', 'spawning', 'queued', 'queued']);
    assert.equal(await queuePosition(pool, c.row), 1);
    assert.equal(await queuePosition(pool, d.row), 2);
    assert.deepEqual(await promoteQueued(pool, opts.maxConcurrent), []);
    // `stopping` still holds its machine (the final flush has not run): no slot yet.
    await updateSession(pool, a.row.id, { state: 'stopping' });
    assert.deepEqual(await promoteQueued(pool, opts.maxConcurrent), []);
    await updateSession(pool, a.row.id, { state: 'ended', ended_at: new Date() });
    assert.deepEqual(await promoteQueued(pool, opts.maxConcurrent), [c.row.id]);
    assert.equal(await queuePosition(pool, (await liveSession(pool, 'd'))!), 1);
    // A newcomer queues behind d even if a slot opens at the same moment.
    const e = await acquireLease(pool, { id: 'e', kind: 'user' }, opts);
    assert.equal(e.row.state, 'queued');
  });
});

test('a conditional update loses to a state change; heartbeat extends only a live, not-stopping lease', testOptions, async () => {
  await withAuthSchema(async ({ pool }) => {
    const { row } = await acquireLease(pool, { id: 'ananya', kind: 'legacy' }, opts);
    await pool.query("UPDATE student_sessions SET heartbeat_at = now() - interval '1 hour' WHERE id = $1", [row.id]);
    const beat = await heartbeat(pool, 'ananya', 15);
    assert.ok(beat && beat.heartbeat_at.getTime() > Date.now() - 60_000);
    assert.ok(beat.lease_expires_at.getTime() > Date.now() + 14 * 60_000);
    await updateSession(pool, row.id, { state: 'stopping' });
    assert.equal(await updateSession(pool, row.id, { step: 'start' }, ['spawning']), null);
    assert.equal(await heartbeat(pool, 'ananya', 15), null);
    assert.equal(await heartbeat(pool, 'nobody', 15), null);
  });
});
