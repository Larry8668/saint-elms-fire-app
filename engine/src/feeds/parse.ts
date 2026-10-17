/**
 * A deliberately small RSS 2.0 / Atom reader: it extracts title, link, summary and date per
 * entry and nothing else. Every string leaves here as inert, single-line plain text.
 */

export interface ParsedItem {
  title: string;
  link: string;
  summary: string;
  publishedAt: string | null;
}

const TITLE_MAX = 200;
const SUMMARY_MAX = 400;
const MAX_ENTRIES = 100;

const NAMED: Record<string, string> = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ' };

function decodeEntities(text: string): string {
  return text.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (whole, body: string) => {
    if (body[0] === '#') {
      const code = body[1]?.toLowerCase() === 'x' ? parseInt(body.slice(2), 16) : parseInt(body.slice(1), 10);
      return Number.isFinite(code) && code > 0 && code <= 0x10ffff ? String.fromCodePoint(code) : '';
    }
    return NAMED[body.toLowerCase()] ?? whole;
  });
}

/** CDATA unwrapped, tags stripped, entities decoded, control characters removed, whitespace collapsed. */
export function plainText(raw: string, max: number): string {
  const unwrapped = raw.replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1');
  // Entities decode after tag stripping too, so escaped markup inside a summary is removed.
  const text = decodeEntities(decodeEntities(unwrapped.replace(/<[^>]*>/g, ' ')).replace(/<[^>]*>/g, ' '))
    .replace(/[\u0000-\u001f\u007f-\u009f\u200b-\u200f\u2028-\u202e\u2066-\u2069]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  return text.length > max ? `${text.slice(0, max - 1)}…` : text;
}

const tag = (block: string, name: string) => block.match(new RegExp(`<${name}(?:\\s[^>]*)?>([\\s\\S]*?)</${name}>`, 'i'))?.[1];

function safeLink(candidate: string | undefined): string {
  if (!candidate) return '';
  const value = plainText(candidate, 1000);
  try {
    const url = new URL(value);
    return url.protocol === 'https:' || url.protocol === 'http:' ? url.toString() : '';
  } catch {
    return '';
  }
}

function atomLink(block: string): string | undefined {
  const links = [...block.matchAll(/<link\b([^>]*)\/?>/gi)].map((m) => m[1] ?? '');
  const href = (attrs: string) => attrs.match(/\bhref\s*=\s*["']([^"']+)["']/i)?.[1];
  const alternate = links.find((attrs) => !/\brel\s*=/i.test(attrs) || /\brel\s*=\s*["']alternate["']/i.test(attrs));
  return href(alternate ?? links[0] ?? '');
}

function isoDate(raw: string | undefined): string | null {
  if (!raw) return null;
  const ms = Date.parse(plainText(raw, 100));
  return Number.isNaN(ms) ? null : new Date(ms).toISOString();
}

/** Entries in document order; entries without a usable title are skipped. Malformed XML yields []. */
export function parseFeed(xml: string): ParsedItem[] {
  const isAtom = /<feed[\s>]/i.test(xml) && !/<rss[\s>]/i.test(xml);
  const blocks = [...xml.matchAll(isAtom ? /<entry[\s>][\s\S]*?<\/entry>/gi : /<item[\s>][\s\S]*?<\/item>/gi)].slice(0, MAX_ENTRIES).map((m) => m[0]);
  return blocks.flatMap((block) => {
    const title = plainText(tag(block, 'title') ?? '', TITLE_MAX);
    if (!title) return [];
    const link = isAtom ? safeLink(atomLink(block)) : safeLink(tag(block, 'link') ?? tag(block, 'guid'));
    const summary = plainText(tag(block, isAtom ? 'summary' : 'description') ?? '', SUMMARY_MAX);
    const publishedAt = isAtom ? isoDate(tag(block, 'published') ?? tag(block, 'updated')) : isoDate(tag(block, 'pubDate') ?? tag(block, 'dc:date'));
    return [{ title, link, summary, publishedAt }];
  });
}
