import assert from 'node:assert/strict';
import { test } from 'node:test';
import { startSignalScheduler, type OpenWorkspace } from './scheduler';

const open = (id: string, calls: string[], fail = false): OpenWorkspace => ({
  profile: { id },
  signals: {
    evaluate: async () => {
      calls.push(id);
      if (fail) throw new Error('disk full');
    },
  } as never,
});

test('each tick evaluates every open workspace, one failure does not stop the rest, and stop() ends it', async () => {
  const calls: string[] = [];
  const stop = startSignalScheduler(async () => [open('a', calls, true), open('b', calls)], 10);
  await new Promise((resolve) => setTimeout(resolve, 35));
  stop();
  const settled = calls.length;
  assert.ok(settled >= 4, `expected at least two ticks, saw ${settled} evaluations`);
  assert.deepEqual(calls.slice(0, 2), ['a', 'b']);
  await new Promise((resolve) => setTimeout(resolve, 30));
  assert.equal(calls.length, settled, 'no ticks after stop');
});
