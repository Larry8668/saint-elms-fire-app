import { EngineError } from '@/lib/api';

/**
 * Keeps the workspace lease alive (POST /v1/session/heartbeat, relayed by the engine) about
 * once a minute while the tab is visible. A hidden tab sends nothing, so a workspace nobody
 * is looking at is reaped after SESSION_IDLE_MINUTES (15 by default); coming back to the tab
 * beats at once if one is due. Timers, clock and visibility are injected for tests.
 */

export type BeatOutcome = 'ok' | 'ended' | 'retry';

export interface HeartbeatDeps {
  beat: () => Promise<BeatOutcome>;
  visible: () => boolean;
  onVisibilityChange: (listener: () => void) => () => void;
  setTimer: (run: () => void, ms: number) => unknown;
  clearTimer: (handle: unknown) => void;
  now: () => number;
  onEnded: () => void;
  intervalMs?: number;
}

export const HEARTBEAT_MS = 60_000;

export function startHeartbeat(deps: HeartbeatDeps): () => void {
  const interval = deps.intervalMs ?? HEARTBEAT_MS;
  let last = Number.NEGATIVE_INFINITY;
  let timer: unknown = null;
  let inflight = false;
  let stopped = false;

  const clear = () => {
    if (timer !== null) deps.clearTimer(timer);
    timer = null;
  };

  const schedule = () => {
    clear();
    if (stopped || inflight || !deps.visible()) return;
    timer = deps.setTimer(() => void tick(), Math.max(0, last + interval - deps.now()));
  };

  const tick = async () => {
    timer = null;
    if (stopped || !deps.visible()) return;
    inflight = true;
    last = deps.now();
    let outcome: BeatOutcome;
    try {
      outcome = await deps.beat();
    } catch {
      outcome = 'retry';
    }
    inflight = false;
    if (stopped) return;
    if (outcome === 'ended') {
      stop();
      deps.onEnded();
      return;
    }
    schedule();
  };

  const unsubscribe = deps.onVisibilityChange(schedule);
  function stop() {
    stopped = true;
    clear();
    unsubscribe();
  }
  schedule();
  return stop;
}

/** Only the university saying the session is over stops the heartbeat; anything else is retried next tick. */
export const beatOutcomeOf = (error: unknown): BeatOutcome => (error instanceof EngineError && error.code === 'workspace_ended' ? 'ended' : 'retry');
