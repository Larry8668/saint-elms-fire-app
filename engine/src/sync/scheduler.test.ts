import assert from 'node:assert/strict';
import { test } from 'node:test';
import { PushScheduler, type Timers } from './scheduler';

/** A manual clock: timers fire only when the test advances time. */
function fakeClock() {
  let now = 0;
  let nextId = 1;
  const timers = new Map<number, { at: number; fn: () => void; every?: number }>();
  const api: Timers = {
    setTimeout: (fn, ms) => {
      const id = nextId++;
      timers.set(id, { at: now + ms, fn });
      return id;
    },
    clearTimeout: (id) => void timers.delete(id as number),
    setInterval: (fn, ms) => {
      const id = nextId++;
      timers.set(id, { at: now + ms, fn, every: ms });
      return id;
    },
    clearInterval: (id) => void timers.delete(id as number),
  };
  const advance = async (ms: number) => {
    const target = now + ms;
    for (;;) {
      const due = [...timers.entries()].filter(([, t]) => t.at <= target).sort(([, a], [, b]) => a.at - b.at)[0];
      if (!due) break;
      const [id, timer] = due;
      now = timer.at;
      if (timer.every) timer.at += timer.every;
      else timers.delete(id);
      timer.fn();
      await new Promise((resolve) => setImmediate(resolve));
    }
    now = target;
    await new Promise((resolve) => setImmediate(resolve));
  };
  return { timers: api, now: () => now, advance };
}

test('writes in a burst push once, after the quiet period', async () => {
  const clock = fakeClock();
  let pushes = 0;
  const scheduler = new PushScheduler(async () => ++pushes, { debounceMs: 7_000, maxWaitMs: 30_000, periodicMs: 60_000, timers: clock.timers, now: clock.now });
  scheduler.start();
  scheduler.markDirty();
  await clock.advance(3_000);
  scheduler.markDirty();
  await clock.advance(6_000);
  assert.equal(pushes, 0, 'the second write restarted the debounce');
  await clock.advance(1_000);
  assert.equal(pushes, 1);
  await clock.advance(20_000);
  assert.equal(pushes, 1, 'nothing more without a write');
  scheduler.stop();
});

test('a steady stream of writes still pushes by the max wait, and the periodic tick pushes anyway', async () => {
  const clock = fakeClock();
  const at: number[] = [];
  const scheduler = new PushScheduler(async () => at.push(clock.now()), { debounceMs: 7_000, maxWaitMs: 30_000, periodicMs: 60_000, timers: clock.timers, now: clock.now });
  scheduler.start();
  for (let t = 0; t < 40_000; t += 5_000) {
    scheduler.markDirty();
    await clock.advance(5_000);
  }
  assert.equal(at[0], 30_000, 'capped at maxWait from the first write');
  await clock.advance(60_000);
  assert.ok(at.includes(60_000), 'the safety tick ran at 60 s');
  scheduler.stop();
});

test('pushes never overlap: callers during a push share exactly one follow-up', async () => {
  const clock = fakeClock();
  let running = 0;
  let maxRunning = 0;
  let pushes = 0;
  const releases: Array<() => void> = [];
  const scheduler = new PushScheduler(
    () =>
      new Promise<number>((resolve) => {
        running += 1;
        maxRunning = Math.max(maxRunning, running);
        const n = ++pushes;
        releases.push(() => {
          running -= 1;
          resolve(n);
        });
      }),
    { timers: clock.timers, now: clock.now },
  );
  const first = scheduler.run();
  const a = scheduler.run();
  const b = scheduler.run();
  scheduler.markDirty();
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(pushes, 1);
  releases.shift()!();
  assert.equal(await first, 1);
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(pushes, 2, 'one coalesced follow-up');
  releases.shift()!();
  assert.deepEqual([await a, await b], [2, 2], 'both waiters get the follow-up, which saw their writes');
  assert.equal(maxRunning, 1);
  assert.equal(scheduler.pending, false);
});

test('a failed push does not wedge the queue', async () => {
  let calls = 0;
  const scheduler = new PushScheduler(async () => {
    calls += 1;
    if (calls === 1) throw new Error('store down');
    return calls;
  });
  await assert.rejects(scheduler.run(), /store down/);
  assert.equal(await scheduler.run(), 2);
});
