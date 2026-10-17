import { isIP } from 'node:net';
import type { MiddlewareHandler } from 'hono';
import { log } from '../config';
import type { EngineEnv } from './context';
import type { EdgePolicy } from './edge';

export interface LimiterOptions {
  limit: number;
  windowMs: number;
  /** Most distinct keys tracked at once; the least recently seen key is forgotten first. */
  maxKeys?: number;
  now?: () => number;
}

export type LimitDecision = { ok: true; release: () => void } | { ok: false; retryAfterSeconds: number };

/**
 * In-memory sliding-window log: each key keeps at most `limit` timestamps, so memory is
 * bounded by `maxKeys × limit`. One process, no shared store — the engine is the only
 * writer for its own sign-in surface.
 */
export class SlidingWindowLimiter {
  private readonly hits = new Map<string, number[]>();
  private readonly maxKeys: number;
  private readonly now: () => number;

  constructor(private readonly options: LimiterOptions) {
    this.maxKeys = options.maxKeys ?? 10_000;
    this.now = options.now ?? Date.now;
  }

  get size(): number {
    return this.hits.size;
  }

  /**
   * Counts an attempt up front, so a burst of parallel requests cannot all slip through
   * before any of them is recorded. `release` refunds it (a successful sign-in).
   */
  attempt(key: string): LimitDecision {
    const now = this.now();
    const live = (this.hits.get(key) ?? []).filter((t) => t > now - this.options.windowMs);
    if (live.length >= this.options.limit) {
      this.hits.delete(key);
      this.hits.set(key, live);
      return { ok: false, retryAfterSeconds: Math.max(1, Math.ceil((live[0]! + this.options.windowMs - now) / 1000)) };
    }
    live.push(now);
    // Re-inserting moves the key to the back, which makes Map order least-recently-seen first.
    this.hits.delete(key);
    this.hits.set(key, live);
    this.evict(now);
    return {
      ok: true,
      release: () => {
        const stamps = this.hits.get(key);
        const at = stamps?.lastIndexOf(now) ?? -1;
        if (stamps && at >= 0) stamps.splice(at, 1);
      },
    };
  }

  private evict(now: number): void {
    if (this.hits.size <= this.maxKeys) return;
    for (const [key, stamps] of this.hits) {
      if (stamps.every((t) => t <= now - this.options.windowMs)) this.hits.delete(key);
    }
    for (const key of this.hits.keys()) {
      if (this.hits.size <= this.maxKeys) break;
      this.hits.delete(key);
    }
  }
}

/** Expands an IPv6 literal (`::`, an embedded dotted quad, a zone id) to its eight hextets. */
const hextets = (address: string): number[] | null => {
  let text = address.split('%')[0]!;
  const dotted = text.match(/^(.*:)(\d+\.\d+\.\d+\.\d+)$/);
  if (dotted) {
    const [a, b, c, d] = dotted[2]!.split('.').map(Number) as [number, number, number, number];
    text = `${dotted[1]}${((a << 8) | b).toString(16)}:${((c << 8) | d).toString(16)}`;
  }
  const [head, tail, extra] = text.split('::');
  if (extra !== undefined) return null;
  const left = head ? head.split(':') : [];
  const right = tail ? tail.split(':') : [];
  const missing = 8 - left.length - right.length;
  if (tail === undefined ? missing !== 0 : missing < 1) return null;
  const groups = [...left, ...Array<string>(tail === undefined ? 0 : missing).fill('0'), ...right].map((g) => Number.parseInt(g, 16));
  return groups.length === 8 && groups.every((g) => Number.isInteger(g) && g >= 0 && g <= 0xffff) ? groups : null;
};

/**
 * The bucket a client address falls into: an IPv6 client is keyed by its /64, since one
 * subscriber routinely holds a whole /64 and could otherwise mint a fresh bucket per
 * request. IPv4 and anything that is not an address are used as they are.
 */
export function limiterKey(address: string): string {
  if (isIP(address.split('%')[0]!) !== 6) return address;
  // An IPv4-mapped peer is an IPv4 client, not one /64 shared by the whole IPv4 internet.
  const mapped = address.match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/i)?.[1];
  if (mapped) return mapped;
  const groups = hextets(address);
  return groups ? `${groups.slice(0, 4).map((g) => g.toString(16)).join(':')}::/64` : address;
}

/**
 * Per-client limit on a sign-in route. A 2xx response refunds the attempt when
 * `refundSuccess` is set, so only failures (and in-flight attempts) count — signing in
 * repeatedly is not throttled, guessing is.
 */
export function rateLimit(limiter: SlidingWindowLimiter, policy: Pick<EdgePolicy, 'client'>, refundSuccess: boolean): MiddlewareHandler<EngineEnv> {
  return async (c, next) => {
    const address = limiterKey(policy.client(c));
    const decision = limiter.attempt(address);
    if (!decision.ok) {
      log.warn('rate_limited', { path: c.req.path, address, retryAfter: decision.retryAfterSeconds });
      return c.json(
        { error: 'Too many attempts. Wait a moment and try again.', code: 'rate_limited', retryAfter: decision.retryAfterSeconds },
        429,
        { 'retry-after': String(decision.retryAfterSeconds) },
      );
    }
    await next();
    if (refundSuccess && c.res.ok) decision.release();
  };
}
