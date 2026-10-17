import assert from 'node:assert/strict';
import { test } from 'node:test';
import { HEARTBEAT_MS, startHeartbeat, type BeatOutcome } from './heartbeat';

/** Fake timers and visibility: `advance` runs due timers in order. */
function harness(outcomes: BeatOutcome[] = ['ok']) {
  let clock = 0;
  let visible = true;
  let seq = 0;
  const timers = new Map<number, { at: number; run: () => void }>();
  const listeners = new Set<() => void>();
  const beats: number[] = [];
  let ended = 0;
  const stop = startHeartbeat({
    beat: async () => {
      beats.push(clock);
      return outcomes.length > 1 ? outcomes.shift()! : outcomes[0]!;
    },
    visible: () => visible,
    onVisibilityChange: (l) => {
      listeners.add(l);
      return () => listeners.delete(l);
    },
    setTimer: (run, ms) => {
      seq += 1;
      timers.set(seq, { at: clock + ms, run });
      return seq;
    },
    clearTimer: (h) => void timers.delete(h as number),
    now: () => clock,
    onEnded: () => void (ended += 1),
  });
  const flush = () => new Promise((resolve) => setImmediate(resolve));
  const advance = async (ms: number) => {
    const target = clock + ms;
    for (;;) {
      const due = [...timers.entries()].filter(([, t]) => t.at <= target).sort((a, b) => a[1].at - b[1].at)[0];
      if (!due) break;
      timers.delete(due[0]);
      clock = due[1].at;
      due[1].run();
      await flush();
    }
    clock = target;
  };
  const setVisible = async (v: boolean) => {
    visible = v;
    for (const l of listeners) l();
    await flush();
  };
  return { advance, setVisible, beats, stop, pending: () => timers.size, ended: () => ended, listeners };
}

test('beats at once, then about every minute while the tab is visible', async () => {
  const h = harness();
  await h.advance(0);
  await h.advance(HEARTBEAT_MS * 3);
  assert.deepEqual(h.beats, [0, HEARTBEAT_MS, HEARTBEAT_MS * 2, HEARTBEAT_MS * 3]);
  h.stop();
});

test('a hidden tab sends nothing; coming back beats at once if one is due', async () => {
  const h = harness();
  await h.advance(0);
  await h.advance(10_000);
  await h.setVisible(false);
  assert.equal(h.pending(), 0, 'no timer runs while hidden');
  await h.advance(10 * HEARTBEAT_MS);
  assert.deepEqual(h.beats, [0]);
  await h.setVisible(true);
  await h.advance(0);
  assert.deepEqual(h.beats, [0, 10_000 + 10 * HEARTBEAT_MS]);
  h.stop();
});

test('a quick hide-and-show does not beat early', async () => {
  const h = harness();
  await h.advance(0);
  await h.advance(20_000);
  await h.setVisible(false);
  await h.setVisible(true);
  await h.advance(39_999);
  assert.deepEqual(h.beats, [0]);
  await h.advance(1);
  assert.deepEqual(h.beats, [0, HEARTBEAT_MS]);
  h.stop();
});

test('a failed beat is retried on the next tick; an ended session stops everything', async () => {
  const h = harness(['retry', 'ok', 'ended']);
  await h.advance(0);
  await h.advance(HEARTBEAT_MS * 5);
  assert.deepEqual(h.beats, [0, HEARTBEAT_MS, HEARTBEAT_MS * 2]);
  assert.equal(h.ended(), 1);
  assert.equal(h.pending(), 0);
  assert.equal(h.listeners.size, 0, 'the visibility listener is removed');
});

test('stop() cancels the next beat', async () => {
  const h = harness();
  await h.advance(0);
  h.stop();
  await h.advance(HEARTBEAT_MS * 2);
  assert.deepEqual(h.beats, [0]);
});

test('only the university saying the session is over stops the heartbeat; anything else is retried', async () => {
  const { beatOutcomeOf } = await import('./heartbeat');
  const { EngineError } = await import('@/lib/api');
  assert.equal(beatOutcomeOf(new EngineError('ended', 410, 'workspace_ended')), 'ended');
  assert.equal(beatOutcomeOf(new EngineError('down', 502, 'uni_unreachable')), 'retry');
  assert.equal(beatOutcomeOf(new EngineError('expired', 403, 'uni_session_expired')), 'retry');
  assert.equal(beatOutcomeOf(new TypeError('fetch failed')), 'retry');
});
