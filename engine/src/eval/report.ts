import { CONTRACT_VERSION, FALSE_ALERT_WINDOW_MS, type MetricEvent, type MetricEventKind, type MetricsReport, type Rate } from '@sef/shared';

export interface ReportExtras {
  /** Teacher turns in stored conversations, and how many were refused by policy. */
  turns: { total: number; refused: number };
  /** Wiki proposals decided by the student. */
  proposals: { accepted: number; rejected: number };
}

export const rate = (numerator: number, denominator: number): Rate => ({
  numerator,
  denominator,
  rate: denominator > 0 ? Math.min(1, numerator / denominator) : null,
});

/** First time each ref saw this kind of event. Repeats (refetches, re-renders) collapse. */
function firstSeen(events: MetricEvent[], kind: MetricEventKind): Map<string, MetricEvent> {
  const out = new Map<string, MetricEvent>();
  for (const e of events) if (e.kind === kind && !out.has(e.ref)) out.set(e.ref, e);
  return out;
}

/**
 * Pure aggregation over retained events. Every rate counts *distinct* items, so a UI that
 * reports "shown" on every refetch cannot dilute it. Numerators only count items that were
 * also shown, so a rate never exceeds what the student actually saw.
 */
export function aggregate(events: MetricEvent[], extras: ReportExtras, now: Date): MetricsReport {
  // Engine-stamped ISO-8601 UTC strings: code-unit order is chronological order.
  const sorted = [...events].sort((a, b) => (a.at < b.at ? -1 : a.at > b.at ? 1 : 0));
  const shownSuggestions = firstSeen(sorted, 'suggestion_shown');
  const sentSuggestions = [...firstSeen(sorted, 'suggestion_sent').keys()].filter((ref) => shownSuggestions.has(ref));

  const shownNudges = firstSeen(sorted, 'nudge_shown');
  const dismissed = firstSeen(sorted, 'nudge_dismissed');
  const falseAlerts = [...dismissed.values()].filter((d) => {
    const shown = shownNudges.get(d.ref);
    if (shown === undefined) return false;
    const delta = Date.parse(d.at) - Date.parse(shown.at);
    return delta >= 0 && delta <= FALSE_ALERT_WINDOW_MS;
  }).length;
  const clicked = [...firstSeen(sorted, 'nudge_clicked').keys()].filter((ref) => shownNudges.has(ref)).length;

  const approved = firstSeen(sorted, 'plan_approved');
  const completed = [...firstSeen(sorted, 'plan_completed').keys()].filter((ref) => approved.has(ref)).length;

  const signalVolumes: Record<string, number> = {};
  for (const e of shownNudges.values()) {
    const kind = e.tag ?? 'unknown';
    signalVolumes[kind] = (signalVolumes[kind] ?? 0) + 1;
  }

  return {
    schemaVersion: CONTRACT_VERSION,
    generatedAt: now.toISOString(),
    since: sorted[0]?.at ?? null,
    events: sorted.length,
    suggestionAcceptance: rate(sentSuggestions.length, shownSuggestions.size),
    falseAlerts: rate(falseAlerts, shownNudges.size),
    nudgeEngagement: rate(clicked, shownNudges.size),
    planCompletion: rate(completed, approved.size),
    planStepsCompleted: firstSeen(sorted, 'plan_step_completed').size,
    refusals: rate(extras.turns.refused, extras.turns.total),
    proposalAcceptance: rate(extras.proposals.accepted, extras.proposals.accepted + extras.proposals.rejected),
    signalVolumes,
  };
}
