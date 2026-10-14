import path from 'node:path';
import { readFile } from 'node:fs/promises';
import { z } from 'zod';
import { config } from '../config';
import { readJson, writeJson } from './json-file';

const ReleasesSchema = z.object({
  defaultCohort: z.string(),
  cohorts: z.record(z.string(), z.object({ name: z.string(), courses: z.array(z.string()) })),
});
export type Releases = z.infer<typeof ReleasesSchema>;

export class UnknownCohortError extends Error {}

/**
 * Which courses each cohort may download. The repo file is the seed; admin edits are persisted
 * under the data dir so the checked-in config stays clean.
 */
export class ReleaseStore {
  private state: Releases = { defaultCohort: '', cohorts: {} };
  private readonly runtimeFile: string;

  constructor(
    private readonly seedFile = config.releasesFile,
    dataDir = config.dataDir,
  ) {
    this.runtimeFile = path.join(dataDir, 'releases.json');
  }

  async load(): Promise<void> {
    const seed = ReleasesSchema.parse(JSON.parse(await readFile(this.seedFile, 'utf8')));
    this.state = ReleasesSchema.parse(await readJson(this.runtimeFile, seed));
  }

  get defaultCohort(): string {
    return this.state.defaultCohort;
  }

  cohorts(): Array<{ id: string; name: string; courses: string[] }> {
    return Object.entries(this.state.cohorts).map(([id, c]) => ({ id, ...c }));
  }

  has(cohortId: string): boolean {
    return Boolean(this.state.cohorts[cohortId]);
  }

  resolve(requested?: string | null): string {
    return requested && this.has(requested) ? requested : this.state.defaultCohort;
  }

  isReleased(cohortId: string, courseId: string): boolean {
    const courses = this.state.cohorts[cohortId]?.courses ?? [];
    return courses.includes('*') || courses.includes(courseId);
  }

  async setReleased(cohortId: string, courseIds: string[], released: boolean): Promise<void> {
    const cohort = this.state.cohorts[cohortId];
    if (!cohort) throw new UnknownCohortError(cohortId);
    const set = new Set(cohort.courses);
    for (const id of courseIds) released ? set.add(id) : set.delete(id);
    await this.commit({ ...this.state.cohorts, [cohortId]: { ...cohort, courses: [...set] } });
  }

  async createCohort(id: string, name: string, courses: string[] = []): Promise<void> {
    await this.commit({ ...this.state.cohorts, [id]: { name, courses } });
  }

  /** Persists first, then swaps in memory, so a failed write never leaves memory ahead of disk. */
  private async commit(cohorts: Releases['cohorts']): Promise<void> {
    const next = { ...this.state, cohorts };
    await writeJson(this.runtimeFile, next);
    this.state = next;
  }
}
