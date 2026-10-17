import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createSeatWaker, edgeCause, WAKE_WINDOW_MS, wakeNoticeOf, type WakeState } from './seat-wake';

/** A fake clock: `sleep` advances time instantly and records each wait. */
function harness(answers: number[] | ((call: number) => number)) {
  let clock = 1_000;
  const sleeps: number[] = [];
  const probed: string[] = [];
  const states: WakeState['phase'][] = [];
  const waker = createSeatWaker({
    probe: async (base) => {
      probed.push(base);
      const call = probed.length - 1;
      return typeof answers === 'function' ? answers(call) : (answers[call] ?? answers.at(-1)!);
    },
    sleep: async (ms) => {
      sleeps.push(ms);
      clock += ms;
    },
    now: () => clock,
  });
  waker.subscribe(() => states.push(waker.state.phase));
  return { waker, sleeps, probed, states, advance: (ms: number) => (clock += ms) };
}

const res = (status: number, contentType = 'text/plain') => ({ status, headers: new Headers({ 'content-type': contentType }) });

test('only the edge answering 502/503 means "wake the seat"; an engine refusal is JSON and is not', () => {
  assert.equal(edgeCause(res(502)), 'starting');
  assert.equal(edgeCause(res(503, 'text/html; charset=utf-8')), 'offline');
  assert.equal(edgeCause(res(503, 'application/json')), null, 'the engine says 503 when the uni is unreachable');
  assert.equal(edgeCause(res(502, 'application/json; charset=utf-8')), null);
  assert.equal(edgeCause(res(200)), null);
  assert.equal(edgeCause(res(500)), null);
});

test('a sleeping seat is polled with backoff until health answers, then the caller proceeds', async () => {
  const h = harness([0, 0, 502, 200]);
  assert.equal(await h.waker.wake('https://seat.test', 'network'), 'ready');
  assert.deepEqual(h.sleeps, [500, 1_000, 2_000, 3_000]);
  assert.deepEqual(h.probed, Array(4).fill('https://seat.test'));
  assert.equal(h.waker.state.phase, 'idle');
  assert.deepEqual(h.states, ['waking', 'waking', 'idle'], 'the 502 shows as "engine starting" before it is ready');
});

test('concurrent failed calls share one poll loop', async () => {
  const h = harness([0, 200]);
  const all = await Promise.all([h.waker.wake('https://seat.test', 'network'), h.waker.wake('https://seat.test', 'network'), h.waker.wake('https://seat.test', 'starting')]);
  assert.deepEqual(all, ['ready', 'ready', 'ready']);
  assert.equal(h.probed.length, 2);
});

test('a seat that never answers gives up after about a minute, as unreachable', async () => {
  const h = harness([0]);
  assert.equal(await h.waker.wake('https://seat.test', 'network'), 'network');
  const waited = h.sleeps.reduce((a, b) => a + b, 0);
  assert.ok(waited >= WAKE_WINDOW_MS && waited < WAKE_WINDOW_MS + 5_000, `waited ${waited} ms`);
  assert.ok(h.sleeps.every((ms) => ms <= 5_000), 'the backoff is capped');
  assert.deepEqual(h.waker.state, { phase: 'unreachable', cause: 'network' });
  assert.equal(wakeNoticeOf(h.waker.state), 'unreachable');
});

test('an offline box (503) is reported as offline: requests alone never bring it back', async () => {
  const h = harness([503]);
  const waiting = h.waker.wake('https://seat.test', 'offline');
  await Promise.resolve();
  assert.equal(wakeNoticeOf(h.waker.state), 'offline');
  assert.equal(await waiting, 'offline');
  assert.deepEqual(h.waker.state, { phase: 'unreachable', cause: 'offline' });
  assert.equal(wakeNoticeOf(h.waker.state), 'offline');
});

test('a call that succeeds on its own clears an old unreachable notice', async () => {
  const h = harness([0]);
  await h.waker.wake('https://seat.test', 'network');
  assert.equal(h.waker.state.phase, 'unreachable');
  h.waker.settle();
  assert.equal(h.waker.state.phase, 'idle');
  const count = h.states.length;
  h.waker.settle();
  assert.equal(h.states.length, count, 'settling an idle waker notifies no one');
});

test('a probe that throws counts as no answer', async () => {
  let calls = 0;
  const waker = createSeatWaker({
    probe: async () => {
      calls += 1;
      if (calls === 1) throw new Error('aborted');
      return 200;
    },
    sleep: async () => {},
    now: () => 0,
  });
  assert.equal(await waker.wake('https://seat.test', 'network'), 'ready');
  assert.equal(calls, 2);
});

test('the notice is silent while idle unless a call already failed', () => {
  assert.equal(wakeNoticeOf({ phase: 'idle' }), null);
  assert.equal(wakeNoticeOf({ phase: 'idle' }, true), 'unreachable');
  assert.equal(wakeNoticeOf({ phase: 'waking', cause: 'network', since: 0 }), 'waking');
  assert.equal(wakeNoticeOf({ phase: 'waking', cause: 'starting', since: 0 }), 'starting');
});
