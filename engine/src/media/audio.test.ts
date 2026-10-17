import assert from 'node:assert/strict';
import { readFileSync, writeFileSync } from 'node:fs';
import { mkdtemp, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { after, test } from 'node:test';
import type { StoredSettings } from '../settings/store';
import { AudioTranscriber, AudioTranscribeError, chunkPlan, parseFfmpegDuration, trimSeamOverlap, wavWrap, type RunCommand } from './audio';

/** Each test's temp root, removed once the file finishes so runs leave nothing behind in tmpdir. */
const madeDirs: string[] = [];
const tempDir = async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'sef-audio-test-'));
  madeDirs.push(dir);
  return dir;
};
after(() => Promise.all(madeDirs.map((dir) => rm(dir, { recursive: true, force: true }))));

/** Settings with an Ollama vision role — resolved but never contacted by the fakes. */
const settings = (providerKind: 'ollama' | 'anthropic' = 'ollama') =>
  ({
    get: async () =>
      ({
        providers: [{ id: 'p', kind: providerKind, label: 'Test provider', baseUrl: 'http://127.0.0.1:9', ...(providerKind === 'anthropic' ? { apiKey: 'k' } : {}) }],
        roles: { vision: { provider: 'p', model: 'gemma4:e4b' } },
      }) as StoredSettings,
  }) satisfies { get(): Promise<StoredSettings> };

/** ffmpeg's `-i` answer is a non-zero exit whose stderr carries the stream description. */
const probeStderr = (duration: string) =>
  `Input #0, wav, from 'pipe:0':\n  Duration: ${duration}, bitrate: 256 kb/s\n  Stream #0:0: Audio: pcm_s16le, 16000 Hz, mono\nAt least one output file must be specified\n`;

/**
 * A fake ffmpeg: `-i` answers the canned probe stderr, the normalize step writes synthetic
 * mono PCM of the requested seconds to the output path (the last argv element).
 */
const fakeRun = (seconds: number, overrides: { probeStderr?: string } = {}): { run: RunCommand; calls: string[][]; staged: Array<{ stdin: boolean; bytes: number[] }> } => {
  const calls: string[][] = [];
  const staged: Array<{ stdin: boolean; bytes: number[] }> = [];
  const run: RunCommand = async (_command, args, opts) => {
    calls.push(args);
    const input = args[args.indexOf('-i') + 1]!;
    staged.push({ stdin: opts?.input !== undefined || input === 'pipe:0', bytes: input === 'pipe:0' ? [] : [...readFileSync(input)] });
    const outIndex = args.indexOf('-f');
    if (outIndex === -1) {
      return { code: 1, stdout: '', stderr: overrides.probeStderr ?? probeStderr(new Date(seconds * 1000).toISOString().slice(11, 23)) };
    }
    const pcmPath = args[args.length - 1]!;
    writeFileSync(pcmPath, Buffer.alloc(Math.round(seconds * 32_000)));
    return { code: 0, stdout: '', stderr: '' };
  };
  return { run, calls, staged };
};

const fakeFetch = (answer: (chunk: number) => string | null) => {
  const calls: Array<{ url: string; size: number }> = [];
  let n = 0;
  const fetchFn = async (url: string | URL | Request, init?: RequestInit) => {
    calls.push({ url: String(url), size: (init?.body as FormData).get('file') instanceof Blob ? ((init!.body as FormData).get('file') as Blob).size : 0 });
    const body = answer(n++);
    if (body === null) return new Response('down', { status: 503 });
    return new Response(body, { status: 200 });
  };
  return { fetchFn: fetchFn as typeof fetch, calls };
};

const bytes = new Uint8Array([0x52, 0x49, 0x46, 0x46]);

test('ffmpeg duration parses from the -i stderr, and only there', () => {
  assert.equal(parseFfmpegDuration(probeStderr('00:02:05.50')), 125.5);
  assert.equal(parseFfmpegDuration('garbage'), null);
});

test('the chunk plan is ~50s windows stepping 49s — overlap, not gaps', () => {
  assert.deepEqual(chunkPlan(30), [{ start: 0, length: 30 }]);
  assert.deepEqual(chunkPlan(120), [
    { start: 0, length: 50 },
    { start: 49, length: 50 },
    { start: 98, length: 22 },
  ]);
  // A recording just over one window still gets its tail chunk.
  assert.equal(chunkPlan(50.5).length, 2);
  assert.deepEqual(chunkPlan(0.4), [{ start: 0, length: 0.4 }]);
});

test('wavWrap produces a playable RIFF header over the PCM slice', () => {
  const pcm = new Uint8Array(32_000); // one second of silence
  const wav = Buffer.from(wavWrap(pcm));
  assert.equal(wav.subarray(0, 4).toString('ascii'), 'RIFF');
  assert.equal(wav.subarray(8, 12).toString('ascii'), 'WAVE');
  assert.equal(wav.readUInt32LE(24), 16_000, 'the declared sample rate is the normalized one');
  assert.equal(wav.readUInt32LE(40), pcm.byteLength);
  assert.equal(wav.byteLength, 44 + pcm.byteLength);
});

test('probe reports the stream duration and refuses non-audio by name', async () => {
  const dir = await tempDir();
  const { run } = fakeRun(95);
  const transcriber = new AudioTranscriber(settings(), { run, tmpRoot: dir });
  assert.equal((await transcriber.probe(bytes, 'audio/wav')).seconds, 95);

  const unreadable = new AudioTranscriber(settings(), { run: async () => ({ code: 1, stdout: '', stderr: 'pipe:0: Invalid data found when processing input' }), tmpRoot: dir });
  const error = await unreadable.probe(bytes, 'audio/wav').catch((e: unknown) => e);
  assert.ok(error instanceof AudioTranscribeError);
  assert.equal(error.code, 'audio_unreadable');
});

test('a multi-chunk recording joins transcripts with absolute timestamps', async () => {
  const dir = await tempDir();
  const { run, calls } = fakeRun(120);
  const { fetchFn, calls: posts } = fakeFetch((n) => JSON.stringify({ text: `words of chunk ${n}` }));
  const transcriber = new AudioTranscriber(settings(), { run, fetchFn, tmpRoot: dir });

  const result = await transcriber.transcribe(bytes, 'audio/m4a');
  assert.equal(result.chunks, 3);
  assert.equal(result.failedChunks, 0);
  assert.equal(result.partial, false);
  assert.deepEqual(posts.map((c) => c.url), ['http://127.0.0.1:9/v1/audio/transcriptions', 'http://127.0.0.1:9/v1/audio/transcriptions', 'http://127.0.0.1:9/v1/audio/transcriptions']);
  const lines = result.text.split('\n');
  assert.match(lines[0]!, /^\[0:00\] words of chunk 0$/);
  assert.match(lines[1]!, /^\[0:49\] words of chunk 1$/);
  assert.match(lines[2]!, /^\[1:38\] words of chunk 2$/);
  // One probe, one normalize — both read the same staged file, never stdin.
  assert.equal(calls.length, 2);
  assert.equal(calls[1]!.includes('-f'), true);
});

test('ffmpeg reads a seekable staged file holding the bytes, and every staging folder is removed', async () => {
  const dir = await tempDir();
  const { run, staged } = fakeRun(60);
  const { fetchFn } = fakeFetch(() => JSON.stringify({ text: 'ok' }));
  const transcriber = new AudioTranscriber(settings(), { run, fetchFn, tmpRoot: dir });

  await transcriber.probe(bytes, 'audio/mp4');
  await Promise.all([transcriber.transcribe(bytes, 'audio/mp4'), transcriber.transcribe(bytes, 'audio/mp4')]);
  assert.equal(staged.length, 5);
  for (const call of staged) {
    assert.equal(call.stdin, false, 'an MP4 with its index at the end cannot be demuxed from a pipe');
    assert.deepEqual(call.bytes, [...bytes]);
  }
  assert.deepEqual(await readdir(dir), [], 'concurrent calls staged in their own folders and cleaned up');
});

test('seam overlap: the repeated run at a chunk boundary is dropped once, case and punctuation aside', () => {
  const previous = '[0:00] you need pseudo forces like the centrifugal force to make';
  assert.equal(trimSeamOverlap(previous, "[0:49] force to make Newton's laws work"), "[0:49] Newton's laws work");
  assert.equal(trimSeamOverlap('[0:00] Force, to Make.', '[0:49] force to make it work'), '[0:49] it work');
  // A single shared word is too often coincidence to drop.
  assert.equal(trimSeamOverlap('[0:00] up to the', '[0:49] the next idea'), '[0:49] the next idea');
  assert.equal(trimSeamOverlap('[0:00] nothing shared here', '[0:49] fresh words'), '[0:49] fresh words');
  // A chunk that is entirely overlap leaves nothing behind.
  assert.equal(trimSeamOverlap('[0:00] and that is all', '[0:49] that is all'), '');
});

test('adjacent chunks are joined without repeating the overlapped words', async () => {
  const dir = await tempDir();
  const { run } = fakeRun(120);
  const answers = ['the second law says force equals', 'force equals mass times acceleration and', 'acceleration and that is all'];
  const { fetchFn } = fakeFetch((n) => JSON.stringify({ text: answers[n] }));
  const transcriber = new AudioTranscriber(settings(), { run, fetchFn, tmpRoot: dir });

  const result = await transcriber.transcribe(bytes, 'audio/m4a');
  assert.deepEqual(result.text.split('\n'), ['[0:00] the second law says force equals', '[0:49] mass times acceleration and', '[1:38] that is all']);
});

test('a chunk after a failed one is not trimmed against text it never touched', async () => {
  const dir = await tempDir();
  const { run } = fakeRun(120);
  const answers = ['alpha beta gamma delta', null, 'gamma delta epsilon'];
  const { fetchFn } = fakeFetch((n) => (answers[n] === null ? null : JSON.stringify({ text: answers[n] })));
  const transcriber = new AudioTranscriber(settings(), { run, fetchFn, tmpRoot: dir });

  const result = await transcriber.transcribe(bytes, 'audio/m4a');
  assert.deepEqual(result.text.split('\n'), ['[0:00] alpha beta gamma delta', '[1:38] gamma delta epsilon']);
});

test('verbose_json segments keep their own timestamps, offset by the chunk window', async () => {
  const dir = await tempDir();
  const { run } = fakeRun(60);
  const { fetchFn } = fakeFetch(() => JSON.stringify({ text: 'all', segments: [{ start: 1, end: 4, text: 'first words' }, { start: 6, end: 9, text: 'second words' }] }));
  const transcriber = new AudioTranscriber(settings(), { run, fetchFn, tmpRoot: dir });

  const result = await transcriber.transcribe(bytes, 'audio/wav');
  const lines = result.text.split('\n');
  // Chunks at 0s and 49s; segment offsets land inside the right windows.
  assert.match(lines[0]!, /^\[0:01\] first words$/);
  assert.match(lines[1]!, /^\[0:06\] second words$/);
  assert.match(lines[2]!, /^\[0:50\] first words$/);
});

test('a failed chunk leaves a partial transcript that says so', async () => {
  const dir = await tempDir();
  const { run } = fakeRun(120);
  const { fetchFn } = fakeFetch((n) => (n === 1 ? null : JSON.stringify({ text: `chunk ${n}` })));
  const transcriber = new AudioTranscriber(settings(), { run, fetchFn, tmpRoot: dir });

  const result = await transcriber.transcribe(bytes, 'audio/wav');
  assert.equal(result.failedChunks, 1);
  assert.equal(result.partial, true);
  assert.match(result.note ?? '', /1 of 3 audio chunks could not be transcribed/);
  assert.equal(result.text.split('\n').length, 2, 'the surviving chunks still contribute their lines');
});

test('an endpoint that never answers stops early rather than grinding through every chunk', async () => {
  const dir = await tempDir();
  const { run } = fakeRun(200); // five windows — enough to see the early stop
  const { fetchFn, calls } = fakeFetch(() => null);
  const transcriber = new AudioTranscriber(settings(), { run, fetchFn, tmpRoot: dir });

  const result = await transcriber.transcribe(bytes, 'audio/m4a');
  assert.equal(result.attemptedChunks, 3, 'three unanswered chunks is enough to call the endpoint down');
  assert.equal(result.failedChunks, 3);
  assert.equal(calls.length, 3);
  assert.equal(result.partial, true);
  assert.equal(result.text, '');
  assert.match(result.note ?? '', /stopped early/);
});

test('a stream that hid its length from the probe is still refused on the decoded duration', async () => {
  const dir = await tempDir();
  // MediaRecorder-style output: an audio stream but no Duration line, so probe answers NaN.
  const noDuration = `Input #0, matroska,webm, from 'pipe:0':\n  Stream #0:0: Audio: opus, 48000 Hz, mono\nAt least one output file must be specified\n`;
  const { run } = fakeRun(120, { probeStderr: noDuration });
  const { fetchFn, calls } = fakeFetch(() => JSON.stringify({ text: 'never reached' }));
  const transcriber = new AudioTranscriber(settings(), { run, fetchFn, tmpRoot: dir });

  const error = await transcriber.transcribe(bytes, 'audio/webm', { maxSeconds: 100 }).catch((e: unknown) => e);
  assert.ok(error instanceof AudioTranscribeError);
  assert.equal(error.code, 'audio_too_long');
  assert.equal(calls.length, 0, 'no chunk ever reached the endpoint');
});

test('a missing ffmpeg is a named failure, and Anthropic is honest about having no endpoint', async () => {
  const dir = await tempDir();
  const missing = new AudioTranscriber(settings(), {
    run: async () => {
      throw new AudioTranscribeError('ffmpeg is not installed on this device — audio sources need it (brew install ffmpeg).', 'ffmpeg_missing');
    },
    tmpRoot: dir,
  });
  const error = await missing.probe(bytes, 'audio/wav').catch((e: unknown) => e);
  assert.ok(error instanceof AudioTranscribeError);
  assert.equal(error.code, 'ffmpeg_missing');

  const { run } = fakeRun(10);
  const anthropic = new AudioTranscriber(settings('anthropic'), { run, tmpRoot: dir });
  const unavailable = await anthropic.transcribe(bytes, 'audio/wav').catch((e: unknown) => e);
  assert.ok(unavailable instanceof AudioTranscribeError);
  assert.equal(unavailable.code, 'transcription_unavailable');
});
