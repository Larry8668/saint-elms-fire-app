import { BookOpen, GraduationCap, LifeBuoy } from 'lucide-react';
import type { DeviceProfile, SyncStatus } from '@sef/shared';
import { Badge, EmptyState, Eyebrow, Panel } from '@/components/ui/primitives';
import { CurriculumUnavailable } from './CurriculumUnavailable';
import { groupProgramme, installStateOf, metadataCaveat, type ProgrammeCourse, type SemesterGroup } from './programme-rows';

interface ProgrammeStructureProps {
  status: SyncStatus;
  profile: DeviceProfile;
  onOpenCourse: (courseId: string) => void;
}

/**
 * The programme as this student can honestly be shown it: the structure released to their
 * cohort, with the university-support corpus separated out and counted on its own.
 *
 * This is a read-only structure. It deliberately offers no download action, because a row
 * being listed here is not permission to install it — release and selection are the university's
 * decision, and downloads live on the Released courses tab.
 */
export function ProgrammeStructure({ status, profile, onOpenCourse }: ProgrammeStructureProps) {
  const structure = groupProgramme(status.courses);

  return (
    <div>
      <CurriculumUnavailable profile={profile} />

      <Panel className="mb-6 p-5">
        <div className="flex flex-wrap items-start justify-between gap-4">
          <div className="min-w-0">
            <Eyebrow className="mb-2">Released to your cohort</Eyebrow>
            <h2 className="text-[15px] font-semibold text-night-100">Programme structure</h2>
            <p className="mt-1.5 max-w-2xl text-[13.5px] leading-6 text-night-400">
              Counted from the rows below, not from a stored total. Support courses sit apart because they carry no degree
              credit, so they never raise the degree numbers.
            </p>
          </div>
          {status.cohortId && (
            <Badge tone="beacon" className="shrink-0">
              <GraduationCap aria-hidden className="size-3" /> {status.cohortId}
            </Badge>
          )}
        </div>

        <dl className="mt-5 grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
          <Total label="Degree courses" value={structure.totals.degreeCourses} />
          <Total label="Degree lessons" value={structure.totals.degreeLessons} />
          <Total label="Support courses" value={structure.totals.supportCourses} note="Excluded from the totals above" />
          <Total label="Support lessons" value={structure.totals.supportLessons} note="Excluded from the totals above" />
        </dl>
      </Panel>

      {structure.degree.length === 0 && structure.support === null && (
        <Panel>
          <EmptyState
            icon={<BookOpen />}
            title="Nothing released to your cohort yet"
            body="No course has been released for this cohort. When the university releases one it appears here and can be downloaded from the Released courses tab."
          />
        </Panel>
      )}

      <div className="space-y-10">
        {structure.degree.map((group) => (
          <SemesterSection key={group.semester} group={group} onOpenCourse={onOpenCourse} />
        ))}
        {structure.support && <SupportSection group={structure.support} onOpenCourse={onOpenCourse} />}
      </div>
    </div>
  );
}

function SemesterSection({ group, onOpenCourse }: { group: SemesterGroup; onOpenCourse: (courseId: string) => void }) {
  return (
    <section aria-labelledby={`semester-${group.semester}`}>
      <div className="mb-3 flex flex-wrap items-baseline justify-between gap-2">
        <Eyebrow id={`semester-${group.semester}`}>Semester {group.semester}</Eyebrow>
        <span className="text-[12px] text-night-500">
          {group.degreeCount} {group.degreeCount === 1 ? 'course' : 'courses'} · {group.lessonCount}{' '}
          {group.lessonCount === 1 ? 'lesson' : 'lessons'}
        </span>
      </div>
      <ul className="space-y-2">
        {group.courses.map((course) => (
          <li key={course.id}>
            <ProgrammeRow course={course} onOpenCourse={onOpenCourse} />
          </li>
        ))}
      </ul>
    </section>
  );
}

/** Visually apart from the degree sections, and labelled as outside the degree. */
function SupportSection({ group, onOpenCourse }: { group: SemesterGroup; onOpenCourse: (courseId: string) => void }) {
  return (
    <section aria-labelledby="support-corpus">
      <div className="mb-3 flex flex-wrap items-baseline justify-between gap-2">
        <Eyebrow id="support-corpus">University support</Eyebrow>
        <span className="text-[12px] text-night-500">
          {group.degreeCount} {group.degreeCount === 1 ? 'course' : 'courses'} · not degree credit
        </span>
      </div>
      <Panel className="border-dashed p-4">
        <p className="mb-3 flex items-start gap-2 text-[13px] leading-5 text-night-400">
          <LifeBuoy aria-hidden className="mt-0.5 size-4 shrink-0 text-beacon-300" />
          University support material. These rows carry no degree credit and are left out of the degree totals above.
        </p>
        <ul className="space-y-2">
          {group.courses.map((course) => (
            <li key={course.id}>
              <ProgrammeRow course={course} onOpenCourse={onOpenCourse} />
            </li>
          ))}
        </ul>
      </Panel>
    </section>
  );
}

function ProgrammeRow({ course, onOpenCourse }: { course: ProgrammeCourse; onOpenCourse: (courseId: string) => void }) {
  const state = installStateOf(course);
  const caveat = metadataCaveat(course);
  const openable = course.state === 'installed' || course.state === 'local-only';

  return (
    <Panel className="flex flex-col gap-3 p-4 sm:flex-row sm:items-center sm:justify-between">
      <div className="min-w-0">
        <div className="flex flex-wrap items-center gap-2">
          <h3 className="text-[14.5px] leading-snug font-semibold text-night-100">{course.title}</h3>
          <Badge tone={state.tone}>{state.label}</Badge>
        </div>
        <p className="mt-1 text-[12.5px] text-night-400 capitalize">
          {course.subjectId.replace(/-/g, ' ')} · {course.lessonCount} {course.lessonCount === 1 ? 'lesson' : 'lessons'}
          {course.localVersion ? ` · installed ${course.localVersion}` : ''}
        </p>
        {caveat && <p className="mt-1.5 text-[12.5px] text-ember-300">{caveat}</p>}
      </div>

      {openable && (
        <button
          type="button"
          onClick={() => onOpenCourse(course.id)}
          className="shrink-0 cursor-pointer self-start rounded-xl border border-white/12 px-3 py-1.5 text-[13px] text-night-200 transition hover:border-beacon-400/50 hover:bg-beacon-500/10 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-beacon-400/60 sm:self-auto"
        >
          Open course
        </button>
      )}
    </Panel>
  );
}

function Total({ label, value, note }: { label: string; value: number; note?: string }) {
  return (
    <div className="rounded-xl border border-white/[0.06] bg-black/20 p-3.5">
      <dt className="text-[11.5px] tracking-wide text-night-400 uppercase">{label}</dt>
      <dd className="mt-1 text-2xl leading-none font-semibold text-night-100">{value}</dd>
      {note && <p className="mt-1.5 text-[11.5px] text-night-500">{note}</p>}
    </div>
  );
}