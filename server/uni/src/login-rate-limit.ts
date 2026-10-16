import { createHash } from 'node:crypto';
import type { Context, MiddlewareHandler } from 'hono';
import { getConnInfo } from '@hono/node-server/conninfo';
import { log } from './logger';

/**
 * Brute-force guard for the legacy `/v1/auth/login` route. That endpoint predates the
 * better-auth account layer, so the database-backed limiter in `rate-limit.ts` never
 * sees it; this fixed in-memory window mirrors better-auth's own sign-in rule
 * (10 attempts per 60 seconds) keyed on the client IP. In-memory is deliberate: the
 * process serves one deployment, and a restart simply resets the window.
 */

export interface FixedWindowLimiter {
  /** Records one attempt; false once `max` attempts inside the live window are used up. */
  allow(key: string): boolean;
}

/** Sweep bound: expired buckets are purged before the map grows past this many keys. */
const MAX_BUCKETS = 10_000;

export function createFixedWindowLimiter(options: { windowMs: number; max: number; now?: () => number }): FixedWindowLimiter {
  const now = options.now ?? Date.now;
  const buckets = new Map<string, { resetAt: number; count: number }>();
  return {
    allow(key) {
      const at = now();
      if (buckets.size >= MAX_BUCKETS) {
        for (const [bucketKey, bucket] of buckets) {
          if (bucket.resetAt <= at) buckets.delete(bucketKey);
        }
      }
      const bucket = buckets.get(key);
      if (!bucket || bucket.resetAt <= at) {
        buckets.set(key, { resetAt: at + options.windowMs, count: 1 });
        return true;
      }
      bucket.count += 1;
      return bucket.count <= options.max;
    },
  };
}

/** Non-reversible log stand-in for an identifier; raw emails and IPs never reach the logs. */
export function logFingerprint(value: string): string {
  return createHash('sha256').update(value, 'utf8').digest('hex').slice(0, 16);
}

/** Socket peer address; 'unknown' outside a live server (tests, proxied runtimes). */
export function clientAddress(c: Context): string {
  try {
    return getConnInfo(c).remote.address ?? 'unknown';
  } catch {
    return 'unknown';
  }
}

export function createLoginRateLimit(options: { windowMs?: number; max?: number; now?: () => number } = {}): MiddlewareHandler {
  const limiter = createFixedWindowLimiter({ windowMs: options.windowMs ?? 60_000, max: options.max ?? 10, now: options.now });
  return async (c, next) => {
    const client = clientAddress(c);
    if (!limiter.allow(client)) {
      log.warn('login_rate_limited', { client: logFingerprint(client) });
      return c.json({ error: 'rate_limited' }, 429);
    }
    await next();
  };
}
