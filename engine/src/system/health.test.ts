import assert from 'node:assert/strict';
import { test } from 'node:test';
import { cachedReachability } from './health';

test('reachability is cached per url for the TTL and concurrent callers share one probe', async () => {
  let calls = 0;
  let clock = 0;
  let up = true;
  const probe = async () => {
    calls++;
    return up;
  };
  const check = cachedReachability(probe, 20_000, () => clock);

  const burst = await Promise.all(Array.from({ length: 50 }, () => check('http://uni')));
  assert.ok(burst.every((v) => v === true));
  assert.equal(calls, 1);

  up = false;
  clock = 19_999;
  assert.equal(await check('http://uni'), true, 'still cached');
  assert.equal(calls, 1);

  clock = 20_001;
  assert.equal(await check('http://uni'), false, 'expired: re-probed');
  assert.equal(calls, 2);

  await check('http://other');
  assert.equal(calls, 3, 'keyed by url');
});

test('a throwing probe reads as unreachable', async () => {
  const check = cachedReachability(async () => { throw new Error('boom'); });
  assert.equal(await check('x'), false);
});
