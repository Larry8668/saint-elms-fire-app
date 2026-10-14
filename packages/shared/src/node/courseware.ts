import { createHash } from 'node:crypto';
import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import { parse } from 'yaml';
import type { CourseSummary, LessonMeta } from '../content';
import { lessonFromMarkdown } from '../frontmatter';

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
}

interface ManifestRow {
  courseId: string;
  courseName?: string;
  courseCode?: string;
  subjectId?: string;
  notes?: string;
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

async function readManifest(root: string) {
  const raw = parse(await readFile(path.join(root, 'programme-manifest.yaml'), 'utf8')) as Record<string, unknown>;
  const rows = new Map<string, ManifestRow>();
  for (const [key, value] of Object.entries(raw)) {
    if (!/^semester-\d+$/.test(key) || !value || typeof value !== 'object') continue;
    const list = (value as { rows?: unknown }).rows;
    if (!Array.isArray(list)) continue;
    for (const row of list as ManifestRow[]) if (row?.courseId) rows.set(row.courseId, row);
  }
  return {
    programmeId: String(raw.programmeId ?? 'programme'),
    programmeName: String(raw.programmeName ?? 'Programme'),
    rows,
  };
}

/** Reads every lesson under the courseware root and groups files by course. Used by the uni server and the demo seeder. */
export async function loadCourseware(root: string): Promise<CoursewareIndex> {
  const manifest = await readManifest(root);
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
    const row = manifest.rows.get(courseId);
    const support = first.subjectId === 'university-support';
    courses.set(courseId, {
      files,
      lessons: lessons.map(({ markdown: _body, ...meta }) => meta),
      summary: {
        id: courseId,
        title: row?.courseName ?? first.courseName,
        subjectId: row?.subjectId ?? first.subjectId,
        semesterNumber: support ? 0 : first.semesterNumber,
        code: row?.courseCode,
        description: row?.notes,
        lessonCount: files.length,
        version: sha256(files.map((f) => `${f.path}:${f.sha256}`).join('\n')).slice(0, 16),
        support,
      },
    });
  }

  return { programmeId: manifest.programmeId, programmeName: manifest.programmeName, courses, skipped };
}
