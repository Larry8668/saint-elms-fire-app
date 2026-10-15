import { availabilityFor, courseFilesIn, loadCourseware as loadFrom, loadProgrammeManifest, type CoursewareIndex, type ProgrammeManifestResult } from '@sef/shared/node';
import type { CourseAvailability } from '@sef/shared';
import { config } from './config';
import { log } from './logger';

export type { CoursewareCourse, CoursewareFile, CoursewareIndex, ProgrammeManifestResult } from '@sef/shared/node';

export async function loadCourseware(root = config.coursewareDir): Promise<CoursewareIndex> {
  const started = Date.now();
  const index = await loadFrom(root);
  for (const file of index.skipped) log.warn('courseware_file_skipped', { file, reason: 'no frontmatter' });
  log.info('courseware_loaded', { root, courses: index.courses.size, ms: Date.now() - started });
  return index;
}

/** Loads the normalized programme manifest for admissions, catalogues and signed metadata. */
export async function loadProgramme(root = config.coursewareDir): Promise<ProgrammeManifestResult | null> {
  try {
    const result = await loadProgrammeManifest(root);
    for (const d of result.diagnostics) {
      (d.level === 'error' ? log.error : log.warn)('programme_manifest_diagnostic', {
        level: d.level,
        code: d.code,
        message: d.message,
        rowId: d.rowId,
        courseId: d.courseId,
      });
    }
    log.info('programme_loaded', {
      rows: result.programme.rows.length,
      semesters: result.semesters.length,
      optionGroups: result.programme.optionGroups.length,
      diagnostics: result.diagnostics.length,
    });
    return result;
  } catch (error) {
    log.error('programme_manifest_failed', { root, error: (error as Error).message });
    return null;
  }
}

/** Per-row content/release/selection state, derived once at boot from the content tree. */
export async function programmeAvailability(programme: ProgrammeManifestResult): Promise<Record<string, CourseAvailability>> {
  const availability: Record<string, CourseAvailability> = {};
  for (const row of programme.programme.rows) {
    availability[row.rowId] = availabilityFor(row, await courseFilesIn(config.coursewareDir, row));
  }
  return availability;
}
