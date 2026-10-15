import { mkdir, readdir, rename, rm } from 'node:fs/promises';
import path from 'node:path';
import { lessonFromMarkdown, type CourseSummary, type Lesson } from '@sef/shared';
import { log } from '../config';
import { readJson, readText, writeFileAtomic, writeJson } from '../lib/fs';

/** True when the path exists; used to decide whether an install has a previous version. */
async function exists(target: string): Promise<boolean> {
  return readdir(path.dirname(target)).then((entries) => entries.includes(path.basename(target)), () => false);
}

export interface InstalledCourse extends CourseSummary {
  installedAt: string;
  /** False when the manifest that produced this install predates signed metadata. */
  signedMetadata?: boolean;
}

interface InstalledIndex {
  courses: Record<string, InstalledCourse>;
}

/**
 * Courseware on this device. Only what the university released and signed ever
 * lands here, so "released lessons only" holds by construction.
 */
export class ContentStore {
  private lessons: Lesson[] | null = null;
  private index: InstalledIndex | null = null;

  constructor(private readonly dir: string) {}

  private get indexFile() {
    return path.join(this.dir, 'installed.json');
  }

  async installed(): Promise<Record<string, InstalledCourse>> {
    if (!this.index) this.index = await readJson<InstalledIndex>(this.indexFile, { courses: {} });
    return this.index.courses;
  }

  /**
   * Replace a course's files as a unit. The new tree is staged beside the live one and only
   * swapped in once every file is written, so a failure or a crash mid-install leaves the
   * previous working installation exactly as it was rather than half-replaced.
   */
  async install(course: CourseSummary, files: Array<{ path: string; content: string }>, signedMetadata = true): Promise<void> {
    const coursesDir = path.join(this.dir, 'courses');
    const dir = path.join(coursesDir, course.id);
    const staging = `${dir}.staging-${process.pid}-${Date.now().toString(36)}`;
    const retired = `${dir}.retired-${process.pid}-${Date.now().toString(36)}`;

    // Everything that can reject the package does so before the live tree is touched.
    for (const file of files) {
      const target = path.resolve(staging, file.path);
      if (!target.startsWith(staging + path.sep)) throw new Error(`Refusing path outside course dir: ${file.path}`);
    }

    let hadPrevious = false;
    try {
      await rm(staging, { recursive: true, force: true });
      // Created up front so a course with no files still has a real directory to swap in.
      await mkdir(staging, { recursive: true });
      for (const file of files) {
        const target = path.resolve(staging, file.path);
        await writeFileAtomic(target, file.content);
      }
      hadPrevious = await exists(dir);
      if (hadPrevious) await rename(dir, retired);
      await rename(staging, dir);
    } catch (error) {
      // Put the previous installation back before surfacing the failure.
      await rm(staging, { recursive: true, force: true }).catch(() => {});
      if (hadPrevious && !(await exists(dir))) {
        await rename(retired, dir).catch((rollback) => log.error('course_install_rollback_failed', { courseId: course.id, error: String(rollback) }));
      } else {
        await rm(retired, { recursive: true, force: true }).catch(() => {});
      }
      throw error;
    }
    await rm(retired, { recursive: true, force: true }).catch(() => {});

    const installed = await this.installed();
    installed[course.id] = { ...course, installedAt: new Date().toISOString(), signedMetadata };
    await writeJson(this.indexFile, this.index);
    this.lessons = null;
    log.info('course_installed', { courseId: course.id, version: course.version, files: files.length, signedMetadata });
  }

  async allLessons(): Promise<Lesson[]> {
    if (this.lessons) return this.lessons;
    const courses = await this.installed();
    const lessons: Lesson[] = [];
    for (const courseId of Object.keys(courses)) {
      const dir = path.join(this.dir, 'courses', courseId);
      for (const file of await walk(dir)) {
        const raw = await readText(file);
        const lesson = raw ? lessonFromMarkdown(raw, path.basename(file, '.md')) : null;
        if (lesson) lessons.push(lesson);
      }
    }
    lessons.sort((a, b) => a.semesterNumber - b.semesterNumber || a.courseId.localeCompare(b.courseId) || a.order - b.order);
    this.lessons = lessons;
    log.info('content_loaded', { courses: Object.keys(courses).length, lessons: lessons.length });
    return lessons;
  }

  async academicLessons(): Promise<Lesson[]> {
    const courses = await this.installed();
    return (await this.allLessons()).filter((l) => !courses[l.courseId]?.support);
  }

  async supportLessons(): Promise<Lesson[]> {
    const courses = await this.installed();
    return (await this.allLessons()).filter((l) => courses[l.courseId]?.support);
  }

  async lesson(id: string): Promise<Lesson | undefined> {
    return (await this.allLessons()).find((l) => l.id === id);
  }
}

async function walk(dir: string): Promise<string[]> {
  const out: string[] = [];
  let entries;
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch {
    return out;
  }
  for (const entry of entries) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) out.push(...(await walk(full)));
    else if (entry.name.endsWith('.md')) out.push(full);
  }
  return out;
}
