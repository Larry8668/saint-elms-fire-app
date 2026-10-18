import { createHash } from 'node:crypto';
import { INGEST_LIMITS, checkPageCount, countChars, sliceChars, type Limits, type Rejection } from './limits';

/**
 * Extraction turns a student's own bytes into text. It runs entirely on-device and never
 * calls out: an uploaded PDF or photo is read locally, and anything that cannot be read
 * honestly is reported as partial rather than smoothed over.
 *
 * Every extractor is total — it returns a result describing what it managed, never throws
 * into a job that cannot record why it failed.
 */

export type ExtractionMethod = 'text' | 'pdf' | 'vision' | 'audio' | 'video' | 'student_correction';

export interface ExtractionResult {
  method: ExtractionMethod;
  text: string;
  sha256: string;
  /** Set when extraction did not capture the whole source — truncated, pages unreadable, or bytes that decoded only partially. The job must surface this, not hide it. */
  partial: boolean;
  /** Human-readable reason for the truncation or failure. */
  note?: string;
  /** Page or image count actually read, when the source has one. */
  units?: number;
}

export type ExtractionOutcome = { ok: true; result: ExtractionResult } | { ok: false; rejection: Rejection };

export const sha256 = (bytes: Uint8Array): string => createHash('sha256').update(bytes).digest('hex');

/** Plain text and Markdown: decoded locally, never sent anywhere. */
export function extractText(bytes: Uint8Array, limits: Limits = {}): ExtractionOutcome {
  const max = limits.maxExtractedChars ?? INGEST_LIMITS.maxExtractedChars;
  // Strict first: a clean decode is the common case. On malformed UTF-8 we still read
  // what we can — with U+FFFD substitution — but flag the pass partial and say why,
  // rather than silently absorbing the damage or refusing the file outright.
  let undecodable = false;
  let decoded: string;
  try {
    decoded = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  } catch {
    undecodable = true;
    decoded = new TextDecoder('utf-8', { fatal: false }).decode(bytes);
  }
  // A NUL in the body usually means this was not text at all, whatever it claimed to be.
  if (decoded.includes('\u0000')) {
    return { ok: false, rejection: { code: 'unsupported_media', message: 'That file is not readable text.' } };
  }
  const truncated = countChars(decoded) > max;
  const text = sliceChars(decoded, max);
  const partial = truncated || undecodable;
  const notes: string[] = [];
  if (truncated) notes.push(`Only the first ${max.toLocaleString('en-GB')} characters were read`);
  if (undecodable) notes.push('Some bytes were not valid UTF-8 and were replaced');
  return {
    ok: true,
    result: {
      method: 'text',
      text,
      sha256: sha256(bytes),
      partial,
      ...(notes.length ? { note: `${notes.join('; ')}.` } : {}),
    },
  };
}

/** Strips a null byte and a stray BOM, which PDFs and screenshots both pick up. */
const tidy = (text: string): string => text.replace(/^\uFEFF/, '').replace(/\u0000/g, ' ');

/**
 * PDF text extraction. The heavy lifting is delegated to an injected reader so this module
 * stays testable without a real PDF engine, and so the caller controls which build is used.
 */
export interface PdfPageText {
  /** 1-based page number. */
  page: number;
  text: string;
}

export interface PdfReader {
  pages: number;
  readPage(page: number): Promise<string>;
}

/**
 * Reads a PDF page by page, enforcing the page limit *before* reading rather than after,
 * and reporting a partial result when a page fails instead of losing the whole document.
 */
export async function extractPdf(bytes: Uint8Array, reader: PdfReader, limits: Limits = {}): Promise<ExtractionOutcome> {
  const rejection = checkPageCount(reader.pages, limits);
  if (rejection) return { ok: false, rejection };

  const maxChars = limits.maxExtractedChars ?? INGEST_LIMITS.maxExtractedChars;
  const parts: string[] = [];
  let failed = 0;
  let total = 0;

  for (let page = 1; page <= reader.pages; page++) {
    let pageText: string;
    try {
      pageText = await reader.readPage(page);
    } catch {
      // One unreadable page must not discard the rest; it is reported as partial.
      failed++;
      continue;
    }
    const cleaned = tidy(pageText);
    if (!cleaned.trim()) continue;
    // `total` is the length of the eventual join, separators included.
    const joinOverhead = parts.length > 0 ? 2 : 0;
    const size = countChars(cleaned);
    if (total + joinOverhead + size > maxChars) {
      parts.push(sliceChars(cleaned, Math.max(0, maxChars - total - joinOverhead)));
      // Report both reasons when they coincide: the stop point and any pages already lost.
      const reasons = [`Stopped at page ${page} of ${reader.pages} at the ${maxChars.toLocaleString('en-GB')} character limit`];
      if (failed) reasons.push(`${failed} page${failed === 1 ? '' : 's'} could not be read`);
      return {
        ok: true,
        result: {
          method: 'pdf',
          text: parts.join('\n\n'),
          sha256: sha256(bytes),
          partial: true,
          note: `${reasons.join('; ')}.`,
          units: reader.pages,
        },
      };
    }
    parts.push(cleaned);
    total += joinOverhead + size;
  }

  const notes: string[] = [];
  if (failed) notes.push(`${failed} page${failed === 1 ? '' : 's'} could not be read`);
  // An empty result is reported, but it did not stop early — nothing was skipped.
  if (parts.join('').trim() === '') notes.push('No text layer was found — this may be a scanned document');

  return {
    ok: true,
    result: {
      method: 'pdf',
      text: parts.join('\n\n'),
      sha256: sha256(bytes),
      partial: failed > 0,
      ...(notes.length ? { note: `${notes.join('. ')}.` } : {}),
      units: reader.pages,
    },
  };
}

/**
 * Vision extraction is delegated to the local model. Dimensions are checked by the caller
 * before this point; this only records what came back.
 */
export function recordVisionText(bytes: Uint8Array, text: string, limits: Limits = {}): ExtractionOutcome {
  const maxChars = limits.maxExtractedChars ?? INGEST_LIMITS.maxExtractedChars;
  const partial = countChars(text) > maxChars;
  return {
    ok: true,
    result: {
      method: 'vision',
      text: sliceChars(text, maxChars),
      sha256: sha256(bytes),
      partial,
      ...(partial ? { note: `Only the first ${maxChars.toLocaleString('en-GB')} characters of the reading were kept.` } : {}),
    },
  };
}

/**
 * A recording's transcript, capped like every other reading. The transcriber reports its
 * own gaps (failed chunks, an early stop); truncation here just adds to the same note.
 */
export function recordAudioTranscript(bytes: Uint8Array, transcript: { text: string; chunks: number; partial: boolean; note?: string }, limits: Limits = {}): ExtractionOutcome {
  const maxChars = limits.maxExtractedChars ?? INGEST_LIMITS.maxExtractedChars;
  const truncated = countChars(transcript.text) > maxChars;
  const notes = [transcript.note?.replace(/\.+$/, ''), truncated ? `Only the first ${maxChars.toLocaleString('en-GB')} characters of the transcript were kept` : ''].filter(Boolean);
  return {
    ok: true,
    result: {
      method: 'audio',
      text: sliceChars(transcript.text, maxChars),
      sha256: sha256(bytes),
      partial: transcript.partial || truncated,
      ...(notes.length ? { note: `${notes.join('; ')}.` } : {}),
      units: transcript.chunks,
    },
  };
}

/**
 * A lecture video's merged reading — its audio transcript interleaved with what was legible
 * on screen. The reader reports its own gaps (failed chunks or frames); truncation adds to
 * the same note. `units` counts every piece actually read: audio chunks plus frames.
 */
export function recordVideoReading(
  bytes: Uint8Array,
  reading: { text: string; chunks: number; framesRead: number; partial: boolean; note?: string },
  limits: Limits = {},
): ExtractionOutcome {
  const maxChars = limits.maxExtractedChars ?? INGEST_LIMITS.maxExtractedChars;
  const truncated = countChars(reading.text) > maxChars;
  const notes = [reading.note?.replace(/\.+$/, ''), truncated ? `Only the first ${maxChars.toLocaleString('en-GB')} characters of the reading were kept` : ''].filter(Boolean);
  return {
    ok: true,
    result: {
      method: 'video',
      text: sliceChars(reading.text, maxChars),
      sha256: sha256(bytes),
      partial: reading.partial || truncated,
      ...(notes.length ? { note: `${notes.join('; ')}.` } : {}),
      units: reading.chunks + reading.framesRead,
    },
  };
}

/** A student correction is a derivative revision, never a rewrite of the original bytes. */
export function recordStudentCorrection(bytes: Uint8Array, text: string, limits: Limits = {}): ExtractionOutcome {
  const maxChars = limits.maxExtractedChars ?? INGEST_LIMITS.maxExtractedChars;
  const partial = countChars(text) > maxChars;
  return {
    ok: true,
    result: {
      method: 'student_correction',
      text: sliceChars(text, maxChars),
      sha256: sha256(bytes),
      partial,
      ...(partial ? { note: 'The correction was longer than the limit and was shortened.' } : {}),
    },
  };
}
