/**
 * Waking a hosted seat. Measured behaviour of the Instabox edge (docs/internal/CLOUD_SEAT_NOTES.md):
 * - an idle auto-suspended box wakes on the first request in about a second;
 * - 502 means the box is up but the engine is not listening yet (it is still starting);
 * - 503 "Sandbox offline" means the box was stopped or paused by hand and stays offline until
 *   its owner resumes or starts it; requests alone never wake it.
 *
 * One waker is shared by every request, so twenty failed queries poll health once. It polls the
 * public `/api/health` with backoff until the seat answers or the window closes, and publishes
 * its state for the "Waking your seat…" notice. Time comes from `deps`, so tests use a fake clock.
 */

/** Why a seat call failed in a way waking can fix. `network` covers timeouts and refused connections. */
export type WakeCause = 'network' | 'starting' | 'offline';

export type WakeState =
  | { phase: 'idle' }
  /** Polling health; `cause` is the latest answer (`offline` = the box is paused, a resume is needed). */
  | { phase: 'waking'; cause: WakeCause; since: number }
  /** The window closed without an answer. `cause` is the last thing the seat said. */
  | { phase: 'unreachable'; cause: WakeCause };

export type WakeOutcome = 'ready' | Exclude<WakeCause, 'starting'>;

export interface WakeDeps {
  /** One GET of public `/api/health`: the HTTP status, 200 only when the body says ok, 0 when nothing answered. */
  probe: (base: string) => Promise<number>;
  sleep: (ms: number) => Promise<void>;
  now: () => number;
}

export const WAKE_WINDOW_MS = 60_000;
/** Backoff between health polls: quick at first (an idle wake takes about a second), then steady. */
export const WAKE_BACKOFF_MS = [500, 1_000, 2_000, 3_000, 5_000];

/** A 502 or 503 the edge sent (plain text or HTML), as opposed to a JSON refusal from the engine itself. */
export function edgeCause(res: Pick<Response, 'status' | 'headers'>): WakeCause | null {
  if (res.status !== 502 && res.status !== 503) return null;
  if ((res.headers.get('content-type') ?? '').includes('application/json')) return null;
  return res.status === 502 ? 'starting' : 'offline';
}

const causeOf = (status: number): WakeCause | null => (status === 200 ? null : status === 503 ? 'offline' : status === 502 ? 'starting' : 'network');

export function createSeatWaker(deps: WakeDeps) {
  let state: WakeState = { phase: 'idle' };
  let inflight: Promise<WakeOutcome> | null = null;
  let windowStart = 0;
  const listeners = new Set<() => void>();

  const set = (next: WakeState) => {
    state = next;
    for (const listener of listeners) listener();
  };

  const run = async (base: string, first: WakeCause): Promise<WakeOutcome> => {
    windowStart = deps.now();
    set({ phase: 'waking', cause: first, since: windowStart });
    let cause = first;
    for (let attempt = 0; ; attempt += 1) {
      await deps.sleep(WAKE_BACKOFF_MS[Math.min(attempt, WAKE_BACKOFF_MS.length - 1)]!);
      const status = await deps.probe(base).catch(() => 0);
      const next = causeOf(status);
      if (next === null) {
        set({ phase: 'idle' });
        return 'ready';
      }
      cause = next;
      if (state.phase === 'waking' && state.cause !== cause) set({ ...state, cause });
      if (deps.now() - windowStart >= WAKE_WINDOW_MS) {
        set({ phase: 'unreachable', cause });
        return cause === 'offline' ? 'offline' : 'network';
      }
    }
  };

  return {
    get state() {
      return state;
    },
    subscribe(listener: () => void) {
      listeners.add(listener);
      return () => void listeners.delete(listener);
    },
    /** Wait for the seat to answer health. Concurrent callers share one poll loop. */
    wake(base: string, cause: WakeCause): Promise<WakeOutcome> {
      inflight ??= run(base, cause).finally(() => {
        inflight = null;
      });
      return inflight;
    },
    /** A resume was just requested: give the box a fresh window to boot. */
    extend() {
      windowStart = deps.now();
    },
    /** The seat answered a call on its own: an old "unreachable" notice no longer holds. */
    settle() {
      if (!inflight && state.phase !== 'idle') set({ phase: 'idle' });
    },
  };
}

export type SeatWaker = ReturnType<typeof createSeatWaker>;

/** What the seat notice says for a waker state; null when there is nothing to say. `failed`: a call already gave up. */
export function wakeNoticeOf(state: WakeState, failed = false): 'waking' | 'starting' | 'paused' | 'unreachable' | null {
  if (state.phase === 'waking') return state.cause === 'offline' ? 'paused' : state.cause === 'starting' ? 'starting' : 'waking';
  if (state.phase === 'unreachable') return state.cause === 'offline' ? 'paused' : 'unreachable';
  return failed ? 'unreachable' : null;
}

const PROBE_TIMEOUT_MS = 8_000;

/** The app's waker: real timers and `fetch`, each probe capped so a hung connection counts as no answer. */
export const seatWaker = createSeatWaker({
  probe: async (base) => {
    const res = await fetch(`${base}/api/health`, { signal: AbortSignal.timeout(PROBE_TIMEOUT_MS) });
    if (res.status !== 200) return res.status;
    const body = (await res.json().catch(() => null)) as { ok?: unknown } | null;
    return body?.ok === true ? 200 : 0;
  },
  sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
  now: () => Date.now(),
});
