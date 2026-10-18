import assert from 'node:assert/strict';
import { readdir, mkdtemp, rm } from 'node:fs/promises';
import { writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { after, test } from 'node:test';
import type { AudioTranscription, RunCommand } from './audio';
import { FRAME_ASK, LectureVideoReader, VideoReadError, frameLine, framePlan, mergeByTimestamp, normaliseFrameText, saysNothingLegible, type TrackTranscriber } from './video';
import type { ImageAsk, ImageReader } from './vision';

const madeDirs: string[] = [];
const tempDir = async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'sef-video-test-'));
  madeDirs.push(dir);
  return dir;
};
after(() => Promise.all(madeDirs.map((dir) => rm(dir, { recursive: true, force: true }))));

const probeStderr = (duration: string, { audio = true, video = true } = {}) =>
  [
    `Input #0, mov,mp4,m4a,3gp,3g2,mj2, from 'input':`,
    `  Duration: ${duration}, start: 0.000000, bitrate: 400 kb/s`,
    video ? '  Stream #0:0[0x1](und): Video: h264 (High) (avc1 / 0x31637661), yuv420p, 1280x720, 25 fps' : '',
    audio ? '  Stream #0:1[0x2](und): Audio: aac (LC) (mp4a / 0x6134706D), 44100 Hz, mono, fltp, 69 kb/s' : '',
    'At least one output file must be specified',
  ]
    .filter(Boolean)
    .join('\n');

const stamp = (seconds: number) => new Date(seconds * 1000).toISOString().slice(11, 22);

/**
 * A fake ffmpeg: `-i` alone answers the probe, a `-frames:v` cut writes a stand-in JPEG whose
 * bytes name the sample time — so the fake vision reader can answer per frame.
 */
const fakeRun = (seconds: number, opts: { audio?: boolean; video?: boolean; failCutAt?: number } = {}) => {
  const cuts: string[][] = [];
  const run: RunCommand = async (_command, args) => {
    if (!args.includes('-frames:v')) return { code: 1, stdout: '', stderr: probeStderr(stamp(seconds), opts) };
    cuts.push(args);
    const at = Number(args[args.indexOf('-ss') + 1]);
    if (at === opts.failCutAt) return { code: 1, stdout: '', stderr: 'Invalid data found when processing input' };
    writeFileSync(args[args.length - 1]!, Buffer.from(`frame@${at}`));
    return { code: 0, stdout: '', stderr: '' };
  };
  return { run, cuts };
};

const fakeVision = (answer: (at: number) => string | Error) => {
  const asks: Array<ImageAsk | undefined> = [];
  const types: string[] = [];
  const reader: ImageReader = {
    read: async (bytes, mediaType, ask) => {
      asks.push(ask);
      types.push(mediaType);
      const at = Number(Buffer.from(bytes).toString('utf8').replace('frame@', ''));
      const text = answer(at);
      if (text instanceof Error) throw text;
      return { text };
    },
  };
  return { reader, asks, types };
};

const transcription = (text: string, over: Partial<AudioTranscription> = {}): AudioTranscription => ({ text, seconds: 40, chunks: 1, attemptedChunks: 1, failedChunks: 0, partial: false, ...over });

const fakeTrack = (result: AudioTranscription | Error = transcription("[0:00] Today: Newton's second law.\n[0:21] Now, momentum.")) => {
  const calls: Array<{ inputPath: string; opts: unknown }> = [];
  const track: TrackTranscriber = {
    transcribePath: async (inputPath, _mediaType, opts) => {
      calls.push({ inputPath, opts });
      if (result instanceof Error) throw result;
      return result;
    },
  };
  return { track, calls };
};

/** The slide script of the live-check video: F = ma for the first 20 s, then p = mv. */
const lectureFrames = (at: number): string => {
  if (at < 4) return 'nothing legible';
  if (at < 20) return at % 8 >= 4 ? "Newton's second law\nF = ma" : "Newton's second law:  F = ma.";
  return 'Momentum p = mv';
};

const bytes = new Uint8Array([0x00, 0x00, 0x00, 0x18, 0x66, 0x74, 0x79, 0x70]);

test('the frame plan never exceeds twelve samples, spaced evenly and taken mid-interval', () => {
  assert.deepEqual(framePlan(40), [2, 6, 10, 14, 18, 22, 26, 30, 34, 38], '40 s samples every 4 s');
  const hour = framePlan(3600);
  assert.equal(hour.length, 12);
  assert.equal(hour[0], 150);
  assert.equal(hour[1]! - hour[0]!, 300);
  assert.deepEqual(framePlan(10), [1, 3, 5, 7, 9], 'short clips are not sampled more often than every 2 s');
  assert.deepEqual(framePlan(1), [0.5]);
  assert.deepEqual(framePlan(0), []);
  assert.deepEqual(framePlan(Number.NaN), []);
});

test('nothing-legible answers are recognised, and normalisation ignores case and punctuation', () => {
  assert.equal(saysNothingLegible('Nothing legible.'), true);
  assert.equal(saysNothingLegible("'nothing legible'"), true);
  assert.equal(saysNothingLegible('There is nothing legible in this frame.'), true);
  assert.equal(saysNothingLegible('   '), true);
  assert.equal(saysNothingLegible('F = ma'), false);
  assert.equal(normaliseFrameText("Newton's second law:  F = ma."), normaliseFrameText("newton's second law\nF = ma"));
  assert.equal(frameLine(62, 'Momentum\np = mv'), '[1:02] (on screen) Momentum / p = mv');
});

test('transcript and frame lines interleave by timestamp, unstamped lines staying with their line', () => {
  const merged = mergeByTimestamp('[0:00] Hello.\n[0:21] Next.\ncontinued\n[1:05] Later.', [
    { at: 2, line: '[0:02] (on screen) A' },
    { at: 21, line: '[0:21] (on screen) B' },
    { at: 70, line: '[1:10] (on screen) C' },
  ]);
  assert.deepEqual(merged.split('\n'), ['[0:00] Hello.', '[0:02] (on screen) A', '[0:21] Next.', 'continued', '[0:21] (on screen) B', '[1:05] Later.', '[1:10] (on screen) C']);
  assert.equal(mergeByTimestamp('', [{ at: 3, line: '[0:03] (on screen) only frames' }]), '[0:03] (on screen) only frames');
});

test('a lecture video reads as its transcript plus deduplicated on-screen notes, merged by time', async () => {
  const dir = await tempDir();
  const { run, cuts } = fakeRun(40);
  const { reader: vision, asks, types } = fakeVision(lectureFrames);
  const { track, calls } = fakeTrack();
  const reader = new LectureVideoReader(track, vision, { run, tmpRoot: dir });

  const result = await reader.read(bytes, 'video/mp4');
  assert.deepEqual(result.text.split('\n'), [
    "[0:00] Today: Newton's second law.",
    "[0:06] (on screen) Newton's second law / F = ma",
    '[0:21] Now, momentum.',
    '[0:22] (on screen) Momentum p = mv',
  ]);
  assert.equal(result.frames, 10);
  assert.equal(result.framesRead, 10, 'every sampled frame was answered');
  assert.equal(result.framesKept, 2, 'a blank frame is skipped and a slide that stays up is kept once');
  assert.equal(result.chunks, 1);
  assert.equal(result.partial, false);
  assert.equal(result.note, undefined);

  // The audio lane reads the same staged container, told its probed length.
  assert.equal(calls.length, 1);
  assert.deepEqual(calls[0]!.opts, { seconds: 40 });
  // Frames: one cut per sample, scaled to 1024 on the long edge, JPEG q4, each read with the frame prompt.
  assert.equal(cuts.length, 10);
  assert.deepEqual(cuts.map((args) => Number(args[args.indexOf('-ss') + 1])), [2, 6, 10, 14, 18, 22, 26, 30, 34, 38]);
  assert.ok(cuts.every((args) => args.includes('scale=1024:1024:force_original_aspect_ratio=decrease') && args[args.indexOf('-q:v') + 1] === '4'));
  assert.ok(asks.every((ask) => ask === FRAME_ASK));
  assert.ok(types.every((type) => type === 'image/jpeg'));
  assert.match(FRAME_ASK.prompt, /say 'nothing legible' if none/);
  assert.deepEqual(await readdir(dir), [], 'the staged video and its frames are removed');
});

test('a frame that cannot be cut or read leaves a counted gap, not an invented slide', async () => {
  const dir = await tempDir();
  const { run } = fakeRun(40, { failCutAt: 30 });
  const { reader: vision } = fakeVision((at) => (at === 14 ? new Error('model hiccup') : lectureFrames(at)));
  const reader = new LectureVideoReader(fakeTrack().track, vision, { run, tmpRoot: dir });
  const result = await reader.read(bytes, 'video/mp4');
  assert.equal(result.partial, true);
  assert.equal(result.failedFrames, 2);
  assert.match(result.note ?? '', /2 of 10 frames could not be read/);
  assert.match(result.text, /\(on screen\) Momentum p = mv/);
});

test('a vision model that never answers stops after three frames; the transcript still stands', async () => {
  const dir = await tempDir();
  const { run, cuts } = fakeRun(40);
  const { reader: vision } = fakeVision(() => new Error('connection refused'));
  const reader = new LectureVideoReader(fakeTrack().track, vision, { run, tmpRoot: dir });
  const result = await reader.read(bytes, 'video/mp4');
  assert.equal(cuts.length, 3);
  assert.equal(result.framesRead, 0);
  assert.equal(result.partial, true);
  assert.match(result.note ?? '', /frame reading stopped early — 3 of 10 frames were tried/);
  assert.match(result.text, /Newton's second law/, 'the spoken part is kept');
  assert.doesNotMatch(result.text, /on screen/);
});

test('a failed audio track keeps the frames and says the transcript is missing', async () => {
  const dir = await tempDir();
  const { run } = fakeRun(40);
  const { reader: vision } = fakeVision(lectureFrames);
  const reader = new LectureVideoReader(fakeTrack(new Error('The transcription model could not be reached.')).track, vision, { run, tmpRoot: dir });
  const result = await reader.read(bytes, 'video/mp4');
  assert.equal(result.partial, true);
  assert.match(result.note ?? '', /^The audio track could not be transcribed — The transcription model could not be reached\.$/);
  assert.deepEqual(result.text.split('\n'), ["[0:06] (on screen) Newton's second law / F = ma", '[0:22] (on screen) Momentum p = mv']);
});

test('a silent screen recording reads its frames only, and says why there is no transcript', async () => {
  const dir = await tempDir();
  const { run } = fakeRun(40, { audio: false });
  const { track, calls } = fakeTrack();
  const reader = new LectureVideoReader(track, fakeVision(lectureFrames).reader, { run, tmpRoot: dir });
  const result = await reader.read(bytes, 'video/webm');
  assert.equal(calls.length, 0, 'no transcription is attempted without an audio track');
  assert.equal(result.chunks, 0);
  assert.equal(result.partial, false);
  assert.match(result.note ?? '', /no audio track/);
});

test('a chunk the transcriber lost marks the video partial and its note rides along', async () => {
  const dir = await tempDir();
  const { run } = fakeRun(40);
  const track = fakeTrack(transcription('[0:00] Part of it.', { chunks: 2, failedChunks: 1, partial: true, note: '1 of 2 audio chunks could not be transcribed.' })).track;
  const reader = new LectureVideoReader(track, fakeVision(lectureFrames).reader, { run, tmpRoot: dir });
  const result = await reader.read(bytes, 'video/mp4');
  assert.equal(result.partial, true);
  assert.equal(result.failedChunks, 1);
  assert.match(result.note ?? '', /^1 of 2 audio chunks could not be transcribed\.$/);
});

test('the duration cap and the video stream are checked by name', async () => {
  const dir = await tempDir();
  const long = new LectureVideoReader(fakeTrack().track, fakeVision(lectureFrames).reader, { run: fakeRun(7200).run, tmpRoot: dir });
  const tooLong = await long.read(bytes, 'video/mp4', { maxSeconds: 3600 }).catch((e: unknown) => e);
  assert.ok(tooLong instanceof VideoReadError);
  assert.equal(tooLong.code, 'video_too_long');
  assert.match(tooLong.message, /That video is 2:00:00/);

  const audioOnly = new LectureVideoReader(fakeTrack().track, fakeVision(lectureFrames).reader, { run: fakeRun(40, { video: false }).run, tmpRoot: dir });
  const notVideo = await audioOnly.probe(bytes, 'video/mp4').catch((e: unknown) => e);
  assert.ok(notVideo instanceof VideoReadError);
  assert.equal(notVideo.code, 'video_unreadable');

  const probed = await new LectureVideoReader(fakeTrack().track, fakeVision(lectureFrames).reader, { run: fakeRun(95.5).run, tmpRoot: dir }).probe(bytes, 'video/mp4');
  assert.deepEqual(probed, { seconds: 95.5, hasAudio: true });
});

test('a missing ffmpeg is a named failure from the probe', async () => {
  const dir = await tempDir();
  const missing: RunCommand = async () => {
    throw new VideoReadError('ffmpeg is not installed on this device — video sources need it (brew install ffmpeg).', 'ffmpeg_missing');
  };
  const reader = new LectureVideoReader(fakeTrack().track, fakeVision(lectureFrames).reader, { run: missing, tmpRoot: dir });
  const error = await reader.probe(bytes, 'video/mp4').catch((e: unknown) => e);
  assert.ok(error instanceof VideoReadError);
  assert.equal(error.code, 'ffmpeg_missing');
});
