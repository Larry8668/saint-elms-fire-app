import assert from 'node:assert/strict';
import { test } from 'node:test';
import { Hono } from 'hono';
import { limiterKey, rateLimit, SlidingWindowLimiter } from './rate-limit';

const clock = (start = 1_000_000) => {
  let now = start;
  return { now: () => now, advance: (ms: number) => void (now += ms) };
};

test('the sixth attempt inside the window is refused with the seconds until a slot frees', () => {
  const time = clock();
  const limiter = new SlidingWindowLimiter({ limit: 5, windowMs: 60_000, now: time.now });
  for (let i = 0; i < 5; i += 1) {
    assert.equal(limiter.attempt('1.2.3.4').ok, true);
    time.advance(1_000);
  }
  const refused = limiter.attempt('1.2.3.4');
  assert.equal(refused.ok, false);
  // The first attempt was 5 s ago; it leaves the window in 55 s.
  assert.equal(!refused.ok && refused.retryAfterSeconds, 55);
});

test('the window slides: the oldest attempt ageing out frees exactly one slot', () => {
  const time = clock();
  const limiter = new SlidingWindowLimiter({ limit: 2, windowMs: 10_000, now: time.now });
  limiter.attempt('a');
  time.advance(4_000);
  limiter.attempt('a');
  assert.equal(limiter.attempt('a').ok, false);
  time.advance(6_000); // first attempt is now exactly 10 s old
  assert.equal(limiter.attempt('a').ok, true);
  assert.equal(limiter.attempt('a').ok, false, 'the second attempt is still inside the window');
  time.advance(4_000);
  assert.equal(limiter.attempt('a').ok, true);
});

test('clients are isolated from each other', () => {
  const time = clock();
  const limiter = new SlidingWindowLimiter({ limit: 1, windowMs: 60_000, now: time.now });
  assert.equal(limiter.attempt('attacker').ok, true);
  assert.equal(limiter.attempt('attacker').ok, false);
  assert.equal(limiter.attempt('student').ok, true, 'one client exhausting its budget never blocks another');
});

test('a released attempt is refunded', () => {
  const time = clock();
  const limiter = new SlidingWindowLimiter({ limit: 1, windowMs: 60_000, now: time.now });
  const first = limiter.attempt('a');
  assert.ok(first.ok);
  first.release();
  assert.equal(limiter.attempt('a').ok, true);
});

test('memory stays bounded: idle keys go first, then the least recently seen', () => {
  const time = clock();
  const limiter = new SlidingWindowLimiter({ limit: 3, windowMs: 1_000, maxKeys: 100, now: time.now });
  for (let i = 0; i < 1_000; i += 1) limiter.attempt(`spray-${i}`);
  assert.ok(limiter.size <= 100, `tracked ${limiter.size} keys`);

  // A key seen recently survives a flood of newcomers that are still inside the window.
  const bounded = new SlidingWindowLimiter({ limit: 3, windowMs: 60_000, maxKeys: 3, now: time.now });
  bounded.attempt('old');
  bounded.attempt('kept');
  bounded.attempt('x');
  bounded.attempt('kept');
  bounded.attempt('y');
  assert.equal(bounded.size, 3);
  bounded.attempt('kept');
  bounded.attempt('kept');
  assert.equal(bounded.attempt('kept').ok, false, 'the recently seen key kept its history; old was evicted instead');
});

test('the middleware answers 429 with retryAfter and a Retry-After header; successes are refunded', async () => {
  const limiter = new SlidingWindowLimiter({ limit: 2, windowMs: 60_000 });
  const app = new Hono();
  app.post('/login', rateLimit(limiter, { client: () => '203.0.113.1' }, true), (c) => (c.req.header('x-ok') ? c.json({ ok: true }) : c.json({ error: 'no' }, 401)));
  for (let i = 0; i < 5; i += 1) assert.equal((await app.request('/login', { method: 'POST', headers: { 'x-ok': '1' } })).status, 200);
  assert.equal((await app.request('/login', { method: 'POST' })).status, 401);
  assert.equal((await app.request('/login', { method: 'POST' })).status, 401);
  const limited = await app.request('/login', { method: 'POST' });
  assert.equal(limited.status, 429);
  const body = (await limited.json()) as { code: string; retryAfter: number };
  assert.equal(body.code, 'rate_limited');
  assert.ok(body.retryAfter >= 1 && body.retryAfter <= 60);
  assert.equal(limited.headers.get('retry-after'), String(body.retryAfter));
});

test('IPv6 clients share a bucket per /64; IPv4 and non-addresses are keyed as they are', () => {
  const key = limiterKey('2001:db8:1:2:aaaa::1');
  assert.equal(key, '2001:db8:1:2::/64');
  for (const same of ['2001:db8:1:2::1', '2001:DB8:1:2:ffff:ffff:ffff:ffff', '2001:0db8:0001:0002::', '2001:db8:1:2::9%en0']) {
    assert.equal(limiterKey(same), key, same);
  }
  assert.notEqual(limiterKey('2001:db8:1:3::1'), key, 'the neighbouring /64');
  assert.equal(limiterKey('::1'), '0:0:0:0::/64');
  assert.equal(limiterKey('64:ff9b::198.51.100.7'), '64:ff9b:0:0::/64', 'an embedded dotted quad parses');
  assert.equal(limiterKey('::ffff:198.51.100.7'), '198.51.100.7', 'IPv4-mapped is the IPv4 client');
  assert.equal(limiterKey('198.51.100.7'), '198.51.100.7');
  assert.equal(limiterKey('local'), 'local');
  assert.equal(limiterKey('engine'), 'engine');
});
