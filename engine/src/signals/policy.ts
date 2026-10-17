import type { AttentionItem, ProactivitySettings, SignalUrgency } from '@sef/shared';
import type { StoredSignal } from './store';

const URGENT_BYPASS_MS = 24 * 3_600_000;
export const URGENCY_RANK: Record<SignalUrgency, number> = { info: 0, soon: 1, urgent: 2 };

const minutes = (clock: string) => Number(clock.slice(0, 2)) * 60 + Number(clock.slice(3, 5));

/** Device-local wall clock; a window whose end precedes its start wraps past midnight. */
export function inQuietHours(quiet: ProactivitySettings['quietHours'], now: Date): boolean {
  if (!quiet.enabled) return false;
  const at = now.getHours() * 60 + now.getMinutes();
  const start = minutes(quiet.start);
  const end = minutes(quiet.end);
  if (start === end) return false;
  return start < end ? at >= start && at < end : at >= start || at < end;
}

/** Only an upcoming deadline under 24 hours away is loud enough to break quiet hours. */
export function bypassesQuietHours(item: Pick<StoredSignal, 'kind' | 'dueAt'>, now: Date): boolean {
  if (item.kind !== 'deadline' || !item.dueAt) return false;
  const left = Date.parse(item.dueAt) - now.getTime();
  return left > 0 && left < URGENT_BYPASS_MS;
}

/** Dated items before undated ones, soonest first. */
function byDue(a: StoredSignal, b: StoredSignal): number {
  if (a.dueAt && b.dueAt) return Date.parse(a.dueAt) - Date.parse(b.dueAt);
  if (a.dueAt) return -1;
  if (b.dueAt) return 1;
  return 0;
}

const byPriority = (a: StoredSignal, b: StoredSignal) =>
  URGENCY_RANK[b.urgency] - URGENCY_RANK[a.urgency] || byDue(a, b) || Date.parse(b.updatedAt) - Date.parse(a.updatedAt);

/** What the student is shown. The ledger itself is never filtered by policy. */
export function attentionView(items: StoredSignal[], settings: ProactivitySettings, now: Date): { items: AttentionItem[]; quiet: boolean } {
  const quiet = inQuietHours(settings.quietHours, now);
  if (!settings.nudges) return { items: [], quiet };
  const visible = items
    .filter((item) => settings.kinds[item.kind] !== false)
    .filter((item) => item.state !== 'dismissed')
    .filter((item) => !item.snoozedUntil || Date.parse(item.snoozedUntil) <= now.getTime())
    .sort(byPriority)
    .map((item) => ({ ...item, highlight: !quiet || bypassesQuietHours(item, now) }));
  return { items: visible, quiet };
}
