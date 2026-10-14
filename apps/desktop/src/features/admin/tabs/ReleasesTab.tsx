import type { AdminCourse, CohortSummary } from '@sef/shared';
import { Plus } from 'lucide-react';
import { useEffect, useState, type FormEvent } from 'react';
import { Button } from '@/components/ui/button';
import { Dialog, Switch } from '@/components/ui/overlays';
import { Badge, Input, Label, Panel, Select, Skeleton } from '@/components/ui/primitives';
import { cn } from '@/lib/cn';
import { useAdminCourses, useCohorts, useCreateCohort, useSetReleased } from '../admin-queries';
import { groupBySemester, QueryState, semesterLabel, TabHeader, TableSkeleton } from '../ui';

export function ReleasesTab() {
  const cohorts = useCohorts();
  const courses = useAdminCourses();
  const [cohortId, setCohortId] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);

  useEffect(() => {
    if (!cohortId && cohorts.data?.length) setCohortId(cohorts.data[0]!.id);
  }, [cohortId, cohorts.data]);

  const cohort = cohorts.data?.find((c) => c.id === cohortId);

  return (
    <>
      <TabHeader
        title="Releases"
        description="Choose which courses each cohort can download. Devices only ever receive signed packages for released courses; withdrawing stops new downloads but does not wipe what a student already has."
        actions={
          <Button variant="secondary" onClick={() => setCreating(true)}>
            <Plus /> New cohort
          </Button>
        }
      />

      <div className="mb-5 flex flex-wrap gap-2">
        {cohorts.isPending && [0, 1, 2].map((i) => <Skeleton key={i} className="h-9 w-44 rounded-full" />)}
        {cohorts.data?.map((c) => (
          <button
            key={c.id}
            onClick={() => setCohortId(c.id)}
            className={cn(
              'rounded-full border px-4 py-1.5 text-[13px] transition',
              c.id === cohortId ? 'border-beacon-400/50 bg-beacon-500/15 text-beacon-200' : 'border-white/[0.08] text-night-300 hover:border-white/20',
            )}
          >
            {c.name}
            <span className="ml-2 text-night-500">{c.students}</span>
          </button>
        ))}
      </div>

      <QueryState query={courses} skeleton={<Panel><TableSkeleton rows={8} cols={3} /></Panel>}>
        {(rows) => (cohort ? <CohortReleases cohort={cohort} courses={rows} /> : null)}
      </QueryState>

      <NewCohortDialog open={creating} onOpenChange={setCreating} cohorts={cohorts.data ?? []} onCreated={setCohortId} />
    </>
  );
}

function CohortReleases({ cohort, courses }: { cohort: CohortSummary; courses: AdminCourse[] }) {
  const setReleased = useSetReleased();
  if (cohort.courses.includes('*')) {
    return (
      <Panel className="p-6 text-sm text-night-300">
        <strong className="text-night-100">{cohort.name}</strong> is a staff preview cohort with every course released (<code>*</code>). Per-course toggles apply to student cohorts.
      </Panel>
    );
  }
  const released = new Set(cohort.courses);
  const toggle = (courseIds: string[], on: boolean) => setReleased.mutate({ cohortId: cohort.id, courseIds, released: on });

  return (
    <div className="space-y-4">
      {groupBySemester(courses).map(([semester, list]) => {
        const on = list.filter((c) => released.has(c.id)).length;
        return (
          <Panel key={semester} className="overflow-hidden">
            <div className="flex items-center justify-between border-b border-white/[0.06] px-5 py-3">
              <div className="flex items-center gap-3">
                <h3 className="text-sm font-medium text-night-100">{semesterLabel(semester)}</h3>
                <Badge tone={on === list.length ? 'aurora' : on ? 'beacon' : 'neutral'}>
                  {on}/{list.length} released
                </Badge>
              </div>
              <div className="flex gap-1">
                <Button variant="ghost" size="sm" disabled={on === list.length} onClick={() => toggle(list.map((c) => c.id), true)}>
                  Release all
                </Button>
                <Button variant="ghost" size="sm" disabled={!on} onClick={() => toggle(list.map((c) => c.id), false)}>
                  Withdraw all
                </Button>
              </div>
            </div>
            <ul className="divide-y divide-white/[0.04]">
              {list.map((course) => (
                <li key={course.id} className="flex items-center gap-4 px-5 py-3">
                  <div className="min-w-0 flex-1">
                    <label htmlFor={`rel-${course.id}`} className="block truncate text-[14px] text-night-100">
                      {course.title}
                    </label>
                    <div className="text-[12px] text-night-500">
                      {course.code ? `${course.code} · ` : ''}
                      {course.lessonCount} lessons · v{course.version.slice(0, 7)}
                    </div>
                  </div>
                  <span className="hidden text-[12px] text-night-500 md:inline">
                    {course.cohorts.length} cohort{course.cohorts.length === 1 ? '' : 's'}
                  </span>
                  <Switch id={`rel-${course.id}`} checked={released.has(course.id)} onCheckedChange={(v) => toggle([course.id], v)} />
                </li>
              ))}
            </ul>
          </Panel>
        );
      })}
    </div>
  );
}

function NewCohortDialog({ open, onOpenChange, cohorts, onCreated }: { open: boolean; onOpenChange: (v: boolean) => void; cohorts: CohortSummary[]; onCreated: (id: string) => void }) {
  const create = useCreateCohort();
  const [id, setId] = useState('');
  const [name, setName] = useState('');
  const [copyFrom, setCopyFrom] = useState('');

  const submit = (e: FormEvent) => {
    e.preventDefault();
    create.mutate(
      { id, name, copyFrom: copyFrom || undefined },
      {
        onSuccess: () => {
          onCreated(id);
          onOpenChange(false);
          setId('');
          setName('');
        },
      },
    );
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange} title="New cohort" description="A cohort is a group of students who receive the same course releases.">
      <form onSubmit={submit} className="space-y-4">
        <div>
          <Label htmlFor="cohort-name">Name</Label>
          <Input id="cohort-name" value={name} onChange={(e) => setName(e.target.value)} placeholder="B.Sc. PMA, 2027 intake" required />
        </div>
        <div>
          <Label htmlFor="cohort-id">Id</Label>
          <Input id="cohort-id" value={id} onChange={(e) => setId(e.target.value.toLowerCase().replace(/[^a-z0-9-]/g, '-'))} placeholder="bsc-pma-2027" required />
        </div>
        <div>
          <Label htmlFor="cohort-copy">Start with the releases of</Label>
          <Select id="cohort-copy" value={copyFrom} onChange={(e) => setCopyFrom(e.target.value)}>
            <option value="">Nothing (empty)</option>
            {cohorts.map((c) => (
              <option key={c.id} value={c.id}>
                {c.name}
              </option>
            ))}
          </Select>
        </div>
        <div className="flex justify-end gap-2 pt-2">
          <Button type="button" variant="ghost" onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button type="submit" variant="primary" loading={create.isPending}>
            Create cohort
          </Button>
        </div>
      </form>
    </Dialog>
  );
}
