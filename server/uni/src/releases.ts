import { readFile } from 'node:fs/promises';
import { z } from 'zod';
import { config } from './config';

const ReleasesSchema = z.object({
  defaultCohort: z.string(),
  cohorts: z.record(z.string(), z.object({ name: z.string(), courses: z.array(z.string()) })),
});
export type Releases = z.infer<typeof ReleasesSchema>;

export async function loadReleases(file = config.releasesFile): Promise<Releases> {
  return ReleasesSchema.parse(JSON.parse(await readFile(file, 'utf8')));
}

export function resolveCohort(releases: Releases, requested?: string | null): string {
  return requested && releases.cohorts[requested] ? requested : releases.defaultCohort;
}

export function isReleased(releases: Releases, cohortId: string, courseId: string): boolean {
  const courses = releases.cohorts[cohortId]?.courses ?? [];
  return courses.includes('*') || courses.includes(courseId);
}
