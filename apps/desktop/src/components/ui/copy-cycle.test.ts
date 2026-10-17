import assert from 'node:assert/strict';
import { afterEach, beforeEach, mock, test } from 'node:test';
import { CONNECTING_LINES, COPY_CYCLE_MS, startCopyCycle } from './copy-cycle';

beforeEach(() => mock.timers.enable({ apis: ['setInterval'] }));
afterEach(() => mock.timers.reset());

test('the lines advance in order every 2.5 s and wrap to the start', () => {
  const seen: number[] = [];
  const stop = startCopyCycle({ count: CONNECTING_LINES.length, onChange: (i) => seen.push(i) });
  mock.timers.tick(COPY_CYCLE_MS - 1);
  assert.deepEqual(seen, [], 'nothing changes before the first interval');
  mock.timers.tick(1);
  assert.deepEqual(seen, [1]);
  mock.timers.tick(COPY_CYCLE_MS * 5);
  assert.deepEqual(seen, [1, 2, 3, 4, 0, 1]);
  stop();
  mock.timers.tick(COPY_CYCLE_MS * 3);
  assert.equal(seen.length, 6, 'stopping clears the timer');
});

test('the copy reads as connecting, in the agreed order', () => {
  assert.equal(COPY_CYCLE_MS, 2_500);
  assert.deepEqual(CONNECTING_LINES, [
    'Establishing a connection with your data…',
    'Waking your workspace…',
    'Restoring your notes…',
    'Warming up your teachers…',
    'Almost there…',
  ]);
});

test('reduced motion holds the first line', () => {
  const seen: number[] = [];
  startCopyCycle({ count: CONNECTING_LINES.length, onChange: (i) => seen.push(i), reducedMotion: true });
  mock.timers.tick(COPY_CYCLE_MS * 10);
  assert.deepEqual(seen, []);
});

test('a single line never cycles', () => {
  const seen: number[] = [];
  startCopyCycle({ count: 1, onChange: (i) => seen.push(i) });
  mock.timers.tick(COPY_CYCLE_MS * 4);
  assert.deepEqual(seen, []);
});
