import assert from 'node:assert/strict';
import { test } from 'node:test';
import { AudioTranscribeError } from '../../media/audio';
import { SourceIngestor, SourceRejection, type AudioReader } from './ingest';
import { JobConflictError, JobStateError } from './jobs';
import { PROFILE, tempRoot, vault } from '../testing/fixtures';

const harness = async (prefix: string, audio?: AudioReader) => {
  const store = await vault(prefix);
  const jobsRoot = await tempRoot(`${prefix}-jobs`);
  const ingestor = new SourceIngestor(store, async () => PROFILE, audio);
  return { store, jobsRoot, ingestor };
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

test('a media type outside the allowlist is refused with a 415 before anything is stored', async () => {
  const { store, ingestor } = await harness('ingest-media');
  const refused = await ingestor.ingest({ ...note('<script>alert(1)</script>'), mediaType: 'text/html' }).catch((e: unknown) => e);
  assert.ok(refused instanceof SourceRejection);
  assert.equal(refused.code, 'unsupported_media');
  assert.equal(refused.status, 415);
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

test('the listing reports what was extracted from the record itself', async () => {
  const { ingestor } = await harness('ingest-ledger');
  await ingestor.ingest(note('chapter notes'));
  await ingestor.ingest({ kind: 'image', title: 'Whiteboard', mediaType: 'image/png', bytes: Buffer.from([0x89, 0x50, 0x4e, 0x47]) });
  const list = await ingestor.list();

  const noteSummary = list.sources.find((source) => source.kind === 'note');
  assert.equal(noteSummary?.extracted, true, 'the ledger must survive a restart-shaped re-read');
  assert.equal(noteSummary?.partial, false);

  const imageSummary = list.sources.find((source) => source.kind === 'image');
  assert.equal(imageSummary?.extracted, false);
  assert.equal(imageSummary?.partial, true, 'an unread image is a partial pass, not a clean one');
});

test('a failed read is reported with the method that would have been used', async () => {
  const { ingestor } = await harness('ingest-method');
  const image = await ingestor.ingest({ kind: 'image', title: 'Board', mediaType: 'image/png', bytes: Buffer.from([0x89, 0x50, 0x4e, 0x47]) });
  assert.equal(image.extraction?.method, 'vision');

  const pdf = await ingestor.ingest({ kind: 'document', title: 'Broken', mediaType: 'application/pdf', bytes: Buffer.from('not a pdf', 'utf8') });
  assert.equal(pdf.extraction?.method, 'pdf');
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

test('a job owned by another profile answers 404 even over a shared vault root', async () => {
  const { store, ingestor } = await harness('ingest-owner');
  const { jobId } = await ingestor.ingest(note('mine'));
  // Sharing the vault root shares .meta/jobs — the ownership check must hold even then.
  const foreign = new SourceIngestor(store, async () => ({ ...PROFILE, studentId: 'student-b' }));
  // 404, not 403: a different profile must not even learn that the job exists.
  await assert.rejects(() => foreign.cancel(jobId), JobConflictError);
  await assert.rejects(() => foreign.retry(jobId), JobConflictError);
});

test('a profile cannot start more jobs than the cap allows', async () => {
  const { ingestor } = await harness('ingest-cap');
  for (let i = 0; i < 2; i++) await ingestor.ingest(note(`note ${i}`), { maxActiveJobs: 2 });
  await assert.rejects(() => ingestor.ingest(note('one too many'), { maxActiveJobs: 2 }), JobStateError);
});

test('a filed job pauses for source review before any compile is asked for', async () => {
  const { ingestor } = await harness('ingest-pause');
  const { jobId } = await ingestor.ingest(note('Read me first.'));
  const list = await ingestor.list();
  assert.equal(list.jobs.find((job) => job.id === jobId)?.stage, 'awaiting_source_review');
});

test('detail exposes the retained record, its reading and its job — and stays invisible to another profile', async () => {
  const { store, ingestor } = await harness('ingest-detail');
  const { source } = await ingestor.ingest(note('the words on the page'));

  const detail = await ingestor.detail(source.id);
  assert.equal(detail?.record.id, source.id);
  assert.match(detail?.extraction?.text ?? '', /words on the page/);
  assert.equal(detail?.job?.sourceIds[0], source.id);

  const foreign = new SourceIngestor(store, async () => ({ ...PROFILE, studentId: 'student-b' }));
  assert.equal(await foreign.detail(source.id), null, 'a foreign source answers null, not the record');
  assert.equal(await foreign.rawBytes(source.id), null);
});

test('raw bytes come back byte-for-byte, no matter what later passes recorded', async () => {
  const { ingestor } = await harness('ingest-raw');
  const original = Buffer.from('the original words', 'utf8');
  const { source } = await ingestor.ingest({ ...note('x'), bytes: original });
  await ingestor.correct(source.id, 'the corrected words');
  const raw = await ingestor.rawBytes(source.id);
  assert.deepEqual(raw?.bytes, new Uint8Array(original), 'corrections never reach the frozen original');
  assert.equal(raw?.mediaType, 'text/markdown');
});

test('a correction becomes the text a compile reads; the original bytes never move', async () => {
  const { store, ingestor } = await harness('ingest-correct');
  const { source } = await ingestor.ingest(note('momentum mas times velocity'));
  const before = await store.readSourceBytes(source.id);

  const detail = await ingestor.correct(source.id, 'momentum is mass times velocity');
  assert.equal(detail?.extraction?.method, 'student_correction');
  assert.match((await store.readExtractionText(source.id)) ?? '', /mass times velocity/);

  assert.deepEqual(await store.readSourceBytes(source.id), before, 'the frozen original is untouched by a correction');
  const record = await store.readSource(source.id);
  assert.equal(record?.extractions.at(-1)?.method, 'student_correction');
  assert.equal(record?.extractions.length, 2, 'the first pass stays in the ledger');
});

test('a missing source or an empty correction is refused, not written', async () => {
  const { ingestor } = await harness('ingest-correct-refused');
  const missing = await ingestor.correct('src_missing', 'text').catch((e: unknown) => e);
  assert.ok(missing instanceof SourceRejection);
  assert.equal(missing.status, 404);

  const { source } = await ingestor.ingest(note('keep me'));
  await assert.rejects(() => ingestor.correct(source.id, '   '), SourceRejection);
});

const audioFile = (over: Record<string, unknown> = {}) => ({
  kind: 'audio' as const,
  title: 'Lecture memo',
  mediaType: 'audio/m4a',
  bytes: Buffer.from([0x00, 0x00, 0x00, 0x20, 0x66, 0x74, 0x79, 0x70]),
  ...over,
});

const fakeAudio = (over: Partial<AudioReader> = {}): AudioReader => ({
  probe: async () => ({ seconds: 95 }),
  transcribe: async () => ({
    text: '[0:00] Waves carry energy.\n[0:49] Frequency is cycles per second.',
    seconds: 95,
    chunks: 2,
    attemptedChunks: 2,
    failedChunks: 0,
    partial: false,
  }),
  ...over,
});

test('a recording is stored, transcribed on arrival, and queued for review like any source', async () => {
  const { store, ingestor } = await harness('ingest-audio', fakeAudio());
  const result = await ingestor.ingest(audioFile());

  assert.equal(result.source.kind, 'audio');
  assert.equal(result.source.extracted, true);
  assert.equal(result.extraction?.method, 'audio');
  assert.match(result.extraction?.text ?? '', /Waves carry energy/);
  const record = await store.readSource(result.source.id);
  assert.equal(record?.extractions.at(-1)?.method, 'audio', 'the ledger records the audio pass');
  assert.ok(await store.readSourceBytes(result.source.id), 'the original audio bytes are kept');
});

test('a recording over the duration cap is refused before anything is stored', async () => {
  const { store, ingestor } = await harness('ingest-audio-long', fakeAudio());
  const refused = await ingestor.ingest(audioFile(), { maxAudioSeconds: 60 }).catch((e: unknown) => e);
  assert.ok(refused instanceof SourceRejection);
  assert.equal(refused.code, 'audio_too_long');
  assert.equal(refused.status, 413);
  assert.deepEqual(Object.keys(await store.listSources()), [], 'a refused upload leaves no trace');
});

test('audio bytes run against the audio cap, not the smaller document cap', async () => {
  const { ingestor } = await harness('ingest-audio-bytes', fakeAudio());
  const refused = await ingestor.ingest(audioFile(), { maxAudioBytes: 4 }).catch((e: unknown) => e);
  assert.ok(refused instanceof SourceRejection);
  assert.equal(refused.code, 'too_large');
  // And the same bytes are small enough for the audio cap's default.
  assert.equal((await ingestor.ingest(audioFile({ title: 'ok' }))).source.kind, 'audio');
});

test('a missing ffmpeg refuses the upload by name — nothing is kept it cannot read', async () => {
  const { store, ingestor } = await harness(
    'ingest-audio-ffmpeg',
    fakeAudio({
      probe: async () => {
        throw new AudioTranscribeError('ffmpeg is not installed on this device — audio sources need it (brew install ffmpeg).', 'ffmpeg_missing');
      },
    }),
  );
  const refused = await ingestor.ingest(audioFile()).catch((e: unknown) => e);
  assert.ok(refused instanceof SourceRejection);
  assert.equal(refused.code, 'ffmpeg_missing');
  assert.equal(refused.status, 503);
  assert.deepEqual(Object.keys(await store.listSources()), [], 'a refused upload leaves no trace');
});

test('a file claiming audio that ffmpeg cannot parse is refused before storage', async () => {
  const { store, ingestor } = await harness(
    'ingest-audio-unreadable',
    fakeAudio({
      probe: async () => {
        throw new AudioTranscribeError('That file does not contain a readable audio stream.', 'audio_unreadable');
      },
    }),
  );
  const refused = await ingestor.ingest(audioFile({ mediaType: 'audio/wav' })).catch((e: unknown) => e);
  assert.ok(refused instanceof SourceRejection);
  assert.equal(refused.code, 'unsupported_media');
  assert.deepEqual(Object.keys(await store.listSources()), []);
});

test('a recording filed while transcription is unavailable keeps its bytes and says why', async () => {
  const { store, ingestor } = await harness(
    'ingest-audio-down',
    fakeAudio({
      transcribe: async () => {
        throw new AudioTranscribeError('The transcription model could not be reached.', 'transcription_unavailable');
      },
    }),
  );
  const result = await ingestor.ingest(audioFile());
  assert.equal(result.source.extracted, false);
  assert.equal(result.source.partial, true);
  assert.match(result.source.note ?? '', /could not be reached/);
  assert.ok(await store.readSourceBytes(result.source.id), 'the recording itself is still kept');
});

test('with no transcriber wired, an audio source is stored and reports the missing lane', async () => {
  const { ingestor } = await harness('ingest-audio-unwired');
  const result = await ingestor.ingest(audioFile());
  assert.equal(result.source.extracted, false);
  assert.match(result.source.note ?? '', /not configured/);
});

test('partial transcripts stay honest: failed chunks are marked, not smoothed over', async () => {
  const { ingestor } = await harness(
    'ingest-audio-partial',
    fakeAudio({
      transcribe: async () => ({
        text: '[0:00] Waves carry energy.',
        seconds: 95,
        chunks: 2,
        attemptedChunks: 2,
        failedChunks: 1,
        partial: true,
        note: '1 of 2 audio chunks could not be transcribed.',
      }),
    }),
  );
  const result = await ingestor.ingest(audioFile());
  assert.equal(result.extraction?.partial, true);
  assert.match(result.extraction?.note ?? '', /1 of 2 audio chunks/);
});

test('a voice memo can be the student’s own; a model may never claim it', async () => {
  const { ingestor } = await harness('ingest-audio-origin', fakeAudio());
  const own = await ingestor.ingest(audioFile({ origin: 'student' }));
  assert.equal(own.source.kind, 'audio');
  const external = await ingestor.ingest(audioFile({ title: 'Lecture recording', origin: 'external' }));
  assert.equal(external.source.kind, 'audio');

  const refused = await ingestor.ingest(audioFile({ title: 'x', origin: 'model' })).catch((e: unknown) => e);
  assert.ok(refused instanceof SourceRejection);
  assert.equal(refused.code, 'origin_mismatch');
});

test('the audio family pins the kind — a mislabelled pair is refused before probing', async () => {
  const { store, ingestor } = await harness('ingest-audio-mismatch', fakeAudio());
  const wrongKind = await ingestor.ingest(audioFile({ kind: 'document' })).catch((e: unknown) => e);
  assert.ok(wrongKind instanceof SourceRejection);
  assert.equal(wrongKind.code, 'kind_mismatch');
  const wrongMedia = await ingestor.ingest(audioFile({ mediaType: 'text/plain' })).catch((e: unknown) => e);
  assert.ok(wrongMedia instanceof SourceRejection);
  assert.equal(wrongMedia.code, 'kind_mismatch');
  assert.deepEqual(Object.keys(await store.listSources()), []);
});

const videoFile = (over: Record<string, unknown> = {}) => ({
  kind: 'video' as const,
  title: 'A talk on orbits',
  mediaType: 'audio/wav',
  bytes: Buffer.from([0x52, 0x49, 0x46, 0x46]),
  link: { provider: 'youtube' as const, url: 'https://www.youtube.com/watch?v=abc123XYZ_0', videoId: 'abc123XYZ_0', fetchedAt: new Date().toISOString() },
  ...over,
});

test('a fetched video is an external source whose audio track transcribes like a recording', async () => {
  const { store, ingestor } = await harness('ingest-video', fakeAudio());
  const result = await ingestor.ingest(videoFile());

  assert.equal(result.source.kind, 'video');
  assert.equal(result.extraction?.method, 'audio', 'the stored track reads through the audio pipeline');
  assert.match(result.extraction?.text ?? '', /Waves carry energy/);
  const record = await store.readSource(result.source.id);
  assert.equal(record?.kind, 'video');
  if (record?.kind !== 'video') throw new Error('expected a video record');
  assert.equal(record.link.videoId, 'abc123XYZ_0', 'the URL provenance persists verbatim');
  assert.equal(record.link.provider, 'youtube');
});

test('a video without its link provenance is refused, and so is a video as own material', async () => {
  const { store, ingestor } = await harness('ingest-video-guards', fakeAudio());
  const noLink = await ingestor.ingest({ kind: 'video', title: 'x', mediaType: 'audio/wav', bytes: Buffer.from([1]) }).catch((e: unknown) => e);
  assert.ok(noLink instanceof SourceRejection);
  assert.equal(noLink.code, 'missing_link_ref');
  const own = await ingestor.ingest(videoFile({ origin: 'student' })).catch((e: unknown) => e);
  assert.ok(own instanceof SourceRejection);
  assert.equal(own.code, 'origin_mismatch');
  // A video kind over non-audio bytes trips the same pin a mislabelled recording does.
  const textBytes = await ingestor.ingest(videoFile({ title: 'y', mediaType: 'text/markdown' })).catch((e: unknown) => e);
  assert.ok(textBytes instanceof SourceRejection);
  assert.equal(textBytes.code, 'kind_mismatch');
  assert.deepEqual(Object.keys(await store.listSources()), []);
});
