import assert from 'node:assert/strict';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { CONTRACT_VERSION, type ProfileIdentity, type WikiJob } from '@sef/shared';
import {
  advanceJob,
  assertJobCapacity,
  canTransition,
  cancelJob,
  createJob,
  isTerminal,
  jobStore,
  JobConflictError,
  JobStateError,
  listProfileJobs,
  retryJob,
  type JobStore,
} from './jobs';

const profile = (studentId = 'stu_1'): ProfileIdentity => ({
  issuer: 'https://uni.example.test',
  studentId,
  programmeId: 'bsc-pma',
});

const harness = async (): Promise<JobStore> => jobStore(await mkdtemp(path.join(tmpdir(), 'sef-jobs-')));

const AT = new Date('2026-10-15T12:00:00.000Z');

test('a created job is queued with progress that cannot exceed its total', async () => {
  const store = await harness();
  const { job, reused } = await createJob(store, { profile: profile(), sourceIds: ['src_a', 'src_b'], now: AT });
  assert.equal(reused, false);
  assert.equal(job.stage, 'queued');
  assert.equal(job.progress.total, 2);
  assert.equal(job.error, null);
  assert.equal(job.proposalId, null);
  assert.match(job.id, /^job_[0-9a-f]{20}$/);
});

test('replaying the same sources reuses the live job instead of duplicating it', async () => {
  const store = await harness();
  const first = await createJob(store, { profile: profile(), sourceIds: ['src_a', 'src_b'], now: AT });
  const replay = await createJob(store, { profile: profile(), sourceIds: ['src_b', 'src_a'], now: AT });
  assert.equal(replay.reused, true, 'order must not matter');
  assert.equal(replay.job.id, first.job.id);
  assert.equal((await listProfileJobs(store, profile())).jobs.length, 1);
});

test('a different source set starts its own job', async () => {
  const store = await harness();
  await createJob(store, { profile: profile(), sourceIds: ['src_a'], now: AT });
  const other = await createJob(store, { profile: profile(), sourceIds: ['src_c'], now: AT });
  assert.equal(other.reused, false);
  assert.equal((await listProfileJobs(store, profile())).jobs.length, 2);
});

test('one student\'s job is never reused for another', async () => {
  const store = await harness();
  await createJob(store, { profile: profile('stu_1'), sourceIds: ['src_a'], now: AT });
  const other = await createJob(store, { profile: profile('stu_2'), sourceIds: ['src_a'], now: AT });
  assert.equal(other.reused, false, 'jobs are per-student');
});

test('the concurrency cap is enforced inside createJob, not only at the route', async () => {
  const store = await harness();
  await createJob(store, { profile: profile(), sourceIds: ['src_a'], now: AT }, { maxActiveJobs: 1 });
  await assert.rejects(
    createJob(store, { profile: profile(), sourceIds: ['src_b'], now: AT }, { maxActiveJobs: 1 }),
    JobStateError,
  );
  // Another student's active jobs do not count against this one.
  await createJob(store, { profile: profile('stu_2'), sourceIds: ['src_c'], now: AT }, { maxActiveJobs: 1 });
});

test('a finished job does not block a fresh ingest of the same material', async () => {
  const store = await harness();
  const first = await createJob(store, { profile: profile(), sourceIds: ['src_a'], now: AT });
  await advanceJob(store, first.job.id, 'extracting', { now: AT });
  await advanceJob(store, first.job.id, 'awaiting_source_review', { now: AT });
  await advanceJob(store, first.job.id, 'compiling', { now: AT });
  await advanceJob(store, first.job.id, 'no_changes', { now: AT });
  const again = await createJob(store, { profile: profile(), sourceIds: ['src_a'], now: AT });
  assert.equal(again.reused, false);
});

test('the stage machine refuses a move that skips the work', async () => {
  const store = await harness();
  const { job } = await createJob(store, { profile: profile(), sourceIds: ['src_a'], now: AT });
  await assert.rejects(() => advanceJob(store, job.id, 'committed', { now: AT }), JobStateError);
  await assert.rejects(() => advanceJob(store, job.id, 'awaiting_review', { now: AT }), JobStateError);
});

test('a legal sequence runs to awaiting_review and needs a proposal to commit', async () => {
  const store = await harness();
  const { job } = await createJob(store, { profile: profile(), sourceIds: ['src_a'], now: AT });
  await advanceJob(store, job.id, 'extracting', { progress: { completed: 1, total: 1 }, now: AT });
  await advanceJob(store, job.id, 'awaiting_source_review', { now: AT });
  await advanceJob(store, job.id, 'compiling', { now: AT });
  const review = await advanceJob(store, job.id, 'awaiting_review', { proposalId: 'prop_1', now: AT });
  assert.equal(review.stage, 'awaiting_review');
  // Committing still needs the proposal that review produced.
  await assert.rejects(() => advanceJob(store, job.id, 'committed', { proposalId: null, now: AT }), JobStateError);

  const committed = await advanceJob(store, job.id, 'committed', { proposalId: 'prop_1', now: AT });
  assert.equal(committed.proposalId, 'prop_1');
  assert.equal(committed.stage, 'committed');
});

test('only a failed job carries an error, and the schema enforces it', async () => {
  const store = await harness();
  const { job } = await createJob(store, { profile: profile(), sourceIds: ['src_a'], now: AT });
  const failed = await advanceJob(store, job.id, 'failed', { error: 'The PDF could not be read.' });
  assert.equal(failed.error, 'The PDF could not be read.');
  await assert.rejects(() => advanceJob(store, job.id, 'extracting', { error: 'still bad' }), JobStateError);
});

test('a job can be cancelled while it is still working, but not after it finished', async () => {
  const store = await harness();
  const { job } = await createJob(store, { profile: profile(), sourceIds: ['src_a'], now: AT });
  await advanceJob(store, job.id, 'extracting', { now: AT });
  const cancelled = await cancelJob(store, job.id, AT);
  assert.equal(cancelled.stage, 'cancelled');
  assert.equal(cancelled.error, null);
  await assert.rejects(() => cancelJob(store, job.id, AT), JobStateError);
});

test('a cancelled job cannot be revived', async () => {
  const store = await harness();
  const { job } = await createJob(store, { profile: profile(), sourceIds: ['src_a'], now: AT });
  await cancelJob(store, job.id, AT);
  await assert.rejects(() => retryJob(store, job.id, AT), JobStateError);
});

test('a failed job retries from queued, leaving its inputs untouched', async () => {
  const store = await harness();
  const { job } = await createJob(store, { profile: profile(), sourceIds: ['src_a', 'src_b'], now: AT });
  await advanceJob(store, job.id, 'extracting', { progress: { completed: 1, total: 2 }, now: AT });
  await advanceJob(store, job.id, 'failed', { error: 'Vision model unavailable.' });

  const retried = await retryJob(store, job.id, AT);
  assert.equal(retried.stage, 'queued');
  assert.equal(retried.error, null, 'a retry clears the previous failure');
  assert.deepEqual(retried.sourceIds, ['src_a', 'src_b'], 'the same original sources are re-read');
});

test('only a failed job may be retried', async () => {
  const store = await harness();
  const { job } = await createJob(store, { profile: profile(), sourceIds: ['src_a'], now: AT });
  await assert.rejects(() => retryJob(store, job.id, AT), JobStateError);
});

test('a job that does not exist is a conflict, not a crash', async () => {
  const store = await harness();
  await assert.rejects(() => advanceJob(store, 'job_missing', 'extracting'), JobConflictError);
  await assert.rejects(() => cancelJob(store, 'job_missing'), JobConflictError);
});

test('stage predicates describe the machine', () => {
  assert.equal(canTransition('queued', 'extracting'), true);
  assert.equal(canTransition('queued', 'committed'), false);
  assert.equal(isTerminal('committed'), true);
  assert.equal(isTerminal('queued'), false);
  assert.equal(isTerminal('failed'), true);
});

test('a profile cannot pile up unbounded concurrent jobs', async () => {
  const store = await harness();
  for (const id of ['src_a', 'src_b', 'src_c']) await createJob(store, { profile: profile(), sourceIds: [id], now: AT });
  const { active } = await listProfileJobs(store, profile());
  assert.equal(active, 3);
  // Below the cap a new job is fine; at the cap it is refused, because starting one more
  // would exceed it.
  assert.doesNotThrow(() => assertJobCapacity(active - 1, { maxActiveJobs: 3 }));
  assert.throws(() => assertJobCapacity(active, { maxActiveJobs: 3 }), JobStateError);
  assert.throws(() => assertJobCapacity(active, { maxActiveJobs: 2 }), JobStateError);
});

test('terminal stages stay terminal once reached', async () => {
  const store = await harness();
  const { job } = await createJob(store, { profile: profile(), sourceIds: ['src_a'], now: AT });
  await advanceJob(store, job.id, 'extracting', { now: AT });
  await advanceJob(store, job.id, 'awaiting_source_review', { now: AT });
  await advanceJob(store, job.id, 'compiling', { now: AT });
  await advanceJob(store, job.id, 'no_changes', { now: AT });
  assert.equal((await listProfileJobs(store, profile())).active, 0);
  await assert.rejects(() => advanceJob(store, job.id, 'committed', { proposalId: 'p', now: AT }), JobStateError);
});

test('a persisted job round-trips through the store and still validates', async () => {
  const store = await harness();
  const { job } = await createJob(store, { profile: profile(), sourceIds: ['src_a'], now: AT });
  const loaded = await store.read(job.id);
  assert.ok(loaded);
  assert.deepEqual(loaded as WikiJob, job);
  assert.equal(loaded!.schemaVersion, CONTRACT_VERSION);
});
