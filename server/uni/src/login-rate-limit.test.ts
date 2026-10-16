import assert from 'node:assert/strict';
import test from 'node:test';
import { createFixedWindowLimiter, logFingerprint } from './login-rate-limit';

test('a fixed window allows `max` attempts per key, then refuses until it resets', () => {
  let at = 1_000_000;
  const limiter = createFixedWindowLimiter({ windowMs: 60_000, max: 3, now: () => at });
  assert.equal(limiter.allow('ip-a'), true);
  assert.equal(limiter.allow('ip-a'), true);
  assert.equal(limiter.allow('ip-a'), true);
  assert.equal(limiter.allow('ip-a'), false, 'the fourth attempt inside the window is refused');
  assert.equal(limiter.allow('ip-b'), true, 'limits are per client key');
  at += 60_001;
  assert.equal(limiter.allow('ip-a'), true, 'a fresh window reopens the allowance');
});

test('refused attempts still count, so hammering cannot ride the window edge', () => {
  let at = 0;
  const limiter = createFixedWindowLimiter({ windowMs: 1_000, max: 1, now: () => at });
  assert.equal(limiter.allow('ip'), true);
  for (let i = 0; i < 50; i += 1) assert.equal(limiter.allow('ip'), false);
  at += 999;
  assert.equal(limiter.allow('ip'), false, 'still inside the original window');
  at += 2;
  assert.equal(limiter.allow('ip'), true);
});

test('log fingerprints are stable, truncated and non-reversible-looking', () => {
  const one = logFingerprint('ada@example.test');
  assert.equal(one, logFingerprint('ada@example.test'));
  assert.match(one, /^[0-9a-f]{16}$/);
  assert.notEqual(one, logFingerprint('grace@example.test'));
  assert.ok(!one.includes('ada'));
});
