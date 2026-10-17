import { createHash } from 'node:crypto';
import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import type { CourseSummary, LessonMeta } from '../content';
import { lessonFromMarkdown } from '../frontmatter';
import { loadProgrammeManifest, type ProgrammeManifestResult } from './programme';

export interface CoursewareFile {
  /** Path relative to the courseware root, POSIX separators. */
  path: string;
  content: string;
  sha256: string;
  bytes: number;
}

export interface CoursewareCourse {
  summary: CourseSummary;
  files: CoursewareFile[];
  lessons: LessonMeta[];
}

export interface CoursewareIndex {
  programmeId: string;
  programmeName: string;
  courses: Map<string, CoursewareCourse>;
  /** Markdown files without lesson frontmatter, so callers can log them. */
  skipped: string[];
  /** Normalized programme manifest, when the root has a valid one. */
  programme?: ProgrammeManifestResult;
}

const sha256 = (text: string) => createHash('sha256').update(text).digest('hex');

async function walkMarkdown(dir: string): Promise<string[]> {
  const out: string[] = [];
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) out.push(...(await walkMarkdown(full)));
    else if (entry.name.endsWith('.md') && entry.name !== 'course-catalog.md') out.push(full);
  }
  return out;
}

/** Best-effort manifest load; a missing file is not an error for demo seeding. */
async function loadManifest(root: string): Promise<ProgrammeManifestResult | undefined> {
  try {
    return await loadProgrammeManifest(root);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    return undefined;
  }
}

/** Reads every lesson under the courseware root and groups files by course. Used by the uni server and the demo seeder. */
export async function loadCourseware(root: string): Promise<CoursewareIndex> {
  const manifest = await loadManifest(root);
  const rowFor = new Map<string, NonNullable<ProgrammeManifestResult['programme']>['rows'][number]>();
  for (const row of manifest?.programme.rows ?? []) rowFor.set(row.courseId, row);

  const skipped: string[] = [];
  const grouped = new Map<string, { files: CoursewareFile[]; lessons: NonNullable<ReturnType<typeof lessonFromMarkdown>>[] }>();

  for (const file of await walkMarkdown(root)) {
    const content = await readFile(file, 'utf8');
    const lesson = lessonFromMarkdown(content, path.basename(file, '.md'));
    if (!lesson) {
      skipped.push(file);
      continue;
    }
    const entry = grouped.get(lesson.courseId) ?? { files: [], lessons: [] };
    entry.files.push({
      path: path.relative(root, file).split(path.sep).join('/'),
      content,
      sha256: sha256(content),
      bytes: Buffer.byteLength(content),
    });
    entry.lessons.push(lesson);
    grouped.set(lesson.courseId, entry);
  }

  const courses = new Map<string, CoursewareCourse>();
  for (const [courseId, { files, lessons }] of grouped) {
    files.sort((a, b) => a.path.localeCompare(b.path));
    lessons.sort((a, b) => a.moduleId.localeCompare(b.moduleId) || a.order - b.order);
    const first = lessons[0]!;
    const row = rowFor.get(courseId);
    const support = row ? row.courseType === 'Administrative Support' : first.subjectId === 'university-support';
    courses.set(courseId, {
      files,
      lessons: lessons.map(({ markdown: _body, ...meta }) => meta),
      summary: {
        id: courseId,
        title: row?.courseName ?? first.courseName,
        subjectId: row?.subjectId ?? first.subjectId,
        semesterNumber: row ? row.semesterNumber : support ? 0 : first.semesterNumber,
        code: row?.courseCode,
        courseCode: row?.courseCode,
        courseType: row?.courseType,
        credits: row?.credits,
        hoursPerWeek: row?.hoursPerWeek,
        deliveryMode: row?.deliveryMode,
        status: row?.status,
        optionGroup: row?.optionGroup,
        prerequisites: row?.prerequisites,
        description: row?.notes,
        subjectFeeds: row?.subjectFeeds,
        lessonCount: files.length,
        version: sha256(files.map((f) => `${f.path}:${f.sha256}`).join('\n')).slice(0, 16),
        support,
      },
    });
  }

  return {
    programmeId: manifest?.programme.id ?? 'programme',
    programmeName: manifest?.programme.name ?? 'Programme',
    courses,
    skipped,
    programme: manifest,
  };
}
