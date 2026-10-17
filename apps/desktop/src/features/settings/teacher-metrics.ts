import type { MetricsReport, Rate } from '@sef/shared';

/** Below this many samples a percentage is noise; show the raw count instead. */
export const MIN_SAMPLE = 5;

export interface MetricRow {
  id: string;
  label: string;
  hint: string;
  value: string;
  /** Lower is better for false alerts and refusals; the UI tints accordingly. */
  better: 'higher' | 'lower';
  rate: number | null;
}

export function formatRate(rate: Rate): string {
  if (rate.denominator === 0 || rate.rate === null) return 'No data yet';
  const counts = `${rate.numerator} of ${rate.denominator}`;
  if (rate.denominator < MIN_SAMPLE) return `${counts} · too early to tell`;
  return `${counts} (${Math.round(rate.rate * 100)}%)`;
}

const ROWS: Array<{ id: keyof MetricsReport & string; label: string; hint: string; better: MetricRow['better'] }> = [
  { id: 'suggestionAcceptance', label: 'Suggestions you used', hint: 'Suggested questions you sent, of those shown.', better: 'higher' },
  { id: 'nudgeEngagement', label: 'Nudges you opened', hint: 'Attention items you acted on, of those shown.', better: 'higher' },
  { id: 'falseAlerts', label: 'False alerts', hint: 'Nudges dismissed within 5 seconds of appearing.', better: 'lower' },
  { id: 'planCompletion', label: 'Plans finished', hint: 'Study plans completed, of those you approved.', better: 'higher' },
  { id: 'proposalAcceptance', label: 'Wiki edits accepted', hint: 'Brain keeper proposals you kept, of those you decided.', better: 'higher' },
  { id: 'refusals', label: 'Refused turns', hint: 'Teacher replies withheld by policy, of all replies.', better: 'lower' },
];

export function metricRows(report: MetricsReport): MetricRow[] {
  return ROWS.map(({ id, label, hint, better }) => {
    const rate = report[id] as Rate;
    return { id, label, hint, better, value: formatRate(rate), rate: rate.denominator >= MIN_SAMPLE ? rate.rate : null };
  });
}

/** Signal kinds by distinct nudges shown, busiest first. */
export function topSignals(report: MetricsReport, limit = 4): Array<{ kind: string; count: number }> {
  return Object.entries(report.signalVolumes)
    .filter(([, count]) => count > 0)
    .sort(([a, x], [b, y]) => y - x || a.localeCompare(b))
    .slice(0, limit)
    .map(([kind, count]) => ({ kind, count }));
}
