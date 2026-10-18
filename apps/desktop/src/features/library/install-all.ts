/**
 * "Download all" installs one course per request, in order. A single install-all request
 * outlives a hosted edge's timeout on a large release list (the install finishes, but the
 * client sees an error); one course per request keeps every call short, lets the student
 * watch the count move, and lets one bad package fail alone without stopping the rest.
 */

export interface InstallTarget {
  id: string;
  title: string;
}

export interface InstallProgress {
  /** 1-based position of the course being installed now. */
  current: number;
  total: number;
  courseId: string;
  title: string;
}

export interface InstallFailure {
  courseId: string;
  title: string;
  message: string;
}

export interface InstallAllResult {
  total: number;
  installed: string[];
  failed: InstallFailure[];
}

export async function installSequentially(
  courses: InstallTarget[],
  install: (courseId: string) => Promise<unknown>,
  onProgress?: (progress: InstallProgress) => void,
): Promise<InstallAllResult> {
  const installed: string[] = [];
  const failed: InstallFailure[] = [];
  for (const [index, course] of courses.entries()) {
    onProgress?.({ current: index + 1, total: courses.length, courseId: course.id, title: course.title });
    try {
      await install(course.id);
      installed.push(course.id);
    } catch (error) {
      failed.push({ courseId: course.id, title: course.title, message: error instanceof Error ? error.message : String(error) });
    }
  }
  return { total: courses.length, installed, failed };
}

export const progressLabel = (progress: InstallProgress) => `Installing ${progress.current} of ${progress.total}…`;

/** The one-line outcome shown once the run ends. */
export function resultSummary(result: InstallAllResult): string {
  const plural = (n: number) => `${n} course${n === 1 ? '' : 's'}`;
  if (!result.failed.length) return `Installed ${plural(result.installed.length)} — verified on this device`;
  if (!result.installed.length) return `None of the ${plural(result.total)} could be installed`;
  return `Installed ${result.installed.length} of ${plural(result.total)} — ${result.failed.length} failed`;
}
