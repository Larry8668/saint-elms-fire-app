import { Panel } from '@/components/ui/primitives';
import { useCohorts, useOverview } from '../admin-queries';
import { QueryState, StatCard, StatCardSkeleton, TabHeader, TableSkeleton } from '../ui';
import { AuditList } from './AuditTab';

export function OverviewTab() {
  const overview = useOverview();
  const cohorts = useCohorts();

  return (
    <>
      <TabHeader
        title="Overview"
        description="What has been released, who has pulled it onto their devices, and what changed recently. Students study offline; this is the only place their course content comes from."
      />
      <QueryState
        query={overview}
        skeleton={
          <div className="grid gap-3 md:grid-cols-4">
            {[0, 1, 2, 3].map((i) => (
              <StatCardSkeleton key={i} />
            ))}
          </div>
        }
      >
        {(o) => (
          <div className="grid gap-3 md:grid-cols-4">
            <StatCard label="Students" value={o.students} hint={`across ${o.cohorts} cohorts`} />
            <StatCard label="Courses in catalogue" value={o.courses} hint={`${o.releasedCourseSlots} cohort releases`} />
            <StatCard label="Syncs this week" value={o.syncsLast7Days} hint="signed packages pulled" tone="aurora" />
            <StatCard label="Outdated installs" value={o.outdatedInstalls} hint="devices behind the latest version" tone={o.outdatedInstalls ? 'ember' : 'neutral'} />
          </div>
        )}
      </QueryState>

      <div className="mt-6 grid gap-6 lg:grid-cols-[1.2fr_1fr]">
        <Panel className="overflow-hidden">
          <h2 className="border-b border-white/[0.06] px-5 py-3.5 text-sm font-medium text-night-200">Cohorts</h2>
          <QueryState query={cohorts} skeleton={<TableSkeleton rows={4} cols={3} />}>
            {(rows) => (
              <ul className="divide-y divide-white/[0.04]">
                {rows.map((c) => (
                  <li key={c.id} className="flex items-center justify-between gap-4 px-5 py-3.5">
                    <div className="min-w-0">
                      <div className="truncate text-[14px] text-night-100">{c.name}</div>
                      <div className="text-[12px] text-night-500">{c.id}</div>
                    </div>
                    <div className="shrink-0 text-right text-[12.5px] text-night-300">
                      {c.courses.includes('*') ? 'All courses' : `${c.courses.length} courses`} · {c.students} student{c.students === 1 ? '' : 's'}
                    </div>
                  </li>
                ))}
              </ul>
            )}
          </QueryState>
        </Panel>
        <Panel className="overflow-hidden">
          <h2 className="border-b border-white/[0.06] px-5 py-3.5 text-sm font-medium text-night-200">Recent activity</h2>
          <QueryState query={overview} skeleton={<TableSkeleton rows={5} cols={2} />}>
            {(o) => <AuditList entries={o.recentAudit} />}
          </QueryState>
        </Panel>
      </div>
    </>
  );
}
