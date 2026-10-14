import { conceptKey, type LessonMeta, type SyncStatus } from '@sef/shared';
import { ArrowLeft, BookOpen, CheckCircle2, Clock, CloudDownload, KeyRound, LifeBuoy, MessageCircleQuestion, RefreshCw, ShieldCheck, WifiOff } from 'lucide-react';
import { motion } from 'motion/react';
import { useMemo } from 'react';
import { Markdown } from '@/components/Markdown';
import { Button } from '@/components/ui/button';
import { Badge, EmptyState, Eyebrow, PageHeader, Panel, Skeleton } from '@/components/ui/primitives';
import { cn } from '@/lib/cn';
import { useNav } from '@/lib/nav';
import { useInstallCourses, useLesson, useLibrary, useSyncStatus } from '@/lib/queries';

type CourseRow = SyncStatus['courses'][number];

export function LibraryView() {
  const nav = useNav();
  const sync = useSyncStatus();
  const library = useLibrary();
  const install = useInstallCourses();
  const openLesson = nav.lessonId && library.data ? library.data.lessons.find((l) => l.id === nav.lessonId) : undefined;
  const openCourse = openLesson?.courseId ?? null;
  const openCourseAt = (courseId: string) => {
    const first = library.data?.lessons.find((l) => l.courseId === courseId);
    if (first) nav.go('library', { lessonId: first.id });
  };

  const bySemester = useMemo(() => {
    const groups = new Map<number, CourseRow[]>();
    for (const c of sync.data?.courses ?? []) {
      const list = groups.get(c.semesterNumber) ?? [];
      list.push(c);
      groups.set(c.semesterNumber, list);
    }
    return [...groups.entries()].sort(([a], [b]) => a - b);
  }, [sync.data]);

  const pending = (sync.data?.courses ?? []).filter((c) => c.state === 'available' || c.state === 'update').length;

  if (openCourse && library.data) {
    const course = library.data.courses.find((c) => c.id === openCourse);
    const lessons = library.data.lessons.filter((l) => l.courseId === openCourse);
    return (
      <CourseReader
        title={course?.title ?? openCourse}
        lessons={lessons}
        lessonId={openLesson?.id ?? null}
        onLesson={(id) => nav.go('library', { lessonId: id })}
        onBack={() => nav.go('library')}
      />
    );
  }

  return (
    <div className="h-full overflow-y-auto">
      <div className="mx-auto max-w-6xl px-8 py-8">
        <PageHeader
          eyebrow="Courseware"
          title="Library"
          description="Released courses arrive from your university as signed packages. Each one is verified on this device before it is installed — then everything works offline."
          actions={
            <>
              <Button variant="ghost" onClick={() => void sync.refetch()} loading={sync.isFetching}>
                {!sync.isFetching && <RefreshCw />} Check for releases
              </Button>
              <Button variant="primary" disabled={!pending} loading={install.isPending && install.variables === 'all'} onClick={() => install.mutate('all')}>
                {!(install.isPending && install.variables === 'all') && <CloudDownload />} Download {pending ? `all ${pending}` : 'all'}
              </Button>
            </>
          }
        />

        {sync.data?.authRequired && (
          <Panel className="mb-6 flex items-center gap-3 border-ember-400/25 p-4 text-sm text-night-300">
            <KeyRound className="size-4 text-ember-400" />
            This device has no current university session for you. Sign out and sign back in while online to check for new releases. Everything installed keeps working.
          </Panel>
        )}
        {sync.data && !sync.data.uniReachable && !sync.data.authRequired && (
          <Panel className="mb-6 flex items-center gap-3 border-ember-400/25 p-4 text-sm text-night-300">
            <WifiOff className="size-4 text-ember-400" />
            The university server is out of reach. Installed courses still work — new releases will appear when you are back online.
          </Panel>
        )}

        {sync.isLoading && (
          <div className="grid gap-3 md:grid-cols-2 lg:grid-cols-3">
            {Array.from({ length: 6 }).map((_, i) => (
              <Skeleton key={i} className="h-36 rounded-2xl" />
            ))}
          </div>
        )}

        {sync.data && sync.data.courses.length === 0 && (
          <EmptyState icon={<BookOpen />} title="No courses yet" body="Nothing has been released to your cohort. Check that the university server URL in Settings is right." />
        )}

        <div className="space-y-10">
          {bySemester.map(([semester, courses]) => (
            <section key={semester}>
              <Eyebrow className="mb-3">{semester === 0 ? 'University support' : `Semester ${semester}`}</Eyebrow>
              <div className="grid gap-3 md:grid-cols-2 lg:grid-cols-3">
                {courses.map((course, i) => (
                  <CourseCard
                    key={course.id}
                    course={course}
                    index={i}
                    installing={install.isPending && (install.variables === course.id || install.variables === 'all')}
                    onInstall={() => install.mutate(course.id)}
                    onOpen={() => openCourseAt(course.id)}
                  />
                ))}
              </div>
            </section>
          ))}
        </div>
      </div>
    </div>
  );
}

function CourseCard({ course, index, installing, onInstall, onOpen }: { course: CourseRow; index: number; installing: boolean; onInstall: () => void; onOpen: () => void }) {
  const installed = course.state === 'installed' || course.state === 'local-only';
  return (
    <motion.div initial={{ opacity: 0, y: 8 }} animate={{ opacity: 1, y: 0 }} transition={{ delay: index * 0.03 }}>
      <Panel className={cn('group flex h-full flex-col p-5 transition', installed && 'cursor-pointer hover:border-white/[0.14]')} onClick={installed ? onOpen : undefined}>
        <div className="mb-3 flex items-start justify-between gap-2">
          <span className="grid size-10 place-items-center rounded-xl bg-white/[0.05] text-beacon-300">{course.support ? <LifeBuoy className="size-5" /> : <BookOpen className="size-5" />}</span>
          {course.state === 'installed' && (
            <Badge tone="aurora">
              <ShieldCheck className="size-3" /> Verified
            </Badge>
          )}
          {course.state === 'update' && <Badge tone="ember">Update ready</Badge>}
          {course.state === 'local-only' && <Badge>On device</Badge>}
        </div>
        <h3 className="text-[15px] leading-snug font-semibold text-night-100">{course.title}</h3>
        <p className="mt-1 text-[12.5px] text-night-400 capitalize">
          {course.subjectId.replace(/-/g, ' ')} · {course.lessonCount} lessons
        </p>
        <div className="mt-auto pt-4">
          {installed ? (
            <span className="flex items-center gap-1.5 text-[13px] text-night-300 group-hover:text-night-100">
              <CheckCircle2 className="size-4 text-aurora-400" /> Open course
            </span>
          ) : (
            <Button
              size="sm"
              variant={course.state === 'update' ? 'ember' : 'outline'}
              loading={installing}
              onClick={(e) => {
                e.stopPropagation();
                onInstall();
              }}
            >
              {!installing && <CloudDownload />} {course.state === 'update' ? 'Update' : 'Download'}
            </Button>
          )}
        </div>
      </Panel>
    </motion.div>
  );
}

function CourseReader({ title, lessons, lessonId, onLesson, onBack }: { title: string; lessons: LessonMeta[]; lessonId: string | null; onLesson: (id: string) => void; onBack: () => void }) {
  const { go } = useNav();
  const lesson = useLesson(lessonId);
  const modules = useMemo(() => {
    const map = new Map<string, { name: string; lessons: LessonMeta[] }>();
    for (const l of lessons) {
      const m = map.get(l.moduleId) ?? { name: l.moduleName, lessons: [] };
      m.lessons.push(l);
      map.set(l.moduleId, m);
    }
    return [...map.values()];
  }, [lessons]);

  return (
    <div className="flex h-full">
      <aside className="hidden w-72 shrink-0 flex-col border-r border-white/[0.06] md:flex">
        <div className="border-b border-white/[0.06] p-4">
          <Button variant="ghost" size="sm" onClick={onBack} className="-ml-2">
            <ArrowLeft /> Library
          </Button>
          <h2 className="mt-2 font-display text-2xl leading-tight text-night-100">{title}</h2>
        </div>
        <nav className="flex-1 space-y-5 overflow-y-auto p-3">
          {modules.map((m) => (
            <div key={m.name}>
              <Eyebrow className="mb-1.5 px-2">{m.name}</Eyebrow>
              {m.lessons.map((l) => (
                <button
                  key={l.id}
                  onClick={() => onLesson(l.id)}
                  className={cn(
                    'w-full cursor-pointer rounded-lg px-2.5 py-2 text-left text-[13px] leading-5 transition',
                    l.id === lessonId ? 'bg-beacon-500/15 text-night-100' : 'text-night-400 hover:bg-white/[0.04] hover:text-night-200',
                  )}
                >
                  <span className="mr-1.5 text-night-600">{l.order}.</span>
                  {l.title}
                </button>
              ))}
            </div>
          ))}
        </nav>
      </aside>

      <div className="flex-1 overflow-y-auto">
        {lesson.isLoading && <Skeleton className="m-10 h-96" />}
        {lesson.data && (
          <article className="mx-auto max-w-3xl px-8 py-10 animate-rise">
            <Eyebrow>{lesson.data.moduleName}</Eyebrow>
            <div className="mt-3 mb-6 flex flex-wrap items-center gap-2">
              {lesson.data.estimatedStudyMinutes && (
                <Badge>
                  <Clock className="size-3" /> {lesson.data.estimatedStudyMinutes} min
                </Badge>
              )}
              {lesson.data.concepts.slice(0, 8).map((c) => (
                <button key={c} onClick={() => go('sky', { conceptKey: conceptKey(c) })} className="cursor-pointer">
                  <Badge tone="beacon" className="hover:bg-beacon-500/25">
                    {c}
                  </Badge>
                </button>
              ))}
            </div>
            <Markdown>{lesson.data.markdown}</Markdown>
            <div className="mt-12 flex flex-wrap gap-2 border-t border-white/[0.07] pt-6">
              <Button variant="primary" onClick={() => go('teachers', { teacher: 'guide', draft: `I just read "${lesson.data!.title}". Can you check my understanding?` })}>
                <MessageCircleQuestion /> Talk it through with the Guide
              </Button>
              <Button onClick={() => go('teachers', { teacher: 'philosopher', draft: `Where do the ideas in "${lesson.data!.title}" show up in the real world?` })}>Take it further with the Philosopher</Button>
            </div>
          </article>
        )}
      </div>
    </div>
  );
}
