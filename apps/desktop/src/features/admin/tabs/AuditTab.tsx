import type { AuditEntry } from '@sef/shared';
import { Panel } from '@/components/ui/primitives';
import { timeAgo } from '@/lib/time';
import { useAudit } from '../admin-queries';
import { QueryState, TabHeader, TableSkeleton } from '../ui';

const ACTION_LABEL: Record<string, string> = {
  login: 'Signed in',
  courses_released: 'Released courses',
  courses_withdrawn: 'Withdrew courses',
  cohort_created: 'Created cohort',
  account_created: 'Created account',
  account_updated: 'Updated account',
  share_posted: 'Posted a share',
  share_removed: 'Removed a share',
};

export function AuditList({ entries }: { entries: AuditEntry[] }) {
  if (!entries.length) return <p className="px-5 py-8 text-center text-sm text-night-500">Nothing has happened yet.</p>;
  return (
    <ol className="divide-y divide-white/[0.04]">
      {entries.map((e, i) => (
        <li key={`${e.at}-${i}`} className="flex gap-3 px-5 py-3">
          <span className="mt-1.5 size-1.5 shrink-0 rounded-full bg-beacon-400" />
          <div className="min-w-0 flex-1">
            <div className="text-[13.5px] text-night-100">
              <span className="text-night-400">{e.actor}</span> · {ACTION_LABEL[e.action] ?? e.action}
            </div>
            <div className="truncate text-[12.5px] text-night-400" title={e.detail}>
              {e.detail}
            </div>
          </div>
          <time className="shrink-0 text-[11.5px] text-night-500" dateTime={e.at} title={new Date(e.at).toLocaleString()}>
            {timeAgo(e.at)}
          </time>
        </li>
      ))}
    </ol>
  );
}

export function AuditTab() {
  const audit = useAudit();
  return (
    <>
      <TabHeader title="Audit log" description="Every sign-in, release change, account edit and moderation action, newest first. Stored append-only on the university server." />
      <Panel className="overflow-hidden">
        <QueryState query={audit} skeleton={<TableSkeleton rows={10} cols={2} />}>
          {(entries) => <AuditList entries={entries} />}
        </QueryState>
      </Panel>
    </>
  );
}
