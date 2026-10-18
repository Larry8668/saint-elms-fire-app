/**
 * Hard limits for anything a student hands the wiki. These are enforced before bytes are
 * written or parsed, not after, so a hostile or merely enormous input cannot become the
 * problem. Every limit is explicit rather than implicit in a library default, because the
 * engine runs on a laptop that will also be holding the vault.
 */

export const INGEST_LIMITS = {
  /** Decoded bytes for one source. Larger is refused, never truncated. */
  maxSourceBytes: 25 * 1024 * 1024,
  /** A PDF page count above this is refused rather than partially read. */
  maxPdfPages: 400,
  /** Longest extracted text we will keep from one source. */
  maxExtractedChars: 400_000,
  /** Pixel dimensions for an image, before any vision call. */
  maxImageDimension: 4096,
  maxImagePixels: 4096 * 4096,
  /** Bytes for one audio recording — a compressed four-hour lecture sits far under this. */
  maxAudioBytes: 256 * 1024 * 1024,
  /** Bytes for one uploaded lecture video — the same ceiling as a recording. */
  maxVideoBytes: 256 * 1024 * 1024,
  /** Recording length in seconds. Longer is refused, never partially transcribed. */
  maxAudioSeconds: 4 * 60 * 60,
  /** Concurrent extraction jobs for one profile. */
  maxActiveJobs: 4,
  /** Sources attached to a single job. */
  maxSourcesPerJob: 25,
} as const;

/** Media types we accept. Anything else is refused by name, not sniffed past. */
export const ACCEPTED_MEDIA = {
  note: 'text/markdown',
  text: 'text/plain',
  markdown: 'text/markdown',
  pdf: 'application/pdf',
  png: 'image/png',
  jpeg: 'image/jpeg',
  jpg: 'image/jpeg',
  image: 'image/png',
} as const;

export type AcceptedKind = keyof typeof ACCEPTED_MEDIA;

/** The distinct media types anything may declare — the set ACCEPTED_MEDIA points into. */
export const ACCEPTED_MEDIA_TYPES: ReadonlySet<string> = new Set<string>(Object.values(ACCEPTED_MEDIA));

/**
 * Uploaded video containers. Unlike audio this is a closed list: a video's frames are
 * decoded and handed to the vision model, so only the containers lecture recordings
 * actually arrive in are accepted.
 */
export const ACCEPTED_VIDEO_TYPES: ReadonlySet<string> = new Set<string>(['video/mp4', 'video/quicktime', 'video/webm', 'video/x-matroska']);

/** The base type, lower-cased and stripped of parameters — what every family check compares. */
export const baseMediaType = (mediaType: string): string => mediaType.split(';')[0]!.trim().toLowerCase();
export const isAudioMedia = (mediaType: string): boolean => baseMediaType(mediaType).startsWith('audio/');
export const isVideoMedia = (mediaType: string): boolean => ACCEPTED_VIDEO_TYPES.has(baseMediaType(mediaType));

/**
 * The check behind the allowlist, run before bytes are stored or served. Parameters and
 * case are tolerated (`Text/Markdown; charset=utf-8` is markdown); the base type must be
 * one of the listed few, because the stored type later decides extraction and headers.
 */
export function checkMediaType(mediaType: string): Rejection | null {
  const base = baseMediaType(mediaType);
  // The audio family is accepted wholesale: containers vary wildly (voice memos arrive as
  // 3gpp, m4a, ogg, weba…), and ffmpeg decides readability — a file it cannot parse is
  // refused by name at probe time rather than guessed at from a mime list.
  if (!base || (!ACCEPTED_MEDIA_TYPES.has(base) && !base.startsWith('audio/') && !ACCEPTED_VIDEO_TYPES.has(base))) {
    return {
      code: 'unsupported_media',
      message: `Files of type '${mediaType.trim() || 'unknown'}' cannot be kept here — notes and plain text, PDFs, PNG or JPEG images, audio recordings and MP4, MOV, WebM or MKV videos only.`,
    };
  }
  return null;
}

/**
 * Overrides for tests and for a deliberately stricter deployment. Typed as plain numbers
 * rather than derived from the `as const` defaults, so a caller can actually pass a value
 * other than the default.
 */
export interface Limits {
  maxSourceBytes?: number;
  maxPdfPages?: number;
  maxExtractedChars?: number;
  maxImageDimension?: number;
  maxImagePixels?: number;
  maxAudioBytes?: number;
  maxAudioSeconds?: number;
  maxVideoBytes?: number;
  maxActiveJobs?: number;
  maxSourcesPerJob?: number;
}

export interface Rejection {
  code: 'empty' | 'too_large' | 'unsupported_media' | 'unsafe_filename' | 'too_many_pages' | 'image_too_large' | 'audio_too_long';
  message: string;
}

/**
 * A conservative, collision-resistant filename for the on-disk original. The student's own
 * name is kept only as a readable hint; anything that could escape the sources directory or
 * confuse a later parse is replaced.
 */
const MEDIA_EXTENSIONS: Record<string, string> = {
  'application/pdf': '.pdf',
  'image/png': '.png',
  'image/jpeg': '.jpg',
  'text/markdown': '.md',
  'text/plain': '.txt',
  'audio/mpeg': '.mp3',
  'audio/wav': '.wav',
  'audio/x-wav': '.wav',
  'audio/mp4': '.m4a',
  'audio/x-m4a': '.m4a',
  'audio/aac': '.aac',
  'audio/ogg': '.ogg',
  'audio/webm': '.weba',
  'audio/flac': '.flac',
  'audio/3gpp': '.3gp',
  'audio/3gpp2': '.3g2',
  'video/mp4': '.mp4',
  'video/quicktime': '.mov',
  'video/webm': '.webm',
  'video/x-matroska': '.mkv',
};

/** Downloads keep a usable name even when the declared type was only the family. */
export function mediaExtension(mediaType: string): string {
  return MEDIA_EXTENSIONS[mediaType.trim().toLowerCase()] ?? (mediaType.trim().toLowerCase().startsWith('audio/') ? '.audio' : '.bin');
}

export function safeSourceFilename(id: string, mediaType: string): string {
  return `${id}${mediaExtension(mediaType)}`;
}

/**
 * Guards a client-supplied display title. It is never used as a path, but it does reach
 * markdown pages and log lines, so control characters and path syntax are stripped.
 */
export function sanitiseTitle(raw: string): string {
  const cleaned = raw
    .replace(/[\u0000-\u001f\u007f]/g, ' ')
    .replace(/[\\/]+/g, ' ')
    // Strip leading dots, separators and the spaces the replacements leave behind, so
    // `../../x` cannot survive as `.. x` — and collapse interior `..` runs, which
    // titleIsSafe refuses wherever they sit.
    .replace(/^[\s./]+/, '')
    .replace(/\.{2,}/g, '.')
    .trim();
  return cleaned.slice(0, 300) || 'Untitled source';
}

/** Rejects a title that would escape or collide with the vault layout. */
export function titleIsSafe(raw: string): boolean {
  if (!raw.trim()) return false;
  if (/[\u0000-\u001f\u007f]/.test(raw)) return false;
  // Path separators would let a title act like a location if it ever reached a path join.
  return !/[/\\]/.test(raw) && !raw.includes('..');
}

export function checkBytes(bytes: Uint8Array, limits: Limits = {}): Rejection | null {
  const max = limits.maxSourceBytes ?? INGEST_LIMITS.maxSourceBytes;
  if (bytes.byteLength === 0) return { code: 'empty', message: 'That file is empty.' };
  if (bytes.byteLength > max) {
    return { code: 'too_large', message: `That file is ${formatBytes(bytes.byteLength)}; the limit is ${formatBytes(max)}.` };
  }
  return null;
}

/**
 * Size gate with the media family taken into account: audio recordings and videos run to
 * dedicated, much larger caps because a lecture's bytes are legitimately long.
 */
export function checkSourceBytes(bytes: Uint8Array, mediaType: string, limits: Limits = {}): Rejection | null {
  const base = baseMediaType(mediaType);
  if (base.startsWith('audio/')) {
    const max = limits.maxAudioBytes ?? INGEST_LIMITS.maxAudioBytes;
    if (bytes.byteLength === 0) return { code: 'empty', message: 'That file is empty.' };
    if (bytes.byteLength > max) {
      return { code: 'too_large', message: `That recording is ${formatBytes(bytes.byteLength)}; the audio limit is ${formatBytes(max)}.` };
    }
    return null;
  }
  if (ACCEPTED_VIDEO_TYPES.has(base)) {
    const max = limits.maxVideoBytes ?? INGEST_LIMITS.maxVideoBytes;
    if (bytes.byteLength === 0) return { code: 'empty', message: 'That file is empty.' };
    if (bytes.byteLength > max) {
      return { code: 'too_large', message: `That video is ${formatBytes(bytes.byteLength)}; the video limit is ${formatBytes(max)}.` };
    }
    return null;
  }
  return checkBytes(bytes, limits);
}

/** Probed length of a recording, refused outright — a long file is never half-transcribed. */
export function checkAudioDuration(seconds: number, limits: Limits = {}): Rejection | null {
  const max = limits.maxAudioSeconds ?? INGEST_LIMITS.maxAudioSeconds;
  if (!Number.isFinite(seconds) || seconds <= 0) {
    return { code: 'unsupported_media', message: 'That file does not read as audio.' };
  }
  if (seconds > max) {
    return { code: 'audio_too_long', message: `That recording is ${formatDuration(seconds)}; the audio limit is ${formatDuration(max)}.` };
  }
  return null;
}

/** h:mm:ss for short lengths, "N hours" phrased for the message's own readability. */
export function formatDuration(seconds: number): string {
  const s = Math.round(seconds);
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const rest = s % 60;
  if (h === 0) return `${m}:${String(rest).padStart(2, '0')}`;
  return `${h}:${String(m).padStart(2, '0')}:${String(rest).padStart(2, '0')}`;
}

export function checkImageDimensions(width: number, height: number, limits: Limits = {}): Rejection | null {
  const maxDim = limits.maxImageDimension ?? INGEST_LIMITS.maxImageDimension;
  const maxPixels = limits.maxImagePixels ?? INGEST_LIMITS.maxImagePixels;
  if (width <= 0 || height <= 0) return { code: 'image_too_large', message: 'That image has no readable dimensions.' };
  if (width > maxDim || height > maxDim) {
    return { code: 'image_too_large', message: `That image is ${width}×${height}; the limit is ${maxDim}×${maxDim}.` };
  }
  if (width * height > maxPixels) {
    return { code: 'image_too_large', message: 'That image has too many pixels to read safely.' };
  }
  return null;
}

export function checkPageCount(pages: number, limits: Limits = {}): Rejection | null {
  const max = limits.maxPdfPages ?? INGEST_LIMITS.maxPdfPages;
  if (pages > max) return { code: 'too_many_pages', message: `That document has ${pages} pages; the limit is ${max}.` };
  return null;
}

export function checkSourceCount(count: number, limits: Limits = {}): Rejection | null {
  const max = limits.maxSourcesPerJob ?? INGEST_LIMITS.maxSourcesPerJob;
  if (count > max) return { code: 'too_large', message: `A job can take at most ${max} sources; this one has ${count}.` };
  return null;
}

export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  // Floored, never rounded up: the message appears next to a hard limit, so overstating
  // either side would mislead a student about what was refused.
  if (bytes < 1024 * 1024) return `${Math.floor(bytes / 1024)} KB`;
  return `${(Math.floor((bytes / (1024 * 1024)) * 10) / 10).toFixed(1)} MB`;
}

/** Characters as a student counts them — Unicode code points, not UTF-16 code units. */
export const countChars = (text: string): number => [...text].length;
export const sliceChars = (text: string, max: number): string => [...text].slice(0, max).join('');
