import { loadCourseware as loadFrom, type CoursewareIndex } from '@sef/shared/node';
import { config } from './config';
import { log } from './logger';

export type { CoursewareCourse, CoursewareFile, CoursewareIndex } from '@sef/shared/node';

export async function loadCourseware(root = config.coursewareDir): Promise<CoursewareIndex> {
  const started = Date.now();
  const index = await loadFrom(root);
  for (const file of index.skipped) log.warn('courseware_file_skipped', { file, reason: 'no frontmatter' });
  log.info('courseware_loaded', { root, courses: index.courses.size, ms: Date.now() - started });
  return index;
}
