import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { errorFields, log } from '../config';
import { checkAudioDuration, formatDuration } from '../brain/sources/limits';
import { parseFfmpegDuration, type AudioTranscription } from './audio';
import { ProcessError, spawnProcess, type RunCommand } from './process';
import type { ImageAsk, ImageReader } from './vision';

/**
 * Lecture video reading: an uploaded recording is frozen as-is, then read in two passes over
 * the one staged copy. The audio track goes through the ordinary transcription lane (ffmpeg
 * pulls it out in the same normalize pass a voice memo gets), and a handful of key frames —
 * at most twelve, evenly spread — go to the vision reader, which transcribes the slide or
 * board text it can see. Both are merged by timestamp into one reading:
 *
 *   [0:03] (on screen) Newton's second law: F = ma
 *   [0:04] So the net force on the trolley…
 *
 * Frames that show nothing legible are dropped, and a slide that stays up across several
 * samples is kept once. A missing binary or an unreachable model is a named failure — a gap
 * the note counts, never an invented transcript.
 */

export type VideoErrorCode = 'ffmpeg_missing' | 'video_unreadable' | 'video_too_long';

/** Named failures the ingest path reports honestly — anything else is a bug and stays visible. */
export class VideoReadError extends Error {
  constructor(
    message: string,
    readonly code: VideoErrorCode,
  ) {
    super(message);
  }
}

export interface VideoProbe {
  /** Container length in seconds; NaN when ffmpeg reports the streams but no duration. */
  seconds: number;
  hasAudio: boolean;
}

export interface VideoReading {
  text: string;
  seconds: number;
  /** Audio chunks the transcript was planned in (0 with no audio track). */
  chunks: number;
  failedChunks: number;
  /** Frames sampled, frames the model answered for, frames that failed, frames kept in the text. */
  frames: number;
  framesRead: number;
  failedFrames: number;
  framesKept: number;
  partial: boolean;
  note?: string;
}

/** The slice of the audio lane a video needs: transcribe a file that is already staged. */
export interface TrackTranscriber {
  transcribePath(inputPath: string, mediaType: string, opts?: { seconds?: number; maxSeconds?: number }): Promise<AudioTranscription>;
}

export const MAX_FRAMES = 12;
/** Never sample more often than this — a short clip does not need a frame a second. */
const MIN_FRAME_INTERVAL_SECONDS = 2;
const FRAME_LONG_EDGE = 1024;
const FRAME_JPEG_QUALITY = '4';
/** Give up on frames early only when none has ever answered — a dead model, not a hard frame. */
const MAX_UNANSWERED_FRAMES = 3;
const FFMPEG_TIMEOUT_MS = 120_000;

export const FRAME_ASK: ImageAsk = {
  instructions:
    'You read single frames sampled from a recorded lecture and transcribe what is legible on screen: slide text, board or whiteboard writing, formulas (in LaTeX) and diagram labels. Never describe people, the room or the camera, and never add anything that is not visible. Answer with the transcription only — no preamble.',
  prompt: "Transcribe any text, formulas and diagrams visible in this lecture frame; say 'nothing legible' if none.",
};

/**
 * Sample times: one frame every N seconds, N chosen so there are at most MAX_FRAMES, each
 * taken mid-interval so a slide change at the boundary is not what gets sampled.
 */
export function framePlan(seconds: number): number[] {
  if (!Number.isFinite(seconds) || seconds <= 0) return [];
  const interval = Math.max(MIN_FRAME_INTERVAL_SECONDS, Math.ceil(seconds / MAX_FRAMES));
  const times: number[] = [];
  for (let t = Math.min(interval / 2, seconds / 2); t < seconds && times.length < MAX_FRAMES; t += interval) {
    times.push(Math.round(t * 10) / 10);
  }
  return times;
}

/** Compared after lower-casing and dropping punctuation, so a re-read of the same slide matches. */
export const normaliseFrameText = (text: string): string =>
  text
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .trim();

/** The model's way of saying a frame holds no text — "nothing legible", give or take. */
export function saysNothingLegible(text: string): boolean {
  const plain = normaliseFrameText(text);
  if (!plain) return true;
  if (/^(nothing legible|no legible text|no text|none|no text visible|nothing is legible)$/.test(plain)) return true;
  return plain.length <= 60 && plain.includes('nothing legible');
}

/** One frame as one transcript-shaped line; a multi-line slide joins with " / ". */
export function frameLine(at: number, text: string): string {
  const joined = text
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean)
    .join(' / ');
  return `[${formatDuration(at)}] (on screen) ${joined}`;
}

const STAMP = /^\[(\d+(?::\d{1,2}){1,2})\]/;

const stampSeconds = (stamp: string): number => stamp.split(':').reduce((total, part) => total * 60 + Number(part), 0);

/**
 * Interleaves transcript lines and frame lines by their leading `[m:ss]` stamp. A line
 * without a stamp stays glued to the line before it; at the same second the spoken line
 * comes first. The sort is stable, so each stream keeps its own order.
 */
export function mergeByTimestamp(transcript: string, frames: Array<{ at: number; line: string }>): string {
  const entries: Array<{ at: number; order: number; text: string }> = [];
  for (const line of transcript.split('\n')) {
    if (!line.trim()) continue;
    const stamp = STAMP.exec(line);
    if (stamp) entries.push({ at: stampSeconds(stamp[1]!), order: 0, text: line });
    else if (entries.length) entries[entries.length - 1]!.text += `\n${line}`;
    else entries.push({ at: 0, order: 0, text: line });
  }
  for (const frame of frames) entries.push({ at: frame.at, order: 1, text: frame.line });
  return entries
    .map((entry, index) => ({ ...entry, index }))
    .sort((a, b) => a.at - b.at || a.order - b.order || a.index - b.index)
    .map((entry) => entry.text)
    .join('\n');
}

const ffmpegRun: RunCommand = async (command, args, opts) => {
  try {
    return await spawnProcess(command, args, opts);
  } catch (error) {
    if (error instanceof ProcessError && error.reason === 'missing') {
      throw new VideoReadError('ffmpeg is not installed on this device — video sources need it (brew install ffmpeg).', 'ffmpeg_missing');
    }
    if (error instanceof ProcessError) throw new VideoReadError(error.message, 'video_unreadable');
    throw error;
  }
};

const hasVideoStream = (stderr: string): boolean => /Stream .*Video:(?!.*attached pic)/m.test(stderr);
const hasAudioStream = (stderr: string): boolean => /Stream .*Audio:/m.test(stderr);

export interface VideoReaderDeps {
  env?: NodeJS.ProcessEnv;
  run?: RunCommand;
  /** Where the video and its frames are staged; defaults to a fresh os.tmpdir() folder per call. */
  tmpRoot?: string;
}

export class LectureVideoReader {
  private readonly env: NodeJS.ProcessEnv;
  private readonly run: RunCommand;
  private readonly tmpRoot?: string;

  constructor(
    private readonly track: TrackTranscriber,
    private readonly vision: ImageReader,
    deps: VideoReaderDeps = {},
  ) {
    this.env = deps.env ?? process.env;
    this.run = deps.run ?? ffmpegRun;
    this.tmpRoot = deps.tmpRoot;
  }

  private get ffmpeg(): string {
    return this.env.FFMPEG_PATH?.trim() || 'ffmpeg';
  }

  /** Length and tracks, probed before the source is stored — a file with no picture is not a video. */
  async probe(bytes: Uint8Array, _mediaType: string): Promise<VideoProbe> {
    return this.withStagedInput(bytes, (inputPath) => this.probeFile(inputPath));
  }

  private async probeFile(inputPath: string): Promise<VideoProbe> {
    const { stderr } = await this.run(this.ffmpeg, ['-hide_banner', '-i', inputPath], { timeoutMs: FFMPEG_TIMEOUT_MS });
    if (!hasVideoStream(stderr)) {
      throw new VideoReadError('That file does not contain a readable video stream.', 'video_unreadable');
    }
    return { seconds: parseFfmpegDuration(stderr) ?? Number.NaN, hasAudio: hasAudioStream(stderr) };
  }

  /** ffmpeg seeks a file, not a pipe — the container is staged once and both passes read it. */
  private async withStagedInput<T>(bytes: Uint8Array, fn: (inputPath: string, work: string) => Promise<T>): Promise<T> {
    const root = this.tmpRoot ?? tmpdir();
    if (this.tmpRoot) await mkdir(root, { recursive: true });
    const work = await mkdtemp(path.join(root, 'sef-video-'));
    try {
      const inputPath = path.join(work, 'input');
      await writeFile(inputPath, bytes);
      return await fn(inputPath, work);
    } finally {
      await rm(work, { recursive: true, force: true }).catch((error: unknown) => log.warn('video_tmp_cleanup_failed', errorFields(error)));
    }
  }

  async read(bytes: Uint8Array, mediaType: string, opts: { seconds?: number; maxSeconds?: number } = {}): Promise<VideoReading> {
    return this.withStagedInput(bytes, (inputPath, work) => this.readFile(inputPath, work, mediaType, opts));
  }

  private async readFile(inputPath: string, work: string, mediaType: string, opts: { seconds?: number; maxSeconds?: number }): Promise<VideoReading> {
    const started = Date.now();
    const probe = await this.probeFile(inputPath);
    let seconds = Number.isFinite(probe.seconds) ? probe.seconds : (opts.seconds ?? Number.NaN);
    if (Number.isFinite(seconds)) {
      const over = checkAudioDuration(seconds, { maxAudioSeconds: opts.maxSeconds });
      if (over) throw new VideoReadError(over.message.replace('recording', 'video'), over.code === 'audio_too_long' ? 'video_too_long' : 'video_unreadable');
    }

    const notes: string[] = [];
    let partial = false;

    // Pass one: the audio track, through the same lane a voice memo takes.
    let transcript: AudioTranscription | null = null;
    if (probe.hasAudio) {
      try {
        transcript = await this.track.transcribePath(inputPath, mediaType, { ...(Number.isFinite(seconds) ? { seconds } : {}), ...(opts.maxSeconds !== undefined ? { maxSeconds: opts.maxSeconds } : {}) });
        if (!Number.isFinite(seconds)) seconds = transcript.seconds;
        if (transcript.note) notes.push(transcript.note.replace(/\.+$/, ''));
        partial ||= transcript.partial;
      } catch (error) {
        partial = true;
        notes.push(`the audio track could not be transcribed — ${error instanceof Error ? error.message.replace(/\.+$/, '') : 'unknown error'}`);
        log.warn('video_audio_failed', { mediaType, ...errorFields(error) });
      }
    } else {
      notes.push('this video has no audio track, so only what is on screen was read');
    }

    // Pass two: key frames, each read by the vision model. A container that hid its length
    // and had no audio to measure gets one frame from its opening, and says so.
    let plan = framePlan(seconds);
    if (!plan.length) {
      plan = [0];
      notes.push('the video does not report its length, so only its opening frame was read');
      partial = true;
    }
    const frames: Array<{ at: number; line: string }> = [];
    let attempted = 0;
    let answered = 0;
    let failed = 0;
    let previous = '';
    for (const [index, at] of plan.entries()) {
      attempted = index + 1;
      const framePath = path.join(work, `frame-${String(index).padStart(2, '0')}.jpg`);
      let jpeg: Uint8Array;
      try {
        const cut = await this.run(
          this.ffmpeg,
          [
            '-y', '-hide_banner', '-loglevel', 'error',
            '-ss', String(at), '-i', inputPath,
            '-frames:v', '1',
            '-vf', `scale=${FRAME_LONG_EDGE}:${FRAME_LONG_EDGE}:force_original_aspect_ratio=decrease`,
            '-q:v', FRAME_JPEG_QUALITY,
            framePath,
          ],
          { timeoutMs: FFMPEG_TIMEOUT_MS },
        );
        if (cut.code !== 0) throw new Error(cut.stderr.trim().slice(0, 200) || `ffmpeg exited ${cut.code}`);
        jpeg = new Uint8Array(await readFile(framePath));
        if (!jpeg.byteLength) throw new Error('ffmpeg wrote an empty frame');
      } catch (error) {
        if (error instanceof VideoReadError && error.code === 'ffmpeg_missing') throw error;
        failed++;
        log.warn('video_frame_cut_failed', { frame: index, at, ...errorFields(error) });
        continue;
      }
      try {
        const { text } = await this.vision.read(jpeg, 'image/jpeg', FRAME_ASK);
        answered++;
        if (saysNothingLegible(text)) continue;
        const key = normaliseFrameText(text);
        // The same slide sampled twice in a row is one slide.
        if (key === previous) continue;
        previous = key;
        frames.push({ at, line: frameLine(at, text) });
      } catch (error) {
        failed++;
        log.warn('video_frame_read_failed', { frame: index, at, ...errorFields(error) });
        if (answered === 0 && failed >= MAX_UNANSWERED_FRAMES) break;
      }
    }
    if (failed > 0) notes.push(`${failed} of ${plan.length} frames could not be read`);
    if (attempted < plan.length) notes.push(`frame reading stopped early — ${attempted} of ${plan.length} frames were tried`);
    if (answered > 0 && frames.length === 0) notes.push('no text was legible on screen in any sampled frame');
    partial ||= failed > 0 || attempted < plan.length;

    const text = mergeByTimestamp(transcript?.text ?? '', frames);
    log.info('video_read', {
      mediaType,
      seconds: Number.isFinite(seconds) ? Math.round(seconds) : null,
      chunks: transcript?.chunks ?? 0,
      frames: plan.length,
      framesRead: answered,
      framesKept: frames.length,
      failedFrames: failed,
      ms: Date.now() - started,
    });
    const note = notes.length ? `${notes.join('; ').replace(/^./, (c) => c.toUpperCase())}.` : undefined;
    return {
      text,
      seconds,
      chunks: transcript?.chunks ?? 0,
      failedChunks: transcript?.failedChunks ?? 0,
      frames: plan.length,
      framesRead: answered,
      failedFrames: failed,
      framesKept: frames.length,
      partial,
      ...(note ? { note } : {}),
    };
  }
}
