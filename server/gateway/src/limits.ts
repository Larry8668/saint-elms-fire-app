export interface LimitOptions {
  ratePerMinute: number;
  maxConcurrent: number;
  dailyTokenBudget: number;
  now?: () => number;
}

interface SubjectState {
  windowStart: number;
  windowCount: number;
  concurrent: number;
  day: string;
  tokens: number;
  requests: number;
  rejected: number;
}

export type Admission = { ok: true; release: () => void } | { ok: false; reason: 'rate' | 'concurrency' | 'budget'; retryAfterSeconds: number };

const MINUTE = 60_000;
const utcDay = (ms: number) => new Date(ms).toISOString().slice(0, 10);

/**
 * Per-subject (per-student) limits: a fixed one-minute request window, a cap on requests
 * in flight at once (each open stream holds one), and a daily token budget that resets at
 * UTC midnight. In memory, so a single gateway replica; running several replicas needs
 * these counters in Redis (INCR + EXPIRE) or the uni's Postgres `auth_kv`, see the docs.
 */
export class SubjectLimits {
  private readonly subjects = new Map<string, SubjectState>();
  private readonly now: () => number;

  constructor(private readonly opts: LimitOptions) {
    this.now = opts.now ?? Date.now;
  }

  private sweptDay = '';

  private state(sub: string): SubjectState {
    const now = this.now();
    const today = utcDay(now);
    if (today !== this.sweptDay) {
      // Once a day, forget idle subjects from earlier days: their budgets have reset anyway.
      this.sweptDay = today;
      for (const [key, s] of this.subjects) if (s.day !== today && s.concurrent === 0) this.subjects.delete(key);
    }
    let s = this.subjects.get(sub);
    if (!s) {
      s = { windowStart: now, windowCount: 0, concurrent: 0, day: utcDay(now), tokens: 0, requests: 0, rejected: 0 };
      this.subjects.set(sub, s);
    }
    if (now - s.windowStart >= MINUTE) {
      s.windowStart = now;
      s.windowCount = 0;
    }
    if (s.day !== utcDay(now)) {
      s.day = utcDay(now);
      s.tokens = 0;
    }
    return s;
  }

  admit(sub: string): Admission {
    const now = this.now();
    const s = this.state(sub);
    if (s.tokens >= this.opts.dailyTokenBudget) {
      s.rejected++;
      const midnight = Date.parse(`${s.day}T00:00:00Z`) + 24 * 3600_000;
      return { ok: false, reason: 'budget', retryAfterSeconds: Math.max(1, Math.ceil((midnight - now) / 1000)) };
    }
    if (s.windowCount >= this.opts.ratePerMinute) {
      s.rejected++;
      return { ok: false, reason: 'rate', retryAfterSeconds: Math.max(1, Math.ceil((s.windowStart + MINUTE - now) / 1000)) };
    }
    if (s.concurrent >= this.opts.maxConcurrent) {
      s.rejected++;
      return { ok: false, reason: 'concurrency', retryAfterSeconds: 1 };
    }
    s.windowCount++;
    s.concurrent++;
    s.requests++;
    let released = false;
    return {
      ok: true,
      release: () => {
        if (released) return;
        released = true;
        s.concurrent = Math.max(0, s.concurrent - 1);
      },
    };
  }

  /** Counts tokens after the fact; a request already admitted always finishes. */
  record(sub: string, tokens: number): void {
    if (tokens > 0) this.state(sub).tokens += tokens;
  }

  snapshot() {
    return [...this.subjects].map(([sub, s]) => ({
      sub,
      concurrent: s.concurrent,
      requestsThisMinute: s.windowCount,
      requests: s.requests,
      rejected: s.rejected,
      tokensToday: s.tokens,
      budget: this.opts.dailyTokenBudget,
    }));
  }
}
