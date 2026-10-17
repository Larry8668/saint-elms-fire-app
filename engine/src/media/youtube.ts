import { createRequire } from 'node:module';
import { existsSync } from 'node:fs';
import { mkdtemp, readFile, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type { SourceLink, VideoPreview } from '@sef/shared';
import { log } from '../config';
import { formatDuration, INGEST_LIMITS } from '../brain/sources/limits';
import { ProcessError, spawnProcess, type RunCommand } from './process';

/**
 * YouTube ingestion, deliberately two-phase. `preview` only asks yt-dlp for metadata —
 * no media bytes move — so the student consents to a real card, and `fetchAudio` is the
 * explicit second call that downloads and extracts the audio track. The stored source is
 * the audio itself (kind 'video', mediaType 'audio/wav'); the link field keeps the URL
 * provenance forever. Host allowlist is explicit and small — this is the only new egress
 * in the capability series, so every refusal and failure is named, never silent.
 */

export type YouTubeErrorCode =
  | 'unsupported_url'
  | 'unsupported_host'
  | 'ytdlp_missing'
  | 'ffmpeg_missing'
  | 'video_too_long'
  | 'video_too_large'
  | 'video_unavailable'
  | 'age_gated'
  | 'geo_blocked'
  | 'no_audio_stream'
  | 'video_unreachable'
  | 'preview_failed'
  | 'fetch_failed';

export class YouTubeError extends Error {
  constructor(
    message: string,
    readonly code: YouTubeErrorCode,
  ) {
    super(message);
  }
}

/** Explicit host allowlist — no subdomain guessing, no wildcard. */
const YOUTUBE_HOSTS = new Set(['youtube.com', 'www.youtube.com', 'm.youtube.com', 'youtu.be']);
const VIDEO_ID = /^[A-Za-z0-9_-]{6,20}$/;

export interface VideoRef {
  /** The canonical watch URL — the one URL the fetch will run against. */
  url: string;
  videoId: string;
}

/**
 * Parses a pasted link into a canonical watch URL. Anything off the allowlist — or a
 * shape without a video id — is refused by name before any process is spawned.
 */
export function parseVideoUrl(raw: string): VideoRef {
  let url: URL;
  try {
    url = new URL(raw.trim());
  } catch {
    throw new YouTubeError('That does not read as a URL.', 'unsupported_url');
  }
  if (url.protocol !== 'https:') throw new YouTubeError('Video links must be https URLs.', 'unsupported_url');
  if (url.username || url.password) throw new YouTubeError('Video links cannot carry credentials.', 'unsupported_url');
  const host = url.hostname.toLowerCase();
  if (!YOUTUBE_HOSTS.has(host)) {
    throw new YouTubeError(`Only YouTube links can be fetched — '${host || 'that host'}' is not one of them.`, 'unsupported_host');
  }

  let videoId: string | undefined;
  if (host === 'youtu.be') {
    videoId = url.pathname.split('/').filter(Boolean)[0];
  } else {
    const segments = url.pathname.split('/').filter(Boolean);
    if (url.searchParams.get('v')) videoId = url.searchParams.get('v')!;
    else if (['shorts', 'embed', 'live', 'v'].includes(segments[0] ?? '')) videoId = segments[1];
  }
  if (!videoId || !VIDEO_ID.test(videoId)) {
    throw new YouTubeError('That YouTube link does not name a video — paste a watch, share or shorts link.', 'unsupported_url');
  }
  return { url: `https://www.youtube.com/watch?v=${videoId}`, videoId };
}

/** The vendored binary, when youtube-dl-exec's postinstall fetched one. */
function vendoredYtDlp(): string | null {
  try {
    const require = createRequire(import.meta.url);
    const pkg = require.resolve('youtube-dl-exec/package.json');
    const bin = path.join(path.dirname(pkg), 'bin', process.platform === 'win32' ? 'yt-dlp.exe' : 'yt-dlp');
    return existsSync(bin) ? bin : null;
  } catch {
    return null;
  }
}

interface DumpInfo {
  id?: string;
  title?: string;
  /** Seconds, float or int. */
  duration?: number;
  uploader?: string;
  channel?: string;
  thumbnail?: string;
  webpage_url?: string;
}

/** stderr fragments → honest named failures; order matters (specific before generic). */
const YTDLP_FAILURES: Array<{ match: RegExp; code: YouTubeErrorCode; message: string }> = [
  { match: /does not pass filter|duration/i, code: 'video_too_long', message: 'That video is longer than the recording limit.' },
  { match: /confirm your age|age.?gate|inappropriate for some/i, code: 'age_gated', message: 'That video is age-gated and cannot be fetched without a sign-in.' },
  { match: /not available in your country|geo.?restrict|blocked (?:it|this) in/i, code: 'geo_blocked', message: 'That video is not available in this country.' },
  { match: /private video|members.only|this video is unavailable|has been removed|no longer available|premieres in/i, code: 'video_unavailable', message: 'That video is private, removed or otherwise unavailable.' },
  { match: /ffmpeg|avconv/i, code: 'ffmpeg_missing', message: 'ffmpeg is needed to pull the audio track — install it (brew install ffmpeg) and try again.' },
  { match: /requested format is not available|no audio|no video formats/i, code: 'no_audio_stream', message: 'That video has no downloadable audio track.' },
  { match: /name or service|failed to resolve|network is unreachable|connection (?:refused|reset)|temporary failure|unable to download|urlopen error|timed out|eof occurred/i, code: 'video_unreachable', message: 'YouTube could not be reached — check the connection and try again.' },
];

function classifyYtDlpError(stderr: string, fallback: 'preview_failed' | 'fetch_failed'): YouTubeError {
  const text = stderr.trim();
  const hit = YTDLP_FAILURES.find(({ match }) => match.test(text));
  const detail = text.split('\n').map((l) => l.replace(/^ERROR:\s*/i, '').trim()).filter(Boolean)[0]?.slice(0, 200);
  return new YouTubeError(hit?.message ?? `yt-dlp could not complete the ${fallback === 'preview_failed' ? 'preview' : 'fetch'}${detail ? ` — ${detail}` : ''}.`, hit?.code ?? fallback);
}

const PREVIEW_TIMEOUT_MS = 60_000;
const FETCH_TIMEOUT_MS = 15 * 60_000;

export interface YouTubeDeps {
  env?: NodeJS.ProcessEnv;
  run?: RunCommand;
  tmpRoot?: string;
}

export interface FetchedAudio {
  bytes: Uint8Array;
  /** The extracted track's container — 'audio/wav' normally, honestly labelled if not. */
  mediaType: string;
  title: string;
  uploader?: string;
  seconds: number;
  link: SourceLink;
}

export class YouTube {
  private readonly env: NodeJS.ProcessEnv;
  private readonly run: RunCommand;
  private readonly tmpRoot?: string;

  constructor(deps: YouTubeDeps = {}) {
    this.env = deps.env ?? process.env;
    this.run = deps.run ?? spawnProcess;
    this.tmpRoot = deps.tmpRoot;
  }

  private get ffmpeg(): string {
    return this.env.FFMPEG_PATH?.trim() || 'ffmpeg';
  }

  /** env → PATH → vendored package, in that order; a missing binary is named, never silent. */
  private async runYtDlp(args: string[], phase: 'preview' | 'fetch') {
    const configured = this.env.YTDLP_PATH?.trim();
    try {
      return await this.run(configured || 'yt-dlp', args, { timeoutMs: phase === 'preview' ? PREVIEW_TIMEOUT_MS : FETCH_TIMEOUT_MS });
    } catch (error) {
      if (error instanceof ProcessError && error.reason === 'missing') {
        if (!configured) {
          const vendored = vendoredYtDlp();
          if (vendored) {
            try {
              return await this.run(vendored, args, { timeoutMs: phase === 'preview' ? PREVIEW_TIMEOUT_MS : FETCH_TIMEOUT_MS });
            } catch (inner) {
              if (!(inner instanceof ProcessError)) throw inner;
              throw new YouTubeError(inner.message, inner.reason === 'missing' ? 'ytdlp_missing' : phase === 'preview' ? 'preview_failed' : 'fetch_failed');
            }
          }
        }
        throw new YouTubeError('yt-dlp is not installed on this device — video links need it (brew install yt-dlp).', 'ytdlp_missing');
      }
      if (error instanceof ProcessError) throw new YouTubeError(error.message, phase === 'preview' ? 'preview_failed' : 'fetch_failed');
      throw error;
    }
  }

  /** Metadata only — the consent card. Refuses over-length videos before a byte is fetched. */
  async preview(rawUrl: string, opts: { maxSeconds?: number } = {}): Promise<Omit<VideoPreview, 'schemaVersion'>> {
    const { url, videoId } = parseVideoUrl(rawUrl);
    log.info('video_url_preview', { host: 'youtube.com', videoId });
    const result = await this.runYtDlp(['--dump-json', '--no-playlist', '--no-warnings', '--socket-timeout', '20', '--', url], 'preview');
    if (result.code !== 0) throw classifyYtDlpError(result.stderr, 'preview_failed');

    let info: DumpInfo;
    try {
      info = JSON.parse(result.stdout) as DumpInfo;
    } catch {
      throw new YouTubeError('yt-dlp answered with metadata that could not be read.', 'preview_failed');
    }
    const seconds = Number.isFinite(info.duration) && info.duration! > 0 ? info.duration! : 0;
    const max = opts.maxSeconds ?? INGEST_LIMITS.maxAudioSeconds;
    if (seconds > max) {
      throw new YouTubeError(`That video is ${formatDuration(seconds)} long; the limit is ${formatDuration(max)}.`, 'video_too_long');
    }
    const thumbnail = info.thumbnail && /^https:\/\//.test(info.thumbnail) ? info.thumbnail : undefined;
    return {
      provider: 'youtube',
      url: info.webpage_url && info.webpage_url.startsWith('https://') ? info.webpage_url : url,
      videoId: info.id && VIDEO_ID.test(info.id) ? info.id : videoId,
      title: (info.title ?? '').trim() || 'A YouTube video',
      seconds,
      ...(info.uploader || info.channel ? { uploader: info.uploader ?? info.channel } : {}),
      ...(thumbnail ? { thumbnailUrl: thumbnail } : {}),
    };
  }

  /**
   * The consented fetch: extract just the audio track to WAV inside a bounded temp dir,
   * keep its provenance, delete intermediates. The duration filter runs in yt-dlp so an
   * over-long video is refused before the bulk of the download.
   */
  async fetchAudio(rawUrl: string, opts: { maxSeconds?: number; maxBytes?: number } = {}): Promise<FetchedAudio> {
    const { url, videoId } = parseVideoUrl(rawUrl);
    const maxSeconds = opts.maxSeconds ?? INGEST_LIMITS.maxAudioSeconds;
    const maxBytes = opts.maxBytes ?? INGEST_LIMITS.maxAudioBytes;

    // ffmpeg does the -x extraction; check it up front so a missing binary is named
    // before the download starts, not after.
    try {
      await this.run(this.ffmpeg, ['-version'], { timeoutMs: 15_000 });
    } catch (error) {
      if (error instanceof ProcessError && error.reason === 'missing') {
        throw new YouTubeError('ffmpeg is not installed — video links need it to pull the audio track (brew install ffmpeg).', 'ffmpeg_missing');
      }
      throw error;
    }

    log.info('video_url_fetch', { host: 'youtube.com', videoId });
    const work = this.tmpRoot ?? (await mkdtemp(path.join(tmpdir(), 'sef-yt-')));
    const owned = !this.tmpRoot;
    if (!owned) await rm(path.join(work, 'video.info.json'), { force: true }).catch(() => {});
    const outTpl = path.join(work, 'video.%(ext)s');
    const args = [
      '-x', '--audio-format', 'wav', '--no-playlist', '--no-warnings', '--write-info-json',
      '--match-filter', `duration<=${maxSeconds}`,
      ...(this.env.FFMPEG_PATH?.trim() ? ['--ffmpeg-location', this.env.FFMPEG_PATH.trim()] : []),
      '-o', outTpl, '--', url,
    ];
    try {
      const result = await this.runYtDlp(args, 'fetch');
      if (result.code !== 0) throw classifyYtDlpError(result.stderr, 'fetch_failed');

      let info: DumpInfo = {};
      const infoPath = path.join(work, 'video.info.json');
      if (existsSync(infoPath)) {
        try {
          info = JSON.parse(await readFile(infoPath, 'utf8')) as DumpInfo;
        } catch {
          log.warn('video_info_unreadable', { videoId });
        }
      }
      const seconds = Number.isFinite(info.duration) && info.duration! > 0 ? info.duration! : 0;
      if (seconds > maxSeconds) {
        throw new YouTubeError(`That video is ${formatDuration(seconds)} long; the limit is ${formatDuration(maxSeconds)}.`, 'video_too_long');
      }

      // The extractor names its output after the template; anything else is a failure.
      const produced = (await readdir(work)).find((f) => f.startsWith('video.') && !f.endsWith('.info.json'));
      if (!produced) throw new YouTubeError('No audio track came back from that video.', 'no_audio_stream');
      if (produced !== 'video.wav') log.warn('video_audio_unexpected_container', { videoId, file: produced });
      const bytes = new Uint8Array(await readFile(path.join(work, produced)));
      if (bytes.byteLength === 0) throw new YouTubeError('That video produced an empty audio track.', 'no_audio_stream');
      if (bytes.byteLength > maxBytes) {
        throw new YouTubeError(`The audio track is too large to keep — the limit is ${Math.round(maxBytes / 1024 / 1024)} MB.`, 'video_too_large');
      }
      const mediaType =
        produced === 'video.wav' ? 'audio/wav'
        : produced.endsWith('.m4a') ? 'audio/mp4'
        : produced.endsWith('.mp3') ? 'audio/mpeg'
        : produced.endsWith('.ogg') || produced.endsWith('.opus') ? 'audio/ogg'
        : produced.endsWith('.flac') ? 'audio/flac'
        : 'audio/wav';
      return {
        bytes,
        mediaType,
        title: (info.title ?? '').trim() || 'A YouTube video',
        ...(info.uploader || info.channel ? { uploader: info.uploader ?? info.channel } : {}),
        seconds,
        link: { provider: 'youtube', url, videoId: info.id && VIDEO_ID.test(info.id) ? info.id : videoId, fetchedAt: new Date().toISOString() },
      };
    } finally {
      if (owned) await rm(work, { recursive: true, force: true }).catch(() => {});
      else {
        for (const f of await readdir(work).catch(() => [] as string[])) {
          if (f.startsWith('video.')) await rm(path.join(work, f), { force: true }).catch(() => {});
        }
      }
    }
  }
}
