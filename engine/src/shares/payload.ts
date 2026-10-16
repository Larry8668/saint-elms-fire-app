import { createHash } from 'node:crypto';
import {
  CONTRACT_VERSION,
  HttpUrlSchema,
  SHARE_ATTACHMENT_LIMIT,
  SHARE_CITATION_LIMIT,
  type PublishShareRequest,
  type PublishedShare,
  type ShareCitation,
  type SharePayload,
  type SharedAttachment,
} from '@sef/shared';
import { countChars, sliceChars } from '../brain/sources/limits';

/** Payload caps mirror the uni contract; the byte cap mirrors the server's default shareMaxBytes. */
export const SHARE_TITLE_MAX = 160;
export const SHARE_MARKDOWN_MAX_CHARS = 10_000;
export const SHARE_MARKDOWN_MAX_BYTES = 10 * 1024;

const TRIM_NOTE = '\n\n_[… trimmed to fit the share limit.]_';

/**
 * Headings that never leave the device. The deterministic pass matches a heading's
 * whole text, so a section is dropped only when it is plainly one of the private
 * blocks — struggles, misconception work, quiz bookkeeping — not when a student
 * merely wrote about a hard idea.
 */
const PRIVATE_HEADING = /^(where i got stuck|my struggles?|misconceptions?|open misconceptions|evidence|quiz(zes)? results?|quiz(zes)?|contact (info|details)|private notes?)$/i;

/**
 * Fixed rules of the allowlist, surfaced to the author so the preview explains itself:
 * these categories are never in a payload by construction, not merely by detection.
 */
export const NEVER_SHARED = [
  'Quiz results and other mastery evidence',
  'Conversations with your teachers',
  'Contact details (names, emails, phone numbers) found outside the page body',
  'Pages you did not choose to share',
] as const;

/** The shareable view of one vault page, whichever format it was stored in. */
export interface ShareSourcePage {
  title: string;
  kind: 'concept' | 'source_summary' | 'synthesis' | 'question';
  summary: string;
  body: string;
}

export interface BuiltShare {
  payload: SharePayload;
  /** What the builder left out, in words the preview can list honestly. */
  excluded: string[];
}

interface HeadingBlock {
  level: number;
  heading: string;
  start: number;
  end: number;
}

const HEADING_LINE = /^(#{1,6})\s+(.+?)\s*$/;

/**
 * Cuts the body into heading blocks. A block runs until the next heading of the same
 * or a shallower level, so `## Where I got stuck` also swallows its `###` subsections —
 * the private part cannot leak back in by nesting.
 */
function blocksOf(lines: string[]): HeadingBlock[] {
  const headings = lines
    .map((line, index) => ({ index, match: line.match(HEADING_LINE) }))
    .filter((entry): entry is { index: number; match: RegExpMatchArray } => entry.match !== null)
    .map(({ index, match }) => ({ level: match[1]!.length, heading: match[2]!, start: index }));
  const blocks: HeadingBlock[] = [];
  for (let i = 0; i < headings.length; i++) {
    const current = headings[i]!;
    const next = headings.slice(i + 1).find((h) => h.level <= current.level);
    blocks.push({ ...current, end: next ? next.start : lines.length });
  }
  return blocks;
}

/**
 * Deterministic payload builder — code, not a model, decides what leaves the device.
 * Kept: the page title, its summary, and every body section that is not on the
 * private denylist. Dropped: private struggle/misconception/quiz sections.
 * `[[page-id]]` references stay in the text: on the receiving side they are
 * explicit references to vault pages the sender did not share.
 */
export function buildSharePayload(page: ShareSourcePage, attachments: SharedAttachment[] = []): BuiltShare {
  const excluded: string[] = [];
  const lines = page.body.replace(/\r\n/g, '\n').split('\n');

  const blocks = blocksOf(lines);
  const dropped = new Set<number>();
  for (const block of blocks) {
    if (block.level === 1) {
      // The document's own H1 duplicates the title field; drop it and keep the intro text.
      lines[block.start] = '';
      continue;
    }
    if (PRIVATE_HEADING.test(block.heading)) {
      excluded.push(`“${block.heading}” section`);
      for (let i = block.start; i < block.end; i++) dropped.add(i);
    }
  }
  const kept = lines.filter((_, index) => !dropped.has(index)).join('\n').replace(/\n{3,}/g, '\n\n').trim();

  const title = sliceChars(page.title.trim(), SHARE_TITLE_MAX) || 'Untitled page';
  const parts = [`# ${title}`];
  if (page.summary.trim()) parts.push(`_${page.summary.trim()}_`);
  if (kept) parts.push(kept);
  parts.push(
    '---',
    '_Shared through the cohort feed. `[[page-id]]` links name pages in the sender’s own second brain — ' +
      'they are references the sender kept, not material the sender shared._',
  );
  const markdown = fitShareMarkdown(parts.join('\n\n'));

  const citations = extractCitations(markdown);
  if (citations.overflow) excluded.push(`${citations.overflow} further link(s) — the ${SHARE_CITATION_LIMIT}-citation cap`);
  for (const item of NEVER_SHARED) excluded.push(item);

  return {
    payload: {
      title,
      markdown,
      citations: citations.items.slice(0, SHARE_CITATION_LIMIT),
      attachments: attachments.slice(0, SHARE_ATTACHMENT_LIMIT),
    },
    excluded,
  };
}

/** Fits within both caps: the schema's character cap and the server's byte cap. */
export function fitShareMarkdown(markdown: string): string {
  const fits = (text: string) => countChars(text) <= SHARE_MARKDOWN_MAX_CHARS && Buffer.byteLength(text, 'utf8') <= SHARE_MARKDOWN_MAX_BYTES;
  if (fits(markdown)) return markdown;
  // Reserve room for the note inside the caps — the reader should see the cut, not guess it.
  let text = markdown;
  while (!fits(text + TRIM_NOTE)) {
    text = sliceChars(text, Math.floor(countChars(text) * 0.9)).trimEnd();
  }
  return text + TRIM_NOTE;
}

/**
 * Citations are only links the shared text itself already makes — a `[label](url)`
 * keeps its label, a bare URL cites itself. Anything that is not a well-formed
 * public http(s) URL is skipped rather than shipped malformed.
 */
export function extractCitations(markdown: string): { items: ShareCitation[]; overflow: number } {
  const items: ShareCitation[] = [];
  const seen = new Set<string>();
  const push = (title: string, url: string) => {
    const clean = url.replace(/[.,;]+$/, '');
    if (seen.has(clean) || !HttpUrlSchema.safeParse(clean).success) return;
    seen.add(clean);
    items.push({ title: sliceChars(title.trim() || clean, 300), url: clean });
  };

  const linked = markdown.replace(/\[([^\]]{0,300})\]\((https?:\/\/[^)\s]+)\)/g, (_all, text: string, url: string) => {
    push(text, url);
    return '';
  });
  for (const match of linked.matchAll(/https?:\/\/[^\s)>\]]+/g)) {
    push(match[0], match[0]);
  }
  return { items: items.slice(0, SHARE_CITATION_LIMIT), overflow: Math.max(0, items.length - SHARE_CITATION_LIMIT) };
}

/**
 * The publish request's idempotency key is derived from page id + exact markdown:
 * a double-click or a retry sends the same key and the uni replays the first share.
 */
export function shareIdempotencyKey(pageId: string, markdown: string): string {
  const hash = createHash('sha256').update(markdown, 'utf8').digest('hex').slice(0, 24);
  return `pub_${pageId}_${hash}`.replace(/[^A-Za-z0-9_-]/g, '_').slice(0, 128);
}

/** The exact request the prepare step previews — the same object publish relays verbatim. */
export function shareRequest(pageId: string, programmeId: string, payload: SharePayload): PublishShareRequest {
  return {
    schemaVersion: CONTRACT_VERSION,
    programmeId,
    idempotencyKey: shareIdempotencyKey(pageId, payload.markdown),
    payload,
  };
}

/**
 * The frozen original of an imported share: the payload rendered as one markdown
 * document, with the share's identity quoted up front so a citation can always be
 * traced back to the feed item it came from. Attachment rows are descriptors —
 * the files they name were never sent.
 */
export function peerSourceDocument(share: PublishedShare): string {
  const lines: string[] = [
    `# ${share.payload.title}`,
    '',
    `> Shared by ${share.senderName} · cohort ${share.cohortId} · ${share.createdAt}`,
    `> Share ${share.id} · revision ${share.revision}`,
    '',
    share.payload.markdown,
  ];
  if (share.payload.citations.length) {
    lines.push('', '## Citations');
    for (const citation of share.payload.citations) {
      lines.push(`- ${citation.title}${citation.url ? ` — ${citation.url}` : ''}${citation.locator ? ` · ${citation.locator}` : ''}`);
    }
  }
  if (share.payload.attachments.length) {
    lines.push('', '## Attachments (descriptors only — the files themselves were not sent)');
    for (const attachment of share.payload.attachments) {
      lines.push(`- ${attachment.name} · ${attachment.mediaType} · ${attachment.bytes} bytes · sha256 ${attachment.sha256}`);
    }
  }
  return lines.join('\n');
}
