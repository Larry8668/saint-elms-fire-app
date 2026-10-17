import assert from 'node:assert/strict';
import { test } from 'node:test';
import { SubjectLimits } from './limits';

const clock = (start: number) => {
  let now = start;
  return { now: () => now, advance: (ms: number) => (now += ms) };
};

test('the per-minute rate limit answers with the seconds left in the window', () => {
  const t = clock(Date.UTC(2026, 9, 17, 10, 0, 0));
  const limits = new SubjectLimits({ ratePerMinute: 2, maxConcurrent: 10, dailyTokenBudget: 1e9, now: t.now });
  for (let i = 0; i < 2; i++) {
    const a = limits.admit('s1');
    assert.ok(a.ok);
    a.release();
  }
  t.advance(20_000);
  assert.deepEqual(limits.admit('s1'), { ok: false, reason: 'rate', retryAfterSeconds: 40 });
  assert.ok(limits.admit('s2').ok, 'subjects are independent');
  t.advance(40_000);
  assert.ok(limits.admit('s1').ok, 'a new window admits again');
});

test('concurrent requests are capped per subject and released exactly once', () => {
  const limits = new SubjectLimits({ ratePerMinute: 100, maxConcurrent: 2, dailyTokenBudget: 1e9 });
  const a = limits.admit('s1');
  const b = limits.admit('s1');
  assert.ok(a.ok && b.ok);
  assert.deepEqual(limits.admit('s1'), { ok: false, reason: 'concurrency', retryAfterSeconds: 1 });
  a.release();
  a.release();
  const c = limits.admit('s1');
  assert.ok(c.ok);
  assert.equal(limits.admit('s1').ok, false, 'a double release did not free two slots');
});

test('the daily token budget blocks until UTC midnight, then resets', () => {
  const t = clock(Date.UTC(2026, 9, 17, 23, 0, 0));
  const limits = new SubjectLimits({ ratePerMinute: 100, maxConcurrent: 10, dailyTokenBudget: 1000, now: t.now });
  const a = limits.admit('s1');
  assert.ok(a.ok);
  limits.record('s1', 1200);
  a.release();
  assert.deepEqual(limits.admit('s1'), { ok: false, reason: 'budget', retryAfterSeconds: 3600 });
  assert.equal(limits.snapshot()[0].tokensToday, 1200);
  t.advance(3600_000);
  assert.ok(limits.admit('s1').ok);
  assert.equal(limits.snapshot()[0].tokensToday, 0);
});

test('idle subjects from earlier days are forgotten at the day rollover', () => {
  const t = clock(Date.UTC(2026, 9, 17, 12));
  const limits = new SubjectLimits({ ratePerMinute: 100, maxConcurrent: 10, dailyTokenBudget: 1e9, now: t.now });
  const idle = limits.admit('idle');
  assert.ok(idle.ok);
  idle.release();
  assert.ok(limits.admit('streaming').ok, 'held open across midnight');
  t.advance(24 * 3600_000);
  limits.admit('today');
  assert.deepEqual(limits.snapshot().map((s) => s.sub).sort(), ['streaming', 'today']);
});
