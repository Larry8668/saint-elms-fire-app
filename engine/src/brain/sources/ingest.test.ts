import assert from 'node:assert/strict';
import { test } from 'node:test';
import { SourceIngestor, SourceRejection } from './ingest';
import { JobStateError } from './jobs';
import { PROFILE, tempRoot, vault } from '../testing/fixtures';

const harness = async (prefix: string) => {
  const store = await vault(prefix);
  const jobsRoot = await tempRoot(`${prefix}-jobs`);
  const ingestor = new SourceIngestor(store, jobsRoot, async () => PROFILE);
  return { store, ingestor };
};

const note = (content: string, title = 'Lecture notes') => ({
  kind: 'note' as const,
  title,
  mediaType: 'text/markdown',
  bytes: Buffer.from(content, 'utf8'),
});

test('a text source is stored before it is read, and read on arrival', async () => {
  const { store, ingestor } = await harness('ingest-text');
  const result = await ingestor.ingest(note('# Waves\n\nA note.'));

  assert.equal(result.source.title, 'Lecture notes');
  assert.equal(result.source.kind, 'note');
  assert.equal(result.source.extracted, true);
  assert.equal(result.source.partial, false);
  assert.equal(result.extraction?.method, 'text');
  assert.match(result.extraction?.text ?? '', /Waves/);

  // The original bytes are in the vault, not just the extraction.
  const stored = await store.readSourceBytes(result.source.id);
  assert.ok(stored);
  assert.match(stored.toString('utf8'), /A note\./);
});

test('an unsafe title is refused and nothing is written', async () => {
  const { store, ingestor } = await harness('ingest-title');
  await assert.rejects(() => ingestor.ingest(note('x', '../../escape')), SourceRejection);
  assert.deepEqual(Object.keys(await store.listSources()), [], 'a refused upload leaves no trace');
});

test('an empty source is refused with a 400 and an oversized one with a 413', async () => {
  const { ingestor } = await harness('ingest-size');
  const empty = await ingestor.ingest({ ...note(''), bytes: Buffer.alloc(0) }).catch((e: unknown) => e);
  assert.ok(empty instanceof SourceRejection);
  assert.equal(empty.status, 400);

  const huge = await ingestor.ingest({ ...note('x'), bytes: Buffer.alloc(64) }, { maxSourceBytes: 32 }).catch((e: unknown) => e);
  assert.ok(huge instanceof SourceRejection);
  assert.equal(huge.status, 413);
});

test('an image is kept and reported as not yet read, rather than given an invented reading', async () => {
  const { store, ingestor } = await harness('ingest-image');
  const result = await ingestor.ingest({
    kind: 'image',
    title: 'Whiteboard',
    mediaType: 'image/png',
    bytes: Buffer.from([0x89, 0x50, 0x4e, 0x47]),
  });
  assert.equal(result.source.extracted, false);
  assert.match(result.source.note ?? '', /No text has been read from this image yet/);
  assert.ok(await store.readSourceBytes(result.source.id), 'the image itself is still kept');
});

test('a damaged PDF keeps its bytes and says it could not be read', async () => {
  const { store, ingestor } = await harness('ingest-pdf');
  const result = await ingestor.ingest({
    kind: 'document',
    title: 'Syllabus',
    mediaType: 'application/pdf',
    bytes: Buffer.from('this is definitely not a pdf', 'utf8'),
  });
  assert.equal(result.source.partial, true);
  assert.match(result.source.note ?? '', /could not be opened|damaged|could not be read/i);
  assert.ok(await store.readSourceBytes(result.source.id), 'the bytes survive a failed read');
});

test('ingesting records a job so the work is visible and cancellable', async () => {
  const { ingestor } = await harness('ingest-job');
  const result = await ingestor.ingest(note('something'));
  const list = await ingestor.list();

  assert.equal(list.jobs.length, 1);
  assert.equal(list.jobs[0]!.id, result.jobId);
  assert.equal(list.jobs[0]!.sourceIds.length, 1);
  assert.equal(list.sources.length, 1);
  assert.equal(list.activeJobs, 1);
});

test('the listing never returns source bodies, only metadata', async () => {
  const { ingestor } = await harness('ingest-list');
  await ingestor.ingest(note('a private note body'));
  const raw = JSON.stringify(await ingestor.list());
  assert.ok(!raw.includes('a private note body'), 'the listing must not leak content');
});

test('a job can be cancelled and a cancelled job cannot be retried', async () => {
  const { ingestor } = await harness('ingest-cancel');
  const result = await ingestor.ingest(note('cancel me'));
  await ingestor.cancel(result.jobId);
  const list = await ingestor.list();
  assert.equal(list.jobs[0]!.stage, 'cancelled');
  assert.equal(list.activeJobs, 0);
  await assert.rejects(() => ingestor.retry(result.jobId), JobStateError);
});

test('a profile cannot start more jobs than the cap allows', async () => {
  const { ingestor } = await harness('ingest-cap');
  for (let i = 0; i < 2; i++) await ingestor.ingest(note(`note ${i}`), { maxActiveJobs: 2 });
  await assert.rejects(() => ingestor.ingest(note('one too many'), { maxActiveJobs: 2 }), JobStateError);
});
