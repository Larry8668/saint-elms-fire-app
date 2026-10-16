import type { SourceCitation, SourceRecord } from '@sef/shared';

/** One job source paired with the text its extraction produced. */
export interface SourceBlob {
  record: SourceRecord;
  text: string;
}

/**
 * Locates a quote verbatim inside a source and returns a real citation. Anything not found
 * word-for-word returns null so the caller drops the claim — a citation the code cannot
 * point at is no citation.
 */
export function resolveQuote(quote: string, blobs: SourceBlob[]): SourceCitation | null {
  const needle = quote.trim();
  if (!needle) return null;
  for (const blob of blobs) {
    const exact = blob.text.indexOf(needle);
    if (exact !== -1) return citationFor(blob.record, exact, exact + needle.length);
    const fuzzy = findNormalized(blob.text, needle);
    if (fuzzy) return citationFor(blob.record, fuzzy.start, fuzzy.end);
  }
  return null;
}

const citationFor = (record: SourceRecord, start: number, end: number): SourceCitation => ({
  sourceId: record.id,
  sourceRevision: record.revision,
  sha256: record.sha256,
  locator: { kind: 'text', start, end },
});

/**
 * Whitespace- and case-tolerant fallback: small models occasionally re-wrap a quote. The
 * search is still verbatim — every non-whitespace character must match in order — only the
 * spacing between them is allowed to differ.
 */
function findNormalized(haystack: string, needle: string): { start: number; end: number } | null {
  const compactNeedle = needle.replace(/\s+/g, '').toLowerCase();
  if (compactNeedle.length < 8) return null;
  const hay = haystack.toLowerCase();
  let start = -1;
  let matched = 0;
  for (let i = 0; i < hay.length; i++) {
    const ch = hay[i]!;
    if (matched === 0) {
      if (/\s/.test(ch)) continue;
      if (ch === compactNeedle[0]) {
        start = i;
        matched = 1;
      }
      continue;
    }
    if (/\s/.test(ch)) continue;
    if (ch === compactNeedle[matched]) {
      matched += 1;
      if (matched === compactNeedle.length) return { start, end: i + 1 };
    } else {
      i = start;
      start = -1;
      matched = 0;
    }
  }
  return null;
}
