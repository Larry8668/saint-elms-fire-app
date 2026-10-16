import { randomUUID } from 'node:crypto';
import { CONTRACT_VERSION, WikiJobSchema, type ProfileIdentity, type WikiJob } from '@sef/shared';
import { log } from '../../config';
import { listJobs, readJob, writeJob } from '../vault-jobs';
import { checkSourceCount, INGEST_LIMITS, type Limits } from './limits';

/**
 * Job lifecycle for source ingestion. A job is durable from the moment it is created: every
 * stage change is written before the work it describes, so a restart resumes from the last
 * recorded stage and re-reads the *original* bytes rather than trusting anything derived.
 */

const TERMINAL = new Set<WikiJob['stage']>(['committed', 'no_changes', 'failed', 'cancelled']);

/** Legal stage moves. Anything else is a bug and is refused rather than silently applied. */
const TRANSITIONS: Record<WikiJob['stage'], WikiJob['stage'][]> = {
  queued: ['extracting', 'cancelled', 'failed'],
  extracting: ['awaiting_source_review', 'compiling', 'failed', 'cancelled'],
  awaiting_source_review: ['extracting', 'compiling', 'cancelled', 'failed'],
  compiling: ['awaiting_review', 'no_changes', 'failed', 'cancelled'],
  // An accepted proposal that changed nothing on disk ends the job as no_changes.
  awaiting_review: ['committed', 'no_changes', 'compiling', 'cancelled', 'failed'],
  committed: [],
  no_changes: [],
  failed: ['queued'],
  cancelled: [],
};

export const canTransition = (from: WikiJob['stage'], to: WikiJob['stage']): boolean => TRANSITIONS[from].includes(to);
export const isTerminal = (stage: WikiJob['stage']): boolean => TERMINAL.has(stage);

export class JobStateError extends Error {}
export class JobConflictError extends Error {}

export interface CreateJobInput {
  profile: ProfileIdentity;
  sourceIds: string[];
  now?: Date;
  id?: string;
}

export interface JobStore {
  root: string;
  write(job: WikiJob): Promise<void>;
  read(id: string): Promise<WikiJob | null>;
  list(): Promise<WikiJob[]>;
}

export const jobStore = (root: string): JobStore => ({
  root,
  write: (job) => writeJob(root, job),
  read: (id) => readJob(root, id),
  list: () => listJobs(root),
});

export function newJobId(): string {
  return `job_${randomUUID().replace(/-/g, '').slice(0, 20)}`;
}

/**
 * Creates a job, or returns the existing live job that already covers exactly these sources.
 * Re-ingesting the same material is therefore idempotent rather than a second copy.
 */
export async function createJob(store: JobStore, input: CreateJobInput, limits: Limits = {}): Promise<{ job: WikiJob; reused: boolean }> {
  const rejection = checkSourceCount(input.sourceIds.length, limits);
  if (rejection) throw new JobStateError(rejection.message);

  const mine = (await store.list()).filter((job) => job.profile.studentId === input.profile.studentId);
  const existing = mine.find((job) => !isTerminal(job.stage) && sameSources(job.sourceIds, input.sourceIds));
  if (existing) {
    log.info('job_reused', { jobId: existing.id, stage: existing.stage, sources: existing.sourceIds.length });
    return { job: existing, reused: true };
  }

  // The cap lives here, not only at the call site: any future caller gets it for free.
  assertJobCapacity(mine.filter((job) => !isTerminal(job.stage)).length, limits);

  const at = (input.now ?? new Date()).toISOString();
  const job = WikiJobSchema.parse({
    schemaVersion: CONTRACT_VERSION,
    id: input.id ?? newJobId(),
    profile: input.profile,
    sourceIds: input.sourceIds,
    createdAt: at,
    updatedAt: at,
    stage: 'queued',
    progress: { completed: 0, total: Math.max(1, input.sourceIds.length) },
    proposalId: null,
    error: null,
  });
  await store.write(job);
  log.info('job_created', { jobId: job.id, sources: job.sourceIds.length });
  return { job, reused: false };
}

const sameSources = (a: string[], b: string[]): boolean => a.length === b.length && [...a].sort().join(',') === [...b].sort().join(',');

/** Moves a job to a new stage, refusing an illegal move or an edit to a finished job. */
export async function advanceJob(
  store: JobStore,
  id: string,
  to: WikiJob['stage'],
  patch: { progress?: { completed: number; total: number }; error?: string | null; proposalId?: string | null; now?: Date } = {},
): Promise<WikiJob> {
  const job = await store.read(id);
  if (!job) throw new JobConflictError(`Job ${id} does not exist.`);
  if (!canTransition(job.stage, to)) throw new JobStateError(`A ${job.stage} job cannot become ${to}.`);
  if (isTerminal(job.stage) && job.stage !== 'failed') throw new JobStateError(`Job ${id} has already finished as ${job.stage}.`);

  const at = (patch.now ?? new Date()).toISOString();
  // Only `failed` carries an error, and only `failed` may lack one — the schema enforces both.
  // Its failures are re-thrown as JobStateError so callers of this API never see a ZodError.
  let next: WikiJob;
  try {
    next = WikiJobSchema.parse({
      ...job,
      stage: to,
      updatedAt: at,
      progress: patch.progress ?? job.progress,
      proposalId: patch.proposalId === undefined ? job.proposalId : patch.proposalId,
      error: to === 'failed' ? (patch.error ?? 'Extraction failed.') : null,
    });
  } catch (error) {
    const issue = (error as { issues?: Array<{ message?: string }> }).issues?.[0]?.message;
    throw new JobStateError(issue ?? `That job update is not valid: ${String(error)}`);
  }
  await store.write(next);
  log.info('job_advanced', { jobId: id, from: job.stage, to });
  return next;
}

export async function cancelJob(store: JobStore, id: string, now = new Date()): Promise<WikiJob> {
  const job = await store.read(id);
  if (!job) throw new JobConflictError(`Job ${id} does not exist.`);
  if (isTerminal(job.stage)) throw new JobStateError(`Job ${id} has already finished as ${job.stage}.`);
  return advanceJob(store, id, 'cancelled', { now });
}

/**
 * Retries a failed job from its original inputs. The sources are untouched, so a retry
 * re-extracts rather than resuming from half-finished derived text.
 */
export async function retryJob(store: JobStore, id: string, now = new Date()): Promise<WikiJob> {
  const job = await store.read(id);
  if (!job) throw new JobConflictError(`Job ${id} does not exist.`);
  if (job.stage !== 'failed') throw new JobStateError(`Only a failed job can be retried; ${id} is ${job.stage}.`);
  const next = await advanceJob(store, id, 'queued', { now });
  return next;
}

export interface JobSummary {
  /** Newest first; empty when this profile has never ingested anything. */
  jobs: WikiJob[];
  /** Non-terminal jobs, used to enforce the concurrency cap. */
  active: number;
}

export async function listProfileJobs(store: JobStore, profile: ProfileIdentity): Promise<JobSummary> {
  const mine = (await store.list()).filter((job) => job.profile.studentId === profile.studentId);
  const active = mine.filter((job) => !isTerminal(job.stage)).length;
  mine.sort((a, b) => Date.parse(b.createdAt) - Date.parse(a.createdAt));
  return { jobs: mine, active };
}

/** A profile may not start unlimited concurrent work. */
export function assertJobCapacity(active: number, limits: Limits = {}): void {
  const cap = limits.maxActiveJobs ?? INGEST_LIMITS.maxActiveJobs;
  if (active >= cap) throw new JobStateError(`You already have ${active} jobs in progress; the limit is ${cap}.`);
}
