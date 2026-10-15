import type { SyncStatus } from '@sef/shared';

/** One course row as the engine reports it for the signed-in profile's cohort. */
export type ProgrammeCourse = SyncStatus['courses'][number];

export type BadgeTone = 'neutral' | 'beacon' | 'ember' | 'aurora' | 'gold' | 'rose';

/**
 * The university-support corpus is not degree work. The server files it under semester zero
 * and marks it `support`, so it is never folded into a displayed degree total.
 */
export const isSupportRow = (course: ProgrammeCourse): boolean => course.support;

export interface SemesterGroup {
  semester: number;
  courses: ProgrammeCourse[];
  /** Degree rows only. Support is counted separately and never reaches this number. */
  degreeCount: number;
  lessonCount: number;
}

export interface ProgrammeStructure {
  /** Semester groups that carry degree rows, ascending. */
  degree: SemesterGroup[];
  /** The support corpus, kept out of every degree total. Null when this cohort has none. */
  support: SemesterGroup | null;
  totals: {
    degreeCourses: number;
    degreeLessons: number;
    supportCourses: number;
    supportLessons: number;
  };
}

const byTitle = (a: ProgrammeCourse, b: ProgrammeCourse): number => a.title.localeCompare(b.title);

const groupOf = (semester: number, courses: ProgrammeCourse[]): SemesterGroup => ({
  semester,
  courses,
  degreeCount: courses.length,
  lessonCount: courses.reduce((n, course) => n + course.lessonCount, 0),
});

/**
 * Groups the cohort's released courses into the structure a student is actually enrolled in.
 *
 * Every number here is counted from the rows on screen, so a stale aggregate can never
 * disagree with what is displayed. The support corpus is split out first and counted on its
 * own, because support courses carry zero degree credit and must not inflate a total.
 */
export function groupProgramme(courses: readonly ProgrammeCourse[]): ProgrammeStructure {
  const degree = new Map<number, ProgrammeCourse[]>();
  const support: ProgrammeCourse[] = [];

  for (const course of courses) {
    if (isSupportRow(course)) {
      support.push(course);
      continue;
    }
    const list = degree.get(course.semesterNumber) ?? [];
    list.push(course);
    degree.set(course.semesterNumber, list);
  }

  const semesters = [...degree.entries()]
    .sort(([a], [b]) => a - b)
    .map(([semester, rows]) => groupOf(semester, rows.sort(byTitle)));
  const supportCourses = support.sort(byTitle);

  return {
    degree: semesters,
    support: supportCourses.length ? groupOf(supportCourses[0]!.semesterNumber, supportCourses) : null,
    totals: {
      degreeCourses: semesters.reduce((n, group) => n + group.degreeCount, 0),
      degreeLessons: semesters.reduce((n, group) => n + group.lessonCount, 0),
      supportCourses: supportCourses.length,
      supportLessons: supportCourses.reduce((n, course) => n + course.lessonCount, 0),
    },
  };
}

/**
 * What this view may honestly say about a row. The released view carries an install state, a
 * release version and whether the signed metadata was covered by the signature; it carries no
 * credits, hours or academic status, and this view never substitutes a guess for those.
 */
export const INSTALL_STATES: Record<ProgrammeCourse['state'], { label: string; tone: BadgeTone }> = {
  installed: { label: 'Verified on this device', tone: 'aurora' },
  update: { label: 'Newer release available', tone: 'ember' },
  available: { label: 'Released, not yet installed', tone: 'beacon' },
  'local-only': { label: 'On this device only', tone: 'neutral' },
};

/**
 * The state crosses the network from the engine, so a version skew can supply one this build
 * predates. An unrecognised state is reported as unknown rather than crashing the view, and it
 * is never rendered as if it meant "installed".
 */
const UNKNOWN_STATE: { label: string; tone: BadgeTone } = { label: 'State not recognised by this app', tone: 'rose' };

export const installStateOf = (course: ProgrammeCourse): { label: string; tone: BadgeTone } =>
  INSTALL_STATES[course.state] ?? UNKNOWN_STATE;

/**
 * A course whose installed package predates signed academic metadata has had its files
 * verified but not its credits. Saying so beats presenting stale numbers as current.
 */
export const metadataCaveat = (course: ProgrammeCourse): string | null =>
  course.signedMetadata === false ? 'Signed academic metadata missing from this install — re-sync to pick it up.' : null;