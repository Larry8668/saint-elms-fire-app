import { errorFields, log } from '../config';
import type { SignalService } from './service';

export const TICK_MS = 15 * 60_000;

export interface OpenWorkspace {
  profile: { id: string };
  signals: SignalService;
}

/**
 * The slow tick: evaluates only workspaces a signed-in session holds open — never a locked
 * profile — so per-student isolation and tick cost stay bounded. Returns a stop function;
 * the timer is unref'd so it never keeps a shutting-down engine alive.
 */
export function startSignalScheduler(openWorkspaces: () => Promise<OpenWorkspace[]>, intervalMs = TICK_MS): () => void {
  const tick = async () => {
    for (const ws of await openWorkspaces()) {
      await ws.signals.evaluate().catch((error) => log.warn('signal_tick_failed', { profileId: ws.profile.id, ...errorFields(error) }));
    }
  };
  const timer = setInterval(() => {
    tick().catch((error) => log.warn('signal_tick_failed', errorFields(error)));
  }, intervalMs);
  timer.unref();
  log.info('signal_scheduler_started', { intervalMs });
  return () => clearInterval(timer);
}
