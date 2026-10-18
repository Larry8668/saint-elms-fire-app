import type { BrainLogEntry, ExtractionMethod, LearningEvent, MaintenanceFinding, SourceRecord, SourceSummary, WikiDispute } from '@sef/shared';

/**
 * The plain-language story of how the wiki compounds: raw sources go in, compiled pages come
 * out, and the brain keeps both versions when they disagree. Pure functions only — the
 * components in this folder render what these decide, and the tests pin the wording.
 */

/** How a piece of material reached the brain — one icon and one noun per modality. */
export type Modality = 'photo' | 'voice' | 'recording' | 'video' | 'pdf' | 'document' | 'note' | 'chat' | 'answer' | 'peer' | 'quiz' | 'you' | 'brain';

export const MODALITY_NOUN: Record<Modality, string> = {
  photo: 'a photo',
  voice: 'a voice memo',
  recording: 'a recording',
  video: 'a lecture video',
  pdf: 'a PDF',
  document: 'a document',
  note: 'a note',
  chat: 'a chat reflection',
  answer: 'a saved answer',
  peer: "a peer's page",
  quiz: 'a quiz',
  you: 'you',
  brain: 'the keeper',
};

type SourceLike = Pick<SourceSummary, 'kind' | 'mediaType'> & { origin?: SourceRecord['origin'] };

/** The modality a kept source reads as. A student's own audio is a voice memo; someone else's is a recording. */
export function modalityOf(source: SourceLike | undefined | null): Modality {
  if (!source) return 'brain';
  const media = source.mediaType.toLowerCase();
  switch (source.kind) {
    case 'image':
      return 'photo';
    case 'audio':
      return source.origin === 'external' ? 'recording' : 'voice';
    case 'video':
      return 'video';
    case 'document':
      return media.includes('pdf') ? 'pdf' : 'document';
    case 'note':
      return media.includes('pdf') ? 'pdf' : 'note';
    case 'session':
      return 'chat';
    case 'answer':
      return 'answer';
    case 'peer':
      return 'peer';
  }
  return 'brain';
}

export const capitalise = (text: string) => (text ? text[0]!.toUpperCase() + text.slice(1) : text);
const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

/**
 * How a source's text was produced, said honestly: only the vision, audio and video passes are
 * a model reading; a PDF's text layer and typed text are taken as written, and a student's
 * correction is theirs. `byModel` says whether "read by Gemma" is true.
 */
export function readingOf(passes: readonly { method: ExtractionMethod }[]): { method: ExtractionMethod | null; byModel: boolean; corrected: boolean; label: string } {
  const latest = passes.at(-1)?.method ?? null;
  const modelPass = [...passes].reverse().find((pass) => pass.method === 'vision' || pass.method === 'audio' || pass.method === 'video');
  const corrected = latest === 'student_correction';
  const method = corrected ? (modelPass?.method ?? [...passes].reverse().find((p) => p.method !== 'student_correction')?.method ?? null) : latest;
  const byModel = Boolean(modelPass) && (corrected || latest === modelPass?.method);
  let label: string;
  if (!method) label = corrected ? 'typed in by you' : 'not read yet';
  else if (byModel) label = `read by Gemma · ${method}`;
  else if (method === 'pdf') label = 'text layer · pdf';
  else label = 'kept as written · text';
  if (corrected && method) label += ', corrected by you';
  return { method, byModel, corrected, label };
}

// ---------------------------------------------------------------------------------------
// "What your brain learned" — the growth ledger told as sentences.

export interface PageRef {
  id: string;
  title: string;
  /** True when this entry wrote the page's first revision. */
  created: boolean;
}

export interface StoryEntry {
  id: string;
  at: string;
  modality: Modality;
  /** The sentence, with {page} placeholders already resolved to plain titles — `pages` carries the links. */
  sentence: string;
  pages: PageRef[];
  /** True when the student's own work is behind it (teal), false for collected knowledge. */
  yours: boolean;
}

export interface StoryInputs {
  events: readonly LearningEvent[];
  log?: readonly BrainLogEntry[];
  sources: readonly (SourceLike & { id: string })[];
  titleOf: (pageId: string) => string | undefined;
  kindOf?: (pageId: string) => string | undefined;
}

/** The vault source an event's evidence names first — the material behind the commit. */
export function primarySourceId(event: LearningEvent): string | null {
  for (const evidence of event.evidence) {
    if ('sourceId' in evidence) return evidence.sourceId;
    if (evidence.kind === 'source') return evidence.ref;
  }
  return null;
}

/**
 * The material behind a whole commit: the proposal's own source (the plain `source` refs every
 * event of the commit carries) wins over a claim's citation, which may name older material.
 */
export function commitSourceId(group: readonly LearningEvent[]): string | null {
  const counts = new Map<string, number>();
  for (const event of group) {
    for (const evidence of event.evidence) if ('kind' in evidence && evidence.kind === 'source') counts.set(evidence.ref, (counts.get(evidence.ref) ?? 0) + 1);
  }
  const top = [...counts].sort((a, b) => b[1] - a[1])[0]?.[0];
  return top ?? group.map(primarySourceId).find(Boolean) ?? null;
}

const linkTarget = (event: LearningEvent): string | null => event.note?.match(/^→\s*(\S+)/)?.[1] ?? null;
const artifactRef = (event: LearningEvent): string | null => event.evidence.find((e): e is { kind: 'artifact'; ref: string } => 'kind' in e && e.kind === 'artifact')?.ref ?? null;

/**
 * Log lines the ledger does not already tell. Every commit and every kept source also writes a
 * log line ("Wiki update from proposal …", "Frozen source: …") — the commit entry above says
 * that better — and course progress ("Started …") is not brain growth. Restores stay.
 */
const LOG_KINDS = new Set(['quiz', 'session', 'remove', 'erase', 'capture']);
const keepLog = (entry: BrainLogEntry) => LOG_KINDS.has(entry.kind) || (entry.kind === 'wiki' && entry.title.startsWith('Restored'));

/** log.md writes UTC as "YYYY-MM-DD HH:MM:SS"; normalised to ISO so it sorts and parses with the ledger. */
export const logTime = (at: string) => (/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/.test(at) ? `${at.replace(' ', 'T')}.000Z` : at);

/**
 * Folds the growth ledger (and the older log) into story entries, newest first. Events that
 * one commit wrote from one source become a single entry ("A voice memo became 2 new pages
 * and changed 3"); a link the student made, a quiz review and a peer import each read as
 * their own line.
 */
export function buildStory({ events, log = [], sources, titleOf, kindOf }: StoryInputs): StoryEntry[] {
  const sourceById = new Map(sources.map((s) => [s.id, s]));
  const title = (id: string) => titleOf(id) ?? id;
  const firstAt = new Map<string, string>();
  for (const event of events) {
    const seen = firstAt.get(event.pageId);
    if (!seen || event.at < seen) firstAt.set(event.pageId, event.at);
  }

  const entries: StoryEntry[] = [];
  const commits = new Map<string, LearningEvent[]>();
  for (const event of events) {
    if (event.kind === 'connection' && event.actor === 'student') {
      const to = linkTarget(event);
      entries.push({
        id: event.id,
        at: event.at,
        modality: 'you',
        sentence: to ? `You linked ${title(event.pageId)} to ${title(to)}` : `You made a link on ${title(event.pageId)}`,
        pages: [{ id: event.pageId, title: title(event.pageId), created: false }, ...(to ? [{ id: to, title: title(to), created: false }] : [])],
        yours: true,
      });
      continue;
    }
    if (event.kind === 'review' && artifactRef(event)?.startsWith('res_')) {
      entries.push({ id: event.id, at: event.at, modality: 'quiz', sentence: `You checked ${title(event.pageId)} with a quiz`, pages: [{ id: event.pageId, title: title(event.pageId), created: false }], yours: true });
      continue;
    }
    // One commit stamps every event it derives with the same instant.
    commits.set(event.at, [...(commits.get(event.at) ?? []), event]);
  }

  for (const [key, group] of commits) {
    const sourceId = commitSourceId(group);
    const source = sourceId ? sourceById.get(sourceId) : undefined;
    const modality = source ? modalityOf(source) : 'brain';
    const pageIds = [...new Set(group.map((e) => e.pageId))];
    const created = pageIds.filter((id) => firstAt.get(id) === group[0]!.at);
    const changed = pageIds.filter((id) => !created.includes(id));
    const subject = capitalise(MODALITY_NOUN[modality]);
    const yours = group.some((e) => e.actor === 'student');
    const pages: PageRef[] = [...created.map((id) => ({ id, title: title(id), created: true })), ...changed.map((id) => ({ id, title: title(id), created: false }))];

    const synthesis = created.find((id) => kindOf?.(id) === 'synthesis');
    let sentence: string;
    if (modality === 'peer') {
      sentence = created.length + changed.length === 1 ? "A peer's page was imported" : `A peer's share was imported into ${plural(created.length + changed.length, 'page')}`;
    } else if (synthesis && created.length === 1) {
      const targets = group.filter((e) => e.pageId === synthesis && e.kind === 'connection').map(linkTarget).filter((t): t is string => Boolean(t));
      sentence = targets.length >= 2 ? `${subject} added a synthesis linking ${title(targets[0]!)} to ${title(targets[1]!)}` : `${subject} added a synthesis`;
      if (changed.length) sentence += ` and changed ${plural(changed.length, 'page')}`;
      for (const target of targets.slice(0, 2)) if (!pages.some((p) => p.id === target)) pages.push({ id: target, title: title(target), created: false });
    } else if (created.length && changed.length) {
      sentence = `${subject} became ${plural(created.length, 'new page')} and changed ${changed.length}`;
    } else if (created.length) {
      sentence = created.length === 1 ? `${subject} became a new page` : `${subject} became ${plural(created.length, 'new page')}`;
    } else {
      const corrected = group.some((e) => e.kind === 'correction');
      sentence = `${subject} ${corrected ? 'corrected' : 'changed'} ${plural(changed.length, 'page')}`;
    }
    entries.push({ id: `commit:${key}`, at: group[0]!.at, modality, sentence, pages, yours });
  }

  for (const [i, entry] of log.entries()) {
    if (!keepLog(entry)) continue;
    const quiz = entry.kind === 'quiz';
    entries.push({
      id: `log:${i}:${entry.at}`,
      at: logTime(entry.at),
      modality: quiz ? 'quiz' : entry.kind === 'session' || entry.kind === 'capture' ? 'chat' : 'brain',
      sentence: quiz && entry.detail ? `${entry.title}: ${entry.detail.replace(/\.$/, '').toLowerCase()}` : entry.title,
      pages: [],
      yours: quiz || entry.kind === 'session',
    });
  }

  return entries.sort((a, b) => b.at.localeCompare(a.at));
}

const dayKey = (d: Date) => `${d.getFullYear()}-${d.getMonth()}-${d.getDate()}`;

/** "Today", "Yesterday", or a short date — the year only when it is not this one. */
export function dayLabel(at: string, now = new Date()): string {
  const date = new Date(at);
  if (Number.isNaN(date.getTime())) return at.slice(0, 10);
  if (dayKey(date) === dayKey(now)) return 'Today';
  const yesterday = new Date(now);
  yesterday.setDate(now.getDate() - 1);
  if (dayKey(date) === dayKey(yesterday)) return 'Yesterday';
  return date.toLocaleDateString(undefined, { weekday: 'short', day: 'numeric', month: 'short', ...(date.getFullYear() === now.getFullYear() ? {} : { year: 'numeric' }) });
}

/** Consecutive entries grouped under their day label, order kept. */
export function groupByDay<T extends { at: string }>(entries: readonly T[], now = new Date()): Array<{ label: string; entries: T[] }> {
  const groups: Array<{ label: string; entries: T[] }> = [];
  for (const entry of entries) {
    const label = dayLabel(entry.at, now);
    const last = groups.at(-1);
    if (last?.label === label) last.entries.push(entry);
    else groups.push({ label, entries: [entry] });
  }
  return groups;
}

// ---------------------------------------------------------------------------------------
// Provenance — which claim came from which source.

/** Sources numbered in the order the page names them, so a claim can say "from ②". */
export function sourceNumbers(sourceIds: readonly string[]): Map<string, number> {
  return new Map([...new Set(sourceIds)].map((id, i) => [id, i + 1]));
}

/** The distinct sources one claim cites, in citation order. */
export const claimSourceIds = (claim: { citations: readonly { sourceId: string }[] }): string[] => [...new Set(claim.citations.map((c) => c.sourceId))];

// ---------------------------------------------------------------------------------------
// Contradictions — both versions, side by side.

export interface DisagreementSide {
  label: string;
  text: string;
  origin?: WikiDispute['sides'][number]['origin'];
  sources: WikiDispute['sides'][number]['sources'];
  missingSourceIds: string[];
  pageId?: string;
}

export interface Disagreement {
  id: string;
  pageId: string;
  pageTitle: string;
  /** 'disputed' — both claims kept, marked disputed; 'flagged' — the review spotted it, nothing marked yet; 'misconception' — your words against the course's. */
  state: 'disputed' | 'flagged' | 'misconception';
  sides: DisagreementSide[];
  prompt: string;
}

const ORIGIN_SIDE: Record<WikiDispute['sides'][number]['origin'], string> = {
  student: 'In your words',
  course: 'The course says',
  external: 'An outside source says',
  peer: 'A peer wrote',
  model: 'A generated page says',
};

/**
 * Disputes the vault keeps, then contradictions the semantic review flagged that are not
 * already marked on the pages — deduped by page so one disagreement shows once.
 */
export function buildDisagreements(disputes: readonly WikiDispute[], findings: readonly MaintenanceFinding[], titleOf: (pageId: string) => string | undefined): Disagreement[] {
  const out: Disagreement[] = disputes.map((dispute) => ({
    id: dispute.id,
    pageId: dispute.pageId,
    pageTitle: dispute.pageTitle,
    state: dispute.kind === 'misconception' ? 'misconception' : 'disputed',
    sides: dispute.sides.map((side, i) => ({
      label: dispute.kind === 'misconception' ? (side.origin === 'student' ? 'You wrote' : 'The course says') : dispute.sides.length === 2 ? `${i === 0 ? 'Earlier' : 'Later'} · ${ORIGIN_SIDE[side.origin].toLowerCase()}` : ORIGIN_SIDE[side.origin],
      text: side.text,
      origin: side.origin,
      sources: side.sources,
      missingSourceIds: side.missingSourceIds,
    })),
    prompt: dispute.prompt,
  }));
  const claimsShown = new Set(disputes.flatMap((d) => d.sides.map((s) => `${d.pageId}|${s.claimId ?? ''}`)));
  for (const finding of findings) {
    if (finding.kind !== 'contradiction' || !finding.pageIds.length) continue;
    if (finding.evidence.length && finding.evidence.every((e) => e.claimId && claimsShown.has(`${e.pageId}|${e.claimId}`))) continue;
    const pageId = finding.pageIds[0]!;
    out.push({
      id: finding.id,
      pageId,
      pageTitle: finding.pageIds.map((id) => titleOf(id) ?? id).join(' · '),
      state: 'flagged',
      sides: finding.evidence.slice(0, 2).map((evidence) => ({ label: `On ${titleOf(evidence.pageId) ?? evidence.pageId}`, text: evidence.note, sources: [], missingSourceIds: [], pageId: evidence.pageId })),
      prompt: finding.prompt ?? `${finding.title} ${finding.detail} Help me work out which version holds up.`,
    });
  }
  const order = { disputed: 0, flagged: 1, misconception: 2 } as const;
  return out.sort((a, b) => order[a.state] - order[b.state]);
}
