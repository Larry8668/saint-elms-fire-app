import assert from 'node:assert/strict';
import { test } from 'node:test';
import { runSignalTick, startSignalScheduler, type OpenWorkspace } from './scheduler';

const open = (id: string, calls: string[], fail = false): OpenWorkspace => ({
  profile: { id },
  signals: {
    evaluate: async () => {
      calls.push(id);
      if (fail) throw new Error('disk full');
    },
  },
});

test('a tick evaluates every open workspace in order and one failure does not stop the rest', async () => {
  const calls: string[] = [];
  const result = await runSignalTick(async () => [open('a', calls, true), open('b', calls)]);
  assert.deepEqual(calls, ['a', 'b']);
  assert.deepEqual(result, { evaluated: 1, failed: 1 });
});

test('a failed enumeration is contained, not thrown', async () => {
  assert.deepEqual(
    await runSignalTick(async () => {
      throw new Error('registry unreadable');
    }),
    { evaluated: 0, failed: 0 },
  );
});

test('stop() ends the timer: no evaluations after it', async () => {
  const calls: string[] = [];
  const stop = startSignalScheduler(async () => [open('a', calls)], 5);
  stop();
  await new Promise((resolve) => setTimeout(resolve, 25));
  assert.deepEqual(calls, []);
});
