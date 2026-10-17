import type { UpstreamKind, UpstreamSpec } from './config';

export interface Upstream extends UpstreamSpec {
  id: string;
  inFlight: number;
  consecutiveFailures: number;
  /** Circuit open until this time (ms). 0 = closed. After it passes the circuit is half-open. */
  openUntil: number;
  served: number;
  failed: number;
}

export interface PoolOptions {
  failureThreshold: number;
  cooldownMs: number;
  now?: () => number;
}

export type AcquireResult = { ok: true; upstream: Upstream } | { ok: false; reason: 'unhealthy' | 'busy' };

/**
 * The GPU worker pool. Least-in-flight selection over the workers whose circuit admits a
 * request and that are under their own concurrency limit; ties rotate so idle workers share
 * the load. A worker that fails `failureThreshold` times in a row (or fails a health probe)
 * is skipped for `cooldownMs`, then admits exactly one trial request (half-open).
 */
export class UpstreamPool {
  readonly upstreams: Upstream[];
  private rotor = 0;
  private waiters: Array<() => void> = [];
  private readonly now: () => number;

  constructor(
    specs: UpstreamSpec[],
    private readonly opts: PoolOptions,
  ) {
    this.now = opts.now ?? Date.now;
    this.upstreams = specs.map((spec, index) => ({ ...spec, id: `u${index + 1}`, inFlight: 0, consecutiveFailures: 0, openUntil: 0, served: 0, failed: 0 }));
  }

  /** Healthy = circuit closed, or half-open and not already running its trial request. */
  admits(u: Upstream): boolean {
    if (u.openUntil === 0) return true;
    return this.now() >= u.openUntil && u.inFlight === 0;
  }

  private candidates(kind: UpstreamKind | 'any', exclude: Set<string>) {
    return this.upstreams.filter((u) => !exclude.has(u.id) && (kind === 'any' || u.kind === kind) && this.admits(u));
  }

  tryAcquire(kind: UpstreamKind | 'any', exclude = new Set<string>()): AcquireResult {
    const healthy = this.candidates(kind, exclude);
    if (!healthy.length) return { ok: false, reason: 'unhealthy' };
    const free = healthy.filter((u) => u.inFlight < u.maxInFlight);
    if (!free.length) return { ok: false, reason: 'busy' };
    const least = Math.min(...free.map((u) => u.inFlight));
    const tied = free.filter((u) => u.inFlight === least);
    const upstream = tied[this.rotor++ % tied.length];
    upstream.inFlight++;
    return { ok: true, upstream };
  }

  /** Waits up to `timeoutMs` for capacity; only "busy" is worth waiting for. */
  async acquire(kind: UpstreamKind | 'any', timeoutMs: number, exclude = new Set<string>(), signal?: AbortSignal): Promise<AcquireResult> {
    const deadline = this.now() + timeoutMs;
    for (;;) {
      const result = this.tryAcquire(kind, exclude);
      if (result.ok || result.reason === 'unhealthy') return result;
      const remaining = deadline - this.now();
      if (remaining <= 0 || signal?.aborted) return result;
      await new Promise<void>((resolve) => {
        const done = () => {
          clearTimeout(timer);
          signal?.removeEventListener('abort', done);
          this.waiters = this.waiters.filter((w) => w !== done);
          resolve();
        };
        const timer = setTimeout(done, Math.min(remaining, 1000));
        signal?.addEventListener('abort', done, { once: true });
        this.waiters.push(done);
      });
    }
  }

  /** Every acquire is released exactly once, with whether the upstream behaved. */
  release(u: Upstream, outcome: 'ok' | 'failed' | 'neutral'): void {
    u.inFlight = Math.max(0, u.inFlight - 1);
    if (outcome === 'ok') this.markHealthy(u);
    else if (outcome === 'failed') this.markFailure(u);
    this.waiters.shift()?.();
  }

  markHealthy(u: Upstream): void {
    u.consecutiveFailures = 0;
    u.openUntil = 0;
    this.waiters.shift()?.();
  }

  /** A passing probe closes the circuit only once the cooldown is over: it proves liveness, not inference. */
  probeOk(u: Upstream): void {
    if (u.openUntil === 0 || this.now() >= u.openUntil) this.markHealthy(u);
  }

  markFailure(u: Upstream, { trip = false } = {}): void {
    u.failed++;
    u.consecutiveFailures++;
    const halfOpen = u.openUntil !== 0;
    if (trip || halfOpen || u.consecutiveFailures >= this.opts.failureThreshold) u.openUntil = this.now() + this.opts.cooldownMs;
  }

  snapshot() {
    return this.upstreams.map((u) => ({
      id: u.id,
      kind: u.kind,
      inFlight: u.inFlight,
      maxInFlight: u.maxInFlight,
      healthy: u.openUntil === 0,
      served: u.served,
      failed: u.failed,
    }));
  }
}

/** Active health probe: the cheapest GET each worker type answers without loading a model. */
export function startHealthChecks(pool: UpstreamPool, intervalMs: number, upstreamToken?: string): () => void {
  const probe = async () => {
    await Promise.all(
      pool.upstreams.map(async (u) => {
        try {
          const res = await fetch(`${u.url}${u.kind === 'vllm' ? '/health' : '/api/version'}`, {
            headers: upstreamToken ? { authorization: `Bearer ${upstreamToken}` } : {},
            signal: AbortSignal.timeout(3000),
          });
          await res.body?.cancel();
          if (res.ok) pool.probeOk(u);
          else pool.markFailure(u, { trip: true });
        } catch {
          pool.markFailure(u, { trip: true });
        }
      }),
    );
  };
  void probe();
  const timer = setInterval(() => void probe(), intervalMs);
  timer.unref();
  return () => clearInterval(timer);
}
