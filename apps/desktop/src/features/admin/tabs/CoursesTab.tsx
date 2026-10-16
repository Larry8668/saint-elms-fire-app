import type { AdminCourse } from '@sef/shared';
import { ChevronRight, Search, X } from 'lucide-react';
import { useMemo, useState } from 'react';
import { Sheet, SheetClose } from '@/components/ui/overlays';
import { Badge, Eyebrow, Input, Panel, Skeleton } from '@/components/ui/primitives';
import { useAdminCourses, useLessons } from '../admin-queries';
import { groupBySemester, QueryState, semesterLabel, TabHeader, TableSkeleton } from '../ui';

export function CoursesTab() {
  const courses = useAdminCourses();
  const [query, setQuery] = useState('');
  const [open, setOpen] = useState<AdminCourse | null>(null);

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    return q ? courses.data?.filter((c) => `${c.title} ${c.code ?? ''} ${c.subjectId}`.toLowerCase().includes(q)) : courses.data;
  }, [courses.data, query]);

  return (
    <>
      <TabHeader
        title="Courses"
        description="The programme catalogue as the server sees it. Each version is a hash of the lesson files, so a changed lesson shows up as an update on student devices."
        actions={
          <div className="relative w-64">
            <Search className="pointer-events-none absolute top-1/2 left-3 size-4 -translate-y-1/2 text-night-500" />
            <Input value={query} onChange={(e) => setQuery(e.target.value)} placeholder="Search courses" className="pl-9" />
          </div>
        }
      />
      <QueryState query={courses} skeleton={<Panel><TableSkeleton rows={10} cols={3} /></Panel>}>
        {() => (
          <div className="space-y-4">
            {groupBySemester(filtered ?? []).map(([semester, list]) => (
              <Panel key={semester} className="overflow-hidden">
                <h3 className="border-b border-white/[0.06] px-5 py-3 text-sm font-medium text-night-100">{semesterLabel(semester)}</h3>
                <ul className="divide-y divide-white/[0.04]">
                  {list.map((course) => (
                    <li key={course.id}>
                      <button onClick={() => setOpen(course)} className="flex w-full items-center gap-4 px-5 py-3 text-left transition hover:bg-white/[0.03]">
                        <div className="min-w-0 flex-1">
                          <div className="truncate text-[14px] text-night-100">{course.title}</div>
                          <div className="text-[12px] text-night-500">
                            {course.code ? `${course.code} · ` : ''}
                            {course.subjectId} · {course.lessonCount} lessons
                          </div>
                        </div>
                        <div className="hidden flex-wrap justify-end gap-1 md:flex">
                          {course.cohorts.filter((c) => c !== 'demo-all').map((c) => (
                            <Badge key={c} tone="beacon">
                              {c}
                            </Badge>
                          ))}
                          {!course.cohorts.some((c) => c !== 'demo-all') && <Badge>unreleased</Badge>}
                        </div>
                        <ChevronRight className="size-4 text-night-600" />
                      </button>
                    </li>
                  ))}
                </ul>
              </Panel>
            ))}
            {!filtered?.length && <p className="py-10 text-center text-sm text-night-500">No courses match "{query}".</p>}
          </div>
        )}
      </QueryState>
      <Sheet open={Boolean(open)} onOpenChange={(v) => !v && setOpen(null)} title={open?.title ?? 'Course details'}>
        {open && <CourseSheet course={open} />}
      </Sheet>
    </>
  );
}

function CourseSheet({ course }: { course: AdminCourse }) {
  const lessons = useLessons(course.id);
  return (
    <>
      <div className="flex items-start justify-between gap-3 border-b border-white/[0.06] p-5">
        <div>
          <Eyebrow>{semesterLabel(course.semesterNumber)}</Eyebrow>
          <h2 className="mt-1 font-display text-3xl leading-tight text-night-100">{course.title}</h2>
          <p className="mt-1 text-[12.5px] text-night-500">
            version {course.version} · {course.lessonCount} lessons
          </p>
        </div>
        <SheetClose className="rounded-lg p-1.5 text-night-400 hover:bg-white/10" aria-label="Close">
          <X className="size-4" />
        </SheetClose>
      </div>
      <div className="flex-1 overflow-y-auto p-5">
        {lessons.isPending && (
          <div className="space-y-3">
            {[0, 1, 2, 3, 4].map((i) => (
              <Skeleton key={i} className="h-16 rounded-xl" />
            ))}
          </div>
        )}
        {lessons.isError && <p className="text-sm text-rose-400">{(lessons.error as Error).message}</p>}
        <ol className="space-y-2.5">
          {lessons.data?.map((l, i) => (
            <li key={l.id} className="rounded-xl border border-white/[0.06] bg-white/[0.02] p-3.5">
              <div className="text-[11px] text-night-500">
                {i + 1}. {l.moduleName}
              </div>
              <div className="mt-0.5 text-[14px] text-night-100">{l.title}</div>
              <div className="mt-2 flex flex-wrap gap-1">
                {l.concepts.slice(0, 6).map((c) => (
                  <span key={c} className="rounded-md bg-white/[0.05] px-1.5 py-0.5 text-[11px] text-night-300">
                    {c}
                  </span>
                ))}
                {l.concepts.length > 6 && <span className="text-[11px] text-night-500">+{l.concepts.length - 6}</span>}
              </div>
            </li>
          ))}
        </ol>
      </div>
    </>
  );
}
