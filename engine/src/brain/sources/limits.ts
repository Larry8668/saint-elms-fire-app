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
  maxActiveJobs?: number;
  maxSourcesPerJob?: number;
}

export interface Rejection {
  code: 'empty' | 'too_large' | 'unsupported_media' | 'unsafe_filename' | 'too_many_pages' | 'image_too_large';
  message: string;
}

/**
 * A conservative, collision-resistant filename for the on-disk original. The student's own
 * name is kept only as a readable hint; anything that could escape the sources directory or
 * confuse a later parse is replaced.
 */
export function safeSourceFilename(id: string, mediaType: string): string {
  const extension = mediaType.includes('pdf') ? '.pdf' : mediaType.includes('png') ? '.png' : mediaType.includes('jpeg') ? '.jpg' : mediaType.includes('markdown') ? '.md' : '.txt';
  return `${id}${extension}`;
}

/**
 * Guards a client-supplied display title. It is never used as a path, but it does reach
 * markdown pages and log lines, so control characters and path syntax are stripped.
 */
export function sanitiseTitle(raw: string): string {
  const cleaned = raw
    .replace(/[\u0000-\u001f\u007f]/g, ' ')
    .replace(/[\\/]+/g, '/')
    // Strip leading dots and slashes repeatedly, so `../../x` cannot survive as `../x`.
    .replace(/^[./]+/, '')
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
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(0)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}
