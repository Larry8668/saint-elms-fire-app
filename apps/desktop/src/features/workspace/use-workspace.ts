import { useQuery } from '@tanstack/react-query';
import { useEffect, useState } from 'react';
import { api, EngineError } from '@/lib/api';
import { log } from '@/lib/log';
import { currentEngineTarget, isWorkspaceTarget } from '@/lib/seat';
import { portalUrl } from '@/lib/uni-url';
import { beatOutcomeOf, startHeartbeat } from './heartbeat';

const PORTAL_KEY = 'sef.workspace-portal';

/** The portal this workspace came from, remembered so an offline workspace can still link back to it. */
export function workspacePortalUrl(): string {
  try {
    return sessionStorage.getItem(PORTAL_KEY) ?? portalUrl();
  } catch {
    return portalUrl();
  }
}

/** Is this engine a hosted workspace? Only an engine serving its own UI, or one the portal handed to the web app, can be one. */
export function useWorkspaceInfo() {
  const query = useQuery({
    queryKey: ['workspace'],
    queryFn: api.workspace,
    enabled: isWorkspaceTarget(currentEngineTarget()),
    staleTime: Number.POSITIVE_INFINITY,
    retry: false,
  });
  useEffect(() => {
    if (!query.data?.portalUrl) return;
    try {
      sessionStorage.setItem(PORTAL_KEY, query.data.portalUrl);
    } catch {
      // Storage refused: the build-time portal URL stays the fallback.
    }
  }, [query.data?.portalUrl]);
  return query;
}

/** Runs the lease heartbeat while this tab is visible; `ended` turns true once the university says the session is over. */
export function useWorkspaceHeartbeat(hosted: boolean): { ended: boolean } {
  const [ended, setEnded] = useState(false);
  useEffect(() => {
    if (!hosted) return;
    return startHeartbeat({
      beat: () =>
        api.workspaceHeartbeat().then(
          () => 'ok' as const,
          (error: unknown) => {
            const outcome = beatOutcomeOf(error);
            log.warn('workspace_heartbeat_failed', { outcome, code: error instanceof EngineError ? error.code : undefined });
            return outcome;
          },
        ),
      visible: () => document.visibilityState === 'visible',
      onVisibilityChange: (listener) => {
        document.addEventListener('visibilitychange', listener);
        return () => document.removeEventListener('visibilitychange', listener);
      },
      setTimer: (run, ms) => window.setTimeout(run, ms),
      clearTimer: (handle) => window.clearTimeout(handle as number),
      now: () => Date.now(),
      onEnded: () => setEnded(true),
    });
  }, [hosted]);
  return { ended };
}
