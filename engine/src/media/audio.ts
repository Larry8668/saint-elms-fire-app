import { mkdir, mkdtemp, open, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type { ProviderConfig } from '@sef/shared';
import { errorFields, log } from '../config';
import { checkAudioDuration, formatDuration } from '../brain/sources/limits';
import { ModelConfigError, resolveModel } from '../models/registry';
import type { StoredSettings } from '../settings/store';
import { ProcessError, spawnProcess, type RunCommand } from './process';

/**
 * Audio ingestion: a recording is frozen like any other source, then transcribed locally —
 * ffmpeg normalizes and segments it, and each chunk goes to the vision-role provider's
 * OpenAI-compatible `/v1/audio/transcriptions` endpoint (the native Ollama `/api/chat`
 * audio field is silently dropped, so the OpenAI surface is the honest one). Everything
 * runs on-device; a missing binary or an unreachable model is a named failure, never an
 * invented transcript.
 */

export type AudioErrorCode = 'ffmpeg_missing' | 'audio_unreadable' | 'audio_too_long' | 'transcode_failed' | 'transcription_unavailable';

/** Named failures the ingest path can report honestly — anything else is a bug and stays visible. */
export class AudioTranscribeError extends Error {
  constructor(
    message: string,
    readonly code: AudioErrorCode,
  ) {
    super(message);
  }
}

export type { RunCommand, RunResult } from './process';

export interface AudioProbe {
  /** Stream length in seconds; NaN when ffmpeg reports the stream but no duration. */
  seconds: number;
}

export interface AudioTranscription {
  text: string;
  seconds: number;
  chunks: number;
  attemptedChunks: number;
  failedChunks: number;
  /** True when fewer chunks produced text than the recording has. */
  partial: boolean;
  note?: string;
}

const SAMPLE_RATE = 16_000;
const BYTES_PER_SECOND = SAMPLE_RATE * 2; // mono s16le
/** Ollama's audio path is known-limited at about a minute; ~50 s windows sit under it. */
const CHUNK_SECONDS = 50;
const CHUNK_OVERLAP_SECONDS = 1;
const CHUNK_STEP_SECONDS = CHUNK_SECONDS - CHUNK_OVERLAP_SECONDS;
/** Give up early only when nothing has ever answered — a dead endpoint, not a hard chunk. */
const MAX_UNANSWERED_CHUNKS = 3;
const FFMPEG_TIMEOUT_MS = 120_000;
const TRANSCRIBE_TIMEOUT_MS = 180_000;

const trimSlash = (url: string) => url.replace(/\/+$/, '');

/** Where a provider kind keeps its OpenAI-compatible transcriptions route, if it has one. */
function transcriptionEndpoint(provider: ProviderConfig): string | null {
  if (provider.kind === 'anthropic') return null;
  if (provider.kind === 'ollama') return `${trimSlash(provider.baseUrl ?? 'http://localhost:11434')}/v1/audio/transcriptions`;
  const base = provider.baseUrl ?? (provider.kind === 'openai' ? 'https://api.openai.com/v1' : '');
  return base ? `${trimSlash(base)}/audio/transcriptions` : null;
}

/** `Duration: HH:MM:SS.xx` from `ffmpeg -i` output; the exit code is always nonzero there. */
export function parseFfmpegDuration(stderr: string): number | null {
  const match = /Duration:\s*(\d+):(\d+):(\d+(?:\.\d+)?)/.exec(stderr);
  if (!match) return null;
  return Number(match[1]) * 3600 + Number(match[2]) * 60 + Number(match[3]);
}

/** Whether the stream ffmpeg looked at actually contained an audio track. */
const hasAudioStream = (stderr: string): boolean => /Stream .*Audio:/m.test(stderr);

/** [start, length] windows covering the recording — the overlap keeps words split at a seam legible. */
export function chunkPlan(seconds: number): Array<{ start: number; length: number }> {
  const plan: Array<{ start: number; length: number }> = [];
  for (let start = 0; start < seconds; start += CHUNK_STEP_SECONDS) {
    plan.push({ start, length: Math.min(CHUNK_SECONDS, seconds - start) });
  }
  return plan;
}

/** A minimal PCM16 mono WAV — the container the transcriptions endpoint expects. */
export function wavWrap(pcm: Uint8Array): Uint8Array {
  const wav = Buffer.alloc(44 + pcm.byteLength);
  wav.write('RIFF', 0, 'ascii');
  wav.writeUInt32LE(36 + pcm.byteLength, 4);
  wav.write('WAVE', 8, 'ascii');
  wav.write('fmt ', 12, 'ascii');
  wav.writeUInt32LE(16, 16); // fmt chunk size
  wav.writeUInt16LE(1, 20); // PCM
  wav.writeUInt16LE(1, 22); // mono
  wav.writeUInt32LE(SAMPLE_RATE, 24);
  wav.writeUInt32LE(BYTES_PER_SECOND, 28);
  wav.writeUInt16LE(2, 32); // block align
  wav.writeUInt16LE(16, 34); // bit depth
  wav.write('data', 36, 'ascii');
  wav.writeUInt32LE(pcm.byteLength, 40);
  wav.set(pcm, 44);
  return new Uint8Array(wav);
}

/** Shortest repeated run treated as seam overlap; a single shared word is too often a coincidence. */
const MIN_OVERLAP_WORDS = 2;
const MAX_OVERLAP_WORDS = 12;
const LINE_STAMP = /^(\[[^\]]+\]\s*)/;
const wordKey = (word: string) => word.toLowerCase().replace(/[^\p{L}\p{N}']/gu, '');

/**
 * Chunks overlap by a second, so the next chunk usually opens with the words the previous
 * one closed on. Drops the longest such repeated run from the head of `next`.
 */
export function trimSeamOverlap(previous: string, next: string): string {
  const stamp = LINE_STAMP.exec(next)?.[1] ?? '';
  const nextWords = next.slice(stamp.length).split(/\s+/).filter(Boolean);
  const tail = previous.replace(LINE_STAMP, '').split(/\s+/).filter(Boolean).slice(-MAX_OVERLAP_WORDS).map(wordKey);
  const head = nextWords.map(wordKey);
  for (let k = Math.min(tail.length, head.length, MAX_OVERLAP_WORDS); k >= MIN_OVERLAP_WORDS; k--) {
    const matches = tail.slice(-k).every((word, i) => word !== '' && word === head[i]);
    if (matches) {
      const rest = nextWords.slice(k).join(' ');
      return rest ? `${stamp}${rest}` : '';
    }
  }
  return next;
}

/** Process failures, translated into this module's own vocabulary. */
const ffmpegRun: RunCommand = async (command, args, opts) => {
  try {
    return await spawnProcess(command, args, opts);
  } catch (error) {
    if (error instanceof ProcessError && error.reason === 'missing') {
      throw new AudioTranscribeError('ffmpeg is not installed on this device — audio sources need it (brew install ffmpeg).', 'ffmpeg_missing');
    }
    if (error instanceof ProcessError) throw new AudioTranscribeError(error.message, 'transcode_failed');
    throw error;
  }
};

export interface AudioTranscriberDeps {
  env?: NodeJS.ProcessEnv;
  run?: RunCommand;
  fetchFn?: typeof fetch;
  /** Where normalized audio is staged; defaults to a fresh os.tmpdir() folder per call. */
  tmpRoot?: string;
}

interface TranscriptionSegment {
  start?: number;
  end?: number;
  text?: string;
}

/** Pulls transcript lines out of a verbose_json body, tolerating a plain-text answer. */
function transcriptLines(body: string, chunkStart: number): string[] {
  let parsed: { text?: string; segments?: TranscriptionSegment[] } | null = null;
  try {
    parsed = JSON.parse(body) as { text?: string; segments?: TranscriptionSegment[] };
  } catch {
    parsed = null;
  }
  if (parsed?.segments?.length) {
    return parsed.segments
      .filter((s) => s.text?.trim())
      .map((s) => `[${formatDuration(chunkStart + (s.start ?? 0))}] ${s.text!.trim()}`);
  }
  const text = (parsed?.text ?? body).trim();
  return text ? [`[${formatDuration(chunkStart)}] ${text}`] : [];
}

export class AudioTranscriber {
  private readonly env: NodeJS.ProcessEnv;
  private readonly run: RunCommand;
  private readonly fetchFn: typeof fetch;
  private readonly tmpRoot?: string;

  constructor(
    private readonly settings: { get(): Promise<StoredSettings> },
    deps: AudioTranscriberDeps = {},
  ) {
    this.env = deps.env ?? process.env;
    this.run = deps.run ?? ffmpegRun;
    this.fetchFn = deps.fetchFn ?? fetch;
    this.tmpRoot = deps.tmpRoot;
  }

  private get ffmpeg(): string {
    return this.env.FFMPEG_PATH?.trim() || 'ffmpeg';
  }

  /**
   * Stream length, probed before the source is stored so an over-long file is refused
   * rather than half-read. A stream ffmpeg cannot parse as audio is rejected by name.
   */
  async probe(bytes: Uint8Array, _mediaType: string): Promise<AudioProbe> {
    return this.withStagedInput(bytes, (inputPath) => this.probeFile(inputPath));
  }

  private async probeFile(inputPath: string): Promise<AudioProbe> {
    const { stderr } = await this.run(this.ffmpeg, ['-hide_banner', '-i', inputPath], { timeoutMs: FFMPEG_TIMEOUT_MS });
    if (!hasAudioStream(stderr)) {
      throw new AudioTranscribeError('That file does not contain a readable audio stream.', 'audio_unreadable');
    }
    return { seconds: parseFfmpegDuration(stderr) ?? Number.NaN };
  }

  /**
   * ffmpeg reads from a file, not stdin: MP4/M4A written with the index (`moov`) at the end —
   * ffmpeg's own default and common for phone recordings — cannot be demuxed from a pipe and
   * silently decodes to nothing. Each call gets its own folder, removed afterwards.
   */
  private async withStagedInput<T>(bytes: Uint8Array, fn: (inputPath: string, work: string) => Promise<T>): Promise<T> {
    const root = this.tmpRoot ?? tmpdir();
    if (this.tmpRoot) await mkdir(root, { recursive: true });
    const work = await mkdtemp(path.join(root, 'sef-audio-'));
    try {
      const inputPath = path.join(work, 'input');
      await writeFile(inputPath, bytes);
      return await fn(inputPath, work);
    } finally {
      await rm(work, { recursive: true, force: true }).catch((error: unknown) => log.warn('audio_tmp_cleanup_failed', errorFields(error)));
    }
  }

  /**
   * The full read: one normalize pass to mono 16 kHz PCM, then each ~50 s window posts to
   * the vision-role provider's transcriptions endpoint as a fresh WAV. Chunks fail
   * independently — a dead model answers fast and stops early, a flaky one just leaves gaps
   * the note counts.
   */
  async transcribe(bytes: Uint8Array, mediaType: string, opts: { seconds?: number; maxSeconds?: number } = {}): Promise<AudioTranscription> {
    return this.withStagedInput(bytes, (inputPath, work) => this.transcribeFile(inputPath, work, mediaType, opts));
  }

  private async transcribeFile(inputPath: string, work: string, mediaType: string, opts: { seconds?: number; maxSeconds?: number }): Promise<AudioTranscription> {
    const probed = opts.seconds ?? (await this.probeFile(inputPath)).seconds;
    const resolved = await this.resolveEndpoint();

    const pcmPath = path.join(work, 'normalized.pcm');
    const normalized = await this.run(
      this.ffmpeg,
      ['-y', '-hide_banner', '-loglevel', 'error', '-i', inputPath, '-ac', '1', '-ar', String(SAMPLE_RATE), '-f', 's16le', pcmPath],
      { timeoutMs: FFMPEG_TIMEOUT_MS },
    );
    if (normalized.code !== 0) {
      throw new AudioTranscribeError(`ffmpeg could not decode that recording${normalized.stderr.trim() ? ` — ${normalized.stderr.trim().slice(0, 200)}` : ''}`, 'transcode_failed');
    }

    const pcm = await open(pcmPath, 'r');
    try {
      const { size } = await pcm.stat();
      // The PCM length is the honest duration: what we decoded, not what the header
      // claimed. A stream that hid its length from the probe (MediaRecorder output often
      // does) is still bound by the cap — refuse by name instead of spending hours of
      // transcription calls on it.
      const seconds = size / BYTES_PER_SECOND;
      const over = checkAudioDuration(seconds, { maxAudioSeconds: opts.maxSeconds });
      if (over) throw new AudioTranscribeError(over.message, over.code === 'audio_too_long' ? 'audio_too_long' : 'audio_unreadable');
      const plan = chunkPlan(Number.isFinite(probed) ? probed : seconds);
      const lines: string[] = [];
      let attempted = 0;
      let failed = 0;
      let produced = 0;
      let previousChunkOk = false;
      for (const [index, chunk] of plan.entries()) {
        attempted = index + 1;
        const slice = Buffer.alloc(Math.round(chunk.length * BYTES_PER_SECOND));
        await pcm.read(slice, 0, slice.byteLength, Math.round(chunk.start * BYTES_PER_SECOND));
        try {
          const chunkLines = await this.transcribeChunk(wavWrap(slice), resolved, chunk.start);
          // Only adjacent chunks share a seam; after a failed chunk there is nothing to trim against.
          if (previousChunkOk && lines.length && chunkLines.length) chunkLines[0] = trimSeamOverlap(lines[lines.length - 1]!, chunkLines[0]!);
          lines.push(...chunkLines.filter(Boolean));
          produced++;
          previousChunkOk = true;
        } catch (error) {
          failed++;
          previousChunkOk = false;
          log.warn('audio_chunk_failed', { chunk: index, at: chunk.start, ...errorFields(error) });
          // No chunk has ever answered: the endpoint is down, not the audio. Stop instead
          // of spending the remaining windows on it — the note below says where we stopped.
          if (produced === 0 && failed >= MAX_UNANSWERED_CHUNKS) break;
        }
      }
      const notes: string[] = [];
      if (failed > 0) notes.push(`${failed} of ${plan.length} audio chunks could not be transcribed`);
      if (attempted < plan.length) notes.push(`transcription stopped early — ${attempted} of ${plan.length} chunks were tried`);
      log.info('audio_transcribed', { mediaType, seconds: Math.round(seconds), chunks: plan.length, attempted, failed });
      return {
        text: lines.join('\n'),
        seconds,
        chunks: plan.length,
        attemptedChunks: attempted,
        failedChunks: failed,
        partial: failed > 0 || attempted < plan.length,
        ...(notes.length ? { note: `${notes.join('; ')}.` } : {}),
      };
    } finally {
      await pcm.close();
    }
  }

  /** The vision role's provider, mapped to its transcriptions route — resolution failures are named. */
  private async resolveEndpoint(): Promise<{ url: string; model: string; apiKey?: string }> {
    try {
      const resolved = resolveModel(await this.settings.get(), 'vision');
      const url = transcriptionEndpoint(resolved.provider);
      if (!url) {
        throw new AudioTranscribeError(`The ${resolved.provider.label} provider has no transcription endpoint — pick an Ollama or OpenAI-compatible provider for the vision role.`, 'transcription_unavailable');
      }
      return { url, model: resolved.modelId, ...(resolved.provider.apiKey ? { apiKey: resolved.provider.apiKey } : {}) };
    } catch (error) {
      if (error instanceof AudioTranscribeError) throw error;
      if (error instanceof ModelConfigError) throw new AudioTranscribeError(error.message, 'transcription_unavailable');
      throw error;
    }
  }

  private async transcribeChunk(wav: Uint8Array, resolved: { url: string; model: string; apiKey?: string }, start: number): Promise<string[]> {
    const form = new FormData();
    form.append('file', new Blob([wav], { type: 'audio/wav' }), 'chunk.wav');
    form.append('model', resolved.model);
    form.append('response_format', 'verbose_json');
    const res = await this.fetchFn(resolved.url, {
      method: 'POST',
      headers: resolved.apiKey ? { authorization: `Bearer ${resolved.apiKey}` } : undefined,
      body: form,
      signal: AbortSignal.timeout(TRANSCRIBE_TIMEOUT_MS),
    });
    if (!res.ok) throw new Error(`transcriptions answered ${res.status}`);
    return transcriptLines(await res.text(), start);
  }
}
