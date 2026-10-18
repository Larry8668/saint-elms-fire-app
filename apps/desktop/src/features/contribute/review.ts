import type { ProposalPreview, SourceCitation, SourceRecord, WikiJob } from '@sef/shared';

/**
 * Pure helpers for the contribution + review screens. Everything shown comes from the
 * journaled job stage and the persisted records — nothing here simulates progress.
 */

export type BadgeTone = 'neutral' | 'beacon' | 'ember' | 'aurora' | 'gold' | 'rose';

export interface StageInfo {
  label: string;
  hint: string;
  tone: BadgeTone;
  /** True while the engine is between milestones — worth polling for. */
  busy: boolean;
}

export const STAGE_INFO: Record<WikiJob['stage'], StageInfo> = {
  queued: { label: 'Queued', hint: 'Kept; waiting its turn', tone: 'neutral', busy: true },
  extracting: { label: 'Reading', hint: 'The engine is reading the kept bytes', tone: 'beacon', busy: true },
  awaiting_source_review: { label: 'Check the reading', hint: 'The extracted text is waiting for your eyes', tone: 'gold', busy: false },
  compiling: { label: 'Drafting changes', hint: 'The brain keeper is proposing page updates', tone: 'beacon', busy: true },
  awaiting_review: { label: 'Proposal ready', hint: 'Decide which changes land in your wiki', tone: 'gold', busy: false },
  committed: { label: 'In your wiki', hint: 'Accepted and journaled into the vault', tone: 'aurora', busy: false },
  no_changes: { label: 'No changes', hint: 'Nothing in it touched your wiki', tone: 'neutral', busy: false },
  failed: { label: 'Failed', hint: 'The original is still kept — this can be retried', tone: 'rose', busy: false },
  cancelled: { label: 'Cancelled', hint: 'Withdrawn; nothing was written', tone: 'neutral', busy: false },
};

const TERMINAL_STAGES: ReadonlySet<WikiJob['stage']> = new Set(['committed', 'no_changes', 'failed', 'cancelled']);

export const isLiveJob = (stage: WikiJob['stage']) => !TERMINAL_STAGES.has(stage);

/** The rail a job card walks: kept → read → proposed → decided. */
export const FLOW_STEPS = ['Kept', 'Reading', 'Proposal', 'Your decision', 'In your wiki'] as const;

export function flowStep(stage: WikiJob['stage']): number {
  switch (stage) {
    case 'queued':
      return 0;
    case 'extracting':
    case 'awaiting_source_review':
      return 1;
    case 'compiling':
      return 2;
    case 'awaiting_review':
      return 3;
    case 'committed':
    case 'no_changes':
      return 4;
    default:
      return 0;
  }
}

/** What a chosen file becomes. Only a photo, a recording or a video can be the student's own material. */
export function uploadContribution(mediaType: string, own: boolean): { kind: 'document' | 'image' | 'audio' | 'video'; origin: 'student' | 'external' } {
  if (mediaType.startsWith('image/')) return { kind: 'image', origin: own ? 'student' : 'external' };
  if (mediaType.startsWith('audio/')) return { kind: 'audio', origin: own ? 'student' : 'external' };
  if (mediaType.startsWith('video/')) return { kind: 'video', origin: own ? 'student' : 'external' };
  return { kind: 'document', origin: 'external' };
}

/** Typed or pasted words: the student says whether they are their own understanding. */
export function textContribution(own: boolean): { kind: 'note' | 'document'; origin: 'student' | 'external' } {
  return own ? { kind: 'note', origin: 'student' } : { kind: 'document', origin: 'external' };
}

/** File.type is empty on some platforms; fall back to the extension. */
export function normalizeMediaType(file: { type: string; name: string }): string {
  if (file.type) return file.type;
  const name = file.name.toLowerCase();
  if (name.endsWith('.pdf')) return 'application/pdf';
  if (name.endsWith('.md') || name.endsWith('.markdown')) return 'text/markdown';
  if (name.endsWith('.txt')) return 'text/plain';
  if (name.endsWith('.png')) return 'image/png';
  if (/\.(jpe?g|webp|gif|heic|heif|avif|bmp|tiff?)$/.test(name)) return 'image/jpeg';
  if (name.endsWith('.mp3')) return 'audio/mpeg';
  if (name.endsWith('.wav')) return 'audio/wav';
  if (name.endsWith('.m4a')) return 'audio/mp4';
  if (name.endsWith('.aac')) return 'audio/aac';
  if (/\.(ogg|oga|opus)$/.test(name)) return 'audio/ogg';
  if (name.endsWith('.flac')) return 'audio/flac';
  if (name.endsWith('.weba')) return 'audio/webm';
  if (/\.3gp?$/.test(name) || name.endsWith('.3g2')) return 'audio/3gpp';
  if (name.endsWith('.mp4') || name.endsWith('.m4v')) return 'video/mp4';
  if (name.endsWith('.mov')) return 'video/quicktime';
  if (name.endsWith('.webm')) return 'video/webm';
  if (name.endsWith('.mkv')) return 'video/x-matroska';
  return 'application/octet-stream';
}

/** m:ss / h:mm:ss for preview cards — recordings and video lengths. */
export function formatSeconds(seconds: number): string {
  const s = Math.max(0, Math.round(seconds));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const rest = s % 60;
  if (h === 0) return `${m}:${String(rest).padStart(2, '0')}`;
  return `${h}:${String(m).padStart(2, '0')}:${String(rest).padStart(2, '0')}`;
}

export const sourceKindLabel = (kind: SourceRecord['kind']): string =>
  ({ note: 'Note', document: 'Document', image: 'Photo', audio: 'Recording', video: 'Video', session: 'Conversation', answer: 'Answer', peer: 'From a peer' })[kind] ?? kind;

export const originLabel = (origin: SourceRecord['origin']): string =>
  ({ student: 'your own', external: 'external', course: 'course', peer: 'a peer', model: 'a model' })[origin] ?? origin;

export const pageKindLabel = (kind: ProposalPreview['pages'][number]['kind']): string =>
  ({ concept: 'Concept', source_summary: 'Source note', synthesis: 'Synthesis', question: 'Question' })[kind] ?? kind;

/** Whether a correction can still change what a compile reads. */
export function canCorrect(job: WikiJob | null): boolean {
  return !job || job.stage === 'queued' || job.stage === 'extracting' || job.stage === 'awaiting_source_review' || job.stage === 'failed';
}

/** What a citation points at inside its source, in one short phrase. */
export function locatorLabel(locator: SourceCitation['locator']): string {
  switch (locator.kind) {
    case 'text':
      return 'a passage';
    case 'pdf':
      return `page ${locator.page}`;
    case 'image':
      return 'the photo transcription';
    case 'session':
      return `turns ${locator.firstTurn + 1}–${locator.lastTurn + 1}`;
  }
}

/**
 * The evidence behind a citation: text locators slice the retained extraction; pdf and
 * image locators carry their own excerpt; a session citation's range is its label.
 */
export function citationExcerpt(citation: SourceCitation, extractionText: string | null | undefined): string | null {
  const locator = citation.locator;
  if (locator.kind === 'text') {
    if (extractionText == null) return null;
    const excerpt = extractionText.slice(locator.start, locator.end).trim();
    return excerpt || null;
  }
  if (locator.kind === 'pdf' || locator.kind === 'image') return locator.excerpt;
  return null;
}

/** The counts a review banner needs, in one pass over the preview's pages. */
export function previewSummary(preview: ProposalPreview): { created: number; updated: number; unchanged: number; claims: number; links: number } {
  return {
    created: preview.pages.filter((p) => p.change === 'created').length,
    updated: preview.pages.filter((p) => p.change === 'updated').length,
    unchanged: preview.pages.filter((p) => p.change === 'unchanged').length,
    claims: preview.pages.reduce((n, p) => n + p.addedClaims.length, 0),
    links: preview.pages.reduce((n, p) => n + p.addedLinks.length, 0),
  };
}

/** The page body only — frontmatter is metadata, not prose to read. */
export function pageBody(raw: string): string {
  const match = raw.match(/^---\n[\s\S]*?\n---\n?/);
  return match ? raw.slice(match[0].length) : raw;
}

export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  const units = ['KB', 'MB', 'GB'];
  let size = bytes / 1024;
  let unit = 0;
  while (size >= 1024 && unit < units.length - 1) {
    size /= 1024;
    unit++;
  }
  return `${size.toFixed(size >= 10 ? 0 : 1)} ${units[unit]}`;
}
