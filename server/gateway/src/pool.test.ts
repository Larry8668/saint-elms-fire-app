import assert from 'node:assert/strict';
import { test } from 'node:test';
import { parseUpstreams } from './config';
import { UpstreamPool } from './pool';

const specs = (n: number, max = 2) => Array.from({ length: n }, (_, i) => ({ url: `http://w${i}`, kind: 'ollama' as const, maxInFlight: max }));

test('GATEWAY_UPSTREAMS parses kinds and per-upstream limits', () => {
  assert.deepEqual(parseUpstreams('http://a:11434/, vllm:https://b:8000#max=16', 4), [
    { url: 'http://a:11434', kind: 'ollama', maxInFlight: 4 },
    { url: 'https://b:8000', kind: 'vllm', maxInFlight: 16 },
  ]);
  assert.throws(() => parseUpstreams('ftp://x', 1));
});

test('least-in-flight selection spreads load and respects per-upstream limits', () => {
  const pool = new UpstreamPool(specs(2), { failureThreshold: 3, cooldownMs: 1000 });
  const picks = Array.from({ length: 4 }, () => {
    const r = pool.tryAcquire('any');
    assert.ok(r.ok);
    return r.upstream.id;
  });
  assert.deepEqual(picks.sort(), ['u1', 'u1', 'u2', 'u2']);
  assert.deepEqual(pool.tryAcquire('any'), { ok: false, reason: 'busy' });
  pool.release(pool.upstreams[1], 'ok');
  const next = pool.tryAcquire('any');
  assert.ok(next.ok && next.upstream.id === 'u2', 'the freed worker is chosen');
});

test('kind filtering keeps the Ollama native API off vLLM workers', () => {
  const pool = new UpstreamPool([{ url: 'http://v', kind: 'vllm', maxInFlight: 1 }], { failureThreshold: 3, cooldownMs: 1000 });
  assert.deepEqual(pool.tryAcquire('ollama'), { ok: false, reason: 'unhealthy' });
  assert.ok(pool.tryAcquire('any').ok);
});

test('the circuit opens after consecutive failures, skips the worker, then half-opens for one trial', () => {
  let now = 0;
  const pool = new UpstreamPool(specs(2, 10), { failureThreshold: 2, cooldownMs: 1000, now: () => now });
  const [u1] = pool.upstreams;
  pool.markFailure(u1);
  assert.ok(pool.admits(u1), 'one failure is under the threshold');
  pool.markFailure(u1);
  assert.equal(pool.admits(u1), false);
  for (let i = 0; i < 3; i++) {
    const r = pool.tryAcquire('any');
    assert.ok(r.ok && r.upstream.id === 'u2', 'traffic skips the open circuit');
  }
  now = 1000;
  assert.ok(pool.admits(u1), 'half-open after the cooldown');
  u1.inFlight = 1;
  assert.equal(pool.admits(u1), false, 'only one trial request while half-open');
  pool.release(u1, 'failed');
  assert.equal(pool.admits(u1), false, 'a failed trial re-opens the circuit');
  now = 2000;
  u1.inFlight = 1;
  pool.release(u1, 'ok');
  assert.ok(pool.admits(u1) && u1.openUntil === 0, 'a good trial closes it');
});

test('a passing probe closes the circuit only after the cooldown', () => {
  let now = 0;
  const pool = new UpstreamPool(specs(1), { failureThreshold: 1, cooldownMs: 1000, now: () => now });
  const [u1] = pool.upstreams;
  pool.markFailure(u1, { trip: true });
  pool.probeOk(u1);
  assert.notEqual(u1.openUntil, 0);
  now = 1000;
  pool.probeOk(u1);
  assert.equal(u1.openUntil, 0);
});

test('acquire waits for capacity, then gives up after the queue timeout', async () => {
  const pool = new UpstreamPool(specs(1, 1), { failureThreshold: 3, cooldownMs: 1000 });
  const first = pool.tryAcquire('any');
  assert.ok(first.ok);
  const waiting = pool.acquire('any', 2000);
  setTimeout(() => pool.release(first.upstream, 'ok'), 30);
  assert.ok((await waiting).ok);
  const started = Date.now();
  assert.deepEqual(await pool.acquire('any', 50), { ok: false, reason: 'busy' });
  assert.ok(Date.now() - started >= 45);
});
