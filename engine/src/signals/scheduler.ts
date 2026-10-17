import { errorFields, log } from '../config';
import type { SignalService } from './service';

export const TICK_MS = 15 * 60_000;

export interface OpenWorkspace {
  profile: { id: string };
  signals: Pick<SignalService, 'evaluate'>;
}

/** One pass over the open workspaces. Never throws: each failure is logged and the rest still run. */
export async function runSignalTick(openWorkspaces: () => Promise<OpenWorkspace[]>): Promise<{ evaluated: number; failed: number }> {
  let workspaces: OpenWorkspace[];
  try {
    workspaces = await openWorkspaces();
  } catch (error) {
    log.warn('signal_tick_enumerate_failed', errorFields(error));
    return { evaluated: 0, failed: 0 };
  }
  let failed = 0;
  for (const ws of workspaces) {
    try {
      await ws.signals.evaluate();
    } catch (error) {
      failed += 1;
      log.warn('signal_tick_failed', { profileId: ws.profile.id, ...errorFields(error) });
    }
  }
  return { evaluated: workspaces.length - failed, failed };
}

/**
 * The slow tick: evaluates only workspaces a signed-in session holds open — never a locked
 * profile — so per-student isolation and tick cost stay bounded. Returns a stop function;
 * the timer is unref'd so it never keeps a shutting-down engine alive.
 */
export function startSignalScheduler(openWorkspaces: () => Promise<OpenWorkspace[]>, intervalMs = TICK_MS): () => void {
  const timer = setInterval(() => void runSignalTick(openWorkspaces), intervalMs);
  timer.unref();
  log.info('signal_scheduler_started', { intervalMs });
  return () => clearInterval(timer);
}
