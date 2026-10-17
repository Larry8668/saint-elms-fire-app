export interface Timers {
  setTimeout(fn: () => void, ms: number): unknown;
  clearTimeout(handle: unknown): void;
  setInterval(fn: () => void, ms: number): unknown;
  clearInterval(handle: unknown): void;
}

export const realTimers: Timers = {
  setTimeout: (fn, ms) => setTimeout(fn, ms).unref(),
  clearTimeout: (handle) => clearTimeout(handle as NodeJS.Timeout),
  setInterval: (fn, ms) => setInterval(fn, ms).unref(),
  clearInterval: (handle) => clearInterval(handle as NodeJS.Timeout),
};

export interface SchedulerOptions {
  /** Quiet time after the last write before a push: writes come in bursts (a compile, a quiz). */
  debounceMs?: number;
  /** A steady stream of writes still pushes this often. */
  maxWaitMs?: number;
  /** The safety net: catches writes no hook saw (a background job, an edit in Obsidian). */
  periodicMs?: number;
  timers?: Timers;
  now?: () => number;
}

/**
 * When to push, and never two at once. `markDirty` (re)arms a debounce; the periodic tick
 * pushes regardless, since the push itself finds out cheaply whether anything changed. Every
 * request that arrives mid-push shares exactly one follow-up push, so a burst of writes during
 * a slow upload costs one extra round, not one per write.
 */
export class PushScheduler<T> {
  private debounce: unknown = null;
  private periodic: unknown = null;
  private firstDirtyAt: number | null = null;
  private inFlight: Promise<T> | null = null;
  private queued: Promise<T> | null = null;
  private stopped = true;
  private readonly debounceMs: number;
  private readonly maxWaitMs: number;
  private readonly periodicMs: number;
  private readonly timers: Timers;
  private readonly now: () => number;

  constructor(
    private readonly push: () => Promise<T>,
    options: SchedulerOptions = {},
    private readonly onError: (error: unknown) => void = () => {},
  ) {
    this.debounceMs = options.debounceMs ?? 7_000;
    this.maxWaitMs = options.maxWaitMs ?? 30_000;
    this.periodicMs = options.periodicMs ?? 60_000;
    this.timers = options.timers ?? realTimers;
    this.now = options.now ?? Date.now;
  }

  start(): void {
    if (!this.stopped) return;
    this.stopped = false;
    this.periodic = this.timers.setInterval(() => void this.run().catch(this.onError), this.periodicMs);
  }

  stop(): void {
    this.stopped = true;
    if (this.debounce !== null) this.timers.clearTimeout(this.debounce);
    if (this.periodic !== null) this.timers.clearInterval(this.periodic);
    this.debounce = this.periodic = null;
  }

  get pending(): boolean {
    return this.firstDirtyAt !== null || this.inFlight !== null;
  }

  markDirty(): void {
    if (this.stopped) return;
    const now = this.now();
    this.firstDirtyAt ??= now;
    if (this.debounce !== null) this.timers.clearTimeout(this.debounce);
    const wait = Math.max(0, Math.min(this.debounceMs, this.firstDirtyAt + this.maxWaitMs - now));
    this.debounce = this.timers.setTimeout(() => {
      this.debounce = null;
      void this.run().catch(this.onError);
    }, wait);
  }

  /** Pushes now, or once right after the push in flight; concurrent callers share that one push. */
  run(): Promise<T> {
    if (!this.inFlight) return this.begin();
    this.queued ??= this.inFlight
      .catch(() => undefined)
      .then(() => {
        this.queued = null;
        return this.begin();
      });
    return this.queued;
  }

  private begin(): Promise<T> {
    if (this.debounce !== null) this.timers.clearTimeout(this.debounce);
    this.debounce = null;
    this.firstDirtyAt = null;
    const current: Promise<T> = this.push().finally(() => {
      if (this.inFlight === current) this.inFlight = null;
    });
    this.inFlight = current;
    return current;
  }
}
