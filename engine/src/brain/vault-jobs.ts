import { readdir } from 'node:fs/promises';
import { WikiJobSchema, type WikiJob } from '@sef/shared';
import { readJson, writeJson } from '../lib/fs';
import { META_DIRECTORY, META_JOBS_DIRECTORY, assertRecordId, vaultPath } from './vault-layout';

/**
 * One file per job under .meta/jobs/. A job is a single record with no cross-file invariant, so an
 * atomic write is enough; the multi-file invariant only ever spans a page commit, which is journaled.
 */
export function jobPath(root: string, id: string): string {
  return vaultPath(root, META_DIRECTORY, META_JOBS_DIRECTORY, `${assertRecordId(id, 'Job id')}.json`);
}

export async function writeJob(root: string, job: WikiJob): Promise<void> {
  await writeJson(jobPath(root, job.id), WikiJobSchema.parse(job));
}

export async function readJob(root: string, id: string): Promise<WikiJob | null> {
  const raw = await readJson<unknown>(jobPath(root, id), null);
  const job = WikiJobSchema.safeParse(raw);
  return job.success ? job.data : null;
}

export async function listJobs(root: string): Promise<WikiJob[]> {
  const jobs: WikiJob[] = [];
  const entries = await readdir(vaultPath(root, META_DIRECTORY, META_JOBS_DIRECTORY), { withFileTypes: true }).catch(() => []);
  for (const entry of entries) {
    if (!entry.isFile() || !entry.name.endsWith('.json')) continue;
    const job = await readJob(root, entry.name.slice(0, -5));
    if (job) jobs.push(job);
  }
  return jobs;
}
