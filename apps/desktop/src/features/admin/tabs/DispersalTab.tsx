import { useMemo } from 'react';
import { Badge, Panel } from '@/components/ui/primitives';
import { ProfileAvatar } from '@/features/auth/ProfileAvatar';
import { timeAgo } from '@/lib/time';
import type { DispersalRow } from '../admin-api';
import { useAccounts, useAdminCourses, useCohorts, useDispersal } from '../admin-queries';
import { QueryState, TabHeader, TableSkeleton } from '../ui';

/** Per student: how much of what their cohort has released is actually on their device, and how fresh it is. */
export function DispersalTab() {
  const dispersal = useDispersal();
  const accounts = useAccounts();
  const cohorts = useCohorts();
  const courses = useAdminCourses();

  const byStudent = useMemo(() => {
    const map = new Map<string, DispersalRow[]>();
    for (const r of dispersal.data ?? []) map.set(r.accountId, [...(map.get(r.accountId) ?? []), r]);
    return map;
  }, [dispersal.data]);
  const title = (id: string) => courses.data?.find((c) => c.id === id)?.title ?? id;

  return (
    <>
      <TabHeader
        title="Dispersal"
        description="Each time a device pulls a signed course package, the server records the version it received. Outdated means the course changed after that student last synced."
      />
      <QueryState query={dispersal} skeleton={<Panel><TableSkeleton rows={4} cols={4} /></Panel>}>
        {() => (
          <div className="space-y-3">
            {accounts.data
              ?.filter((a) => a.role === 'student')
              .map((a) => {
                const rows = byStudent.get(a.id) ?? [];
                const released = cohorts.data?.find((c) => c.id === a.cohortId)?.courses.length ?? 0;
                const outdated = rows.filter((r) => !r.current);
                const pct = released ? Math.min(100, Math.round((rows.length / released) * 100)) : 0;
                return (
                  <Panel key={a.id} className="p-5">
                    <div className="flex flex-wrap items-center gap-4">
                      <ProfileAvatar id={a.id} name={a.name} />
                      <div className="min-w-0 flex-1">
                        <div className="text-night-100">{a.name}</div>
                        <div className="text-[12px] text-night-500">
                          {a.cohortId} · last sync {rows[0] ? timeAgo(rows[0].at) : 'never'}
                        </div>
                      </div>
                      <div className="w-56">
                        <div className="mb-1.5 flex justify-between text-[12px] text-night-400">
                          <span>On device</span>
                          <span>
                            {rows.length}/{released}
                          </span>
                        </div>
                        <div className="h-1.5 overflow-hidden rounded-full bg-white/[0.06]">
                          <div className="h-full rounded-full bg-gradient-to-r from-beacon-500 to-aurora-400 transition-[width] duration-500" style={{ width: `${pct}%` }} />
                        </div>
                      </div>
                    </div>
                    {outdated.length > 0 && (
                      <div className="mt-4 flex flex-wrap items-center gap-1.5">
                        <span className="text-[12px] text-ember-300">Outdated:</span>
                        {outdated.map((r) => (
                          <Badge key={r.courseId} tone="ember" title={`Has ${r.version.slice(0, 8)}, synced ${timeAgo(r.at)}`}>
                            {title(r.courseId)}
                          </Badge>
                        ))}
                      </div>
                    )}
                  </Panel>
                );
              })}
          </div>
        )}
      </QueryState>
    </>
  );
}
