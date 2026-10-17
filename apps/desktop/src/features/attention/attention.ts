import type { AttentionItem, SignalKind, TeacherId } from '@sef/shared';
import type { NavState, View } from '@/lib/nav';

export const KIND_LABEL: Record<SignalKind, string> = {
  deadline: 'Deadlines',
  notice: 'Notices',
  release_update: 'Course updates',
  share_incoming: 'Peer shares',
  proposal_pending: 'Wiki reviews',
  vault_question: 'Open questions',
  maintenance_finding: 'Wiki maintenance',
  model_unavailable: 'Model health',
  connectivity: 'Connectivity',
};

/** Which teacher's context an item belongs to, for the "new since last visit" badges. */
export const KIND_TEACHER: Partial<Record<SignalKind, TeacherId>> = {
  deadline: 'friend',
  notice: 'friend',
  release_update: 'guide',
  proposal_pending: 'guide',
  maintenance_finding: 'guide',
  vault_question: 'philosopher',
  share_incoming: 'philosopher',
};

export const SNOOZE_OPTIONS: ReadonlyArray<{ hours: number; label: string }> = [
  { hours: 1, label: '1 hour' },
  { hours: 24, label: '1 day' },
  { hours: 168, label: '1 week' },
];

const refId = (item: AttentionItem, prefix: string) => item.entityRefs.find((ref) => ref.startsWith(`${prefix}:`))?.slice(prefix.length + 1);

/** Where "Open" takes the student. Null when there is nothing to act on (e.g. offline). */
export function destination(item: AttentionItem): { view: View; params?: Omit<NavState, 'view'> } | null {
  switch (item.kind) {
    case 'deadline':
    case 'notice':
      return { view: 'logistics' };
    case 'release_update':
      return { view: 'library' };
    case 'share_incoming':
      return { view: 'peers' };
    case 'proposal_pending':
      return { view: 'contribute' };
    case 'vault_question': {
      const page = refId(item, 'page');
      return { view: 'brain', params: page ? { page } : undefined };
    }
    case 'maintenance_finding':
      return { view: 'brain' };
    case 'model_unavailable':
      return { view: 'settings' };
    case 'connectivity':
      return null;
  }
}

/** "in 5 h", "in 2 days", "overdue" — relative to the device clock. */
export function dueLabel(dueAt: string | undefined, now: Date): string | null {
  if (!dueAt) return null;
  const ms = Date.parse(dueAt) - now.getTime();
  if (ms <= 0) return 'overdue';
  const hours = Math.round(ms / 3_600_000);
  if (hours < 1) return 'within the hour';
  if (hours < 48) return `in ${hours} h`;
  return `in ${Math.round(hours / 24)} days`;
}

/** The banner carries only what policy lets through and the student has not looked at. */
export const bannerItems = (items: AttentionItem[]) => items.filter((item) => item.highlight && item.state === 'new' && item.urgency === 'urgent');

export function newCountByTeacher(items: AttentionItem[]): Record<TeacherId, number> {
  const counts: Record<TeacherId, number> = { friend: 0, guide: 0, philosopher: 0 };
  for (const item of items) {
    const teacher = KIND_TEACHER[item.kind];
    if (teacher && item.state === 'new') counts[teacher] += 1;
  }
  return counts;
}

export const unseenKeys = (items: AttentionItem[]) => items.filter((item) => item.state === 'new').map((item) => item.key);
