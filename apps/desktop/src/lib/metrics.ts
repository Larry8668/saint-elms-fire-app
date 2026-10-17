import { useEffect } from 'react';
import { api } from './api';
import { log } from './log';
import { createMetricsReporter, type ClientMetricKind } from './metrics-reporter';

/** The app's one reporter. Local-only: events go to the student's own engine and nowhere else. */
export const metrics = createMetricsReporter({
  send: (events) => api.recordMetrics(events),
  onError: (error, dropped) => log.warn('metrics_send_failed', { dropped, error: (error as Error).message }),
});

if (typeof document !== 'undefined') {
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'hidden') void metrics.flush();
  });
  window.addEventListener('pagehide', () => void metrics.flush());
}

/** Reports each item once as shown while `active` (rendered and visible). */
export function useReportShown(kind: Extract<ClientMetricKind, 'nudge_shown' | 'suggestion_shown'>, items: Array<{ ref: string; tag?: string }>, active: boolean) {
  // A value signature, so a refetch returning the same items does not re-run the effect.
  const signature = JSON.stringify(items.map((i) => [i.ref, i.tag ?? null]));
  useEffect(() => {
    if (!active) return;
    for (const [ref, tag] of JSON.parse(signature) as Array<[string, string | null]>) metrics.report(kind, ref, tag ?? undefined);
  }, [kind, signature, active]);
}
