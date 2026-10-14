import { readdir, rm } from 'node:fs/promises';
import path from 'node:path';
import { lessonFromMarkdown, type CourseSummary, type Lesson } from '@sef/shared';
import { config, log } from '../config';
import { readJson, readText, writeFileAtomic, writeJson } from '../lib/fs';

export interface InstalledCourse extends CourseSummary {
  installedAt: string;
}

interface InstalledIndex {
  courses: Record<string, InstalledCourse>;
}

const INDEX_FILE = () => path.join(config.paths.content, 'installed.json');

/**
 * Courseware on this device. Only what the university released and signed ever
 * lands here, so "released lessons only" holds by construction.
 */
export class ContentStore {
  private lessons: Lesson[] | null = null;
  private index: InstalledIndex | null = null;

  async installed(): Promise<Record<string, InstalledCourse>> {
    if (!this.index) this.index = await readJson<InstalledIndex>(INDEX_FILE(), { courses: {} });
    return this.index.courses;
  }

  async install(course: CourseSummary, files: Array<{ path: string; content: string }>): Promise<void> {
    const dir = path.join(config.paths.content, 'courses', course.id);
    await rm(dir, { recursive: true, force: true });
    for (const file of files) {
      const target = path.resolve(dir, file.path);
      if (!target.startsWith(dir + path.sep)) throw new Error(`Refusing path outside course dir: ${file.path}`);
      await writeFileAtomic(target, file.content);
    }
    const courses = await this.installed();
    courses[course.id] = { ...course, installedAt: new Date().toISOString() };
    await writeJson(INDEX_FILE(), this.index);
    this.lessons = null;
    log.info('course_installed', { courseId: course.id, version: course.version, files: files.length });
  }

  async allLessons(): Promise<Lesson[]> {
    if (this.lessons) return this.lessons;
    const courses = await this.installed();
    const lessons: Lesson[] = [];
    for (const courseId of Object.keys(courses)) {
      const dir = path.join(config.paths.content, 'courses', courseId);
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
