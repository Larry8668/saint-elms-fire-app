import { dueInstant, TEACHER_POLICIES, type LogisticsRecord, type TeacherId } from '@sef/shared';
import type { QuestionPage } from '../signals/detectors';

const DAY = 86_400_000;
const DEADLINE_HORIZON_MS = 14 * DAY;
const NOTICE_WINDOW_MS = 14 * DAY;
const STALE_CONCEPT_MS = 21 * DAY;
const DEFAULT_TTL_MS = DAY;
const MAX_UNSTARTED_LESSONS = 3;
const FEED_SEED_WINDOW_MS = 7 * DAY;
const MAX_FEED_SEEDS = 3;

export type KnowledgeClass = (typeof TEACHER_POLICIES)[TeacherId]['knowledge'][number];

export const SEED_KINDS = [
  'deadline',
  'notice',
  'weak_concept',
  'stale_concept',
  'unstarted_lesson',
  'open_question',
  'synthesis_link',
  'missing_connection',
  'feed_item',
] as const;
export type SeedKind = (typeof SEED_KINDS)[number];

/**
 * Which teacher may suggest from which seed kind, and under which of that teacher's
 * knowledge classes. `seedsFor` re-checks every entry against `TEACHER_POLICIES`, so a
 * policy change that withdraws a class silences the matching suggestions.
 */
export const SEED_SCOPE: Record<SeedKind, Partial<Record<TeacherId, KnowledgeClass>>> = {
  deadline: { friend: 'confirmed_logistics' },
  notice: { friend: 'confirmed_logistics' },
  weak_concept: { guide: 'learner_evidence' },
  stale_concept: { guide: 'learner_evidence' },
  unstarted_lesson: { guide: 'released_courseware' },
  open_question: { guide: 'course_wiki_claims', philosopher: 'anchored_wiki' },
  synthesis_link: { philosopher: 'anchored_wiki' },
  missing_connection: { philosopher: 'anchored_wiki' },
  feed_item: { philosopher: 'consented_web' },
};

/** A deterministic reason to suggest something. Wording is derived from `slots` only. */
export interface Seed {
  key: string;
  kind: SeedKind;
  /** Named entities the question is about; drafted wording must keep each one verbatim. */
  slots: Record<string, string>;
  refs: string[];
  why: string;
  /** 0–1: how time-pressing it is. */
  urgency: number;
  /** Epoch ms of the underlying activity, for recency ranking. */
  at: number;
  expiresAt: number;
  /** Set on outside text (feed headlines): it reaches a model only when the student clicks it. */
  draftable?: false;
}

export interface ConceptSummary {
  key: string;
  concept: string;
  status: 'shaky' | 'met' | 'solid' | 'unseen';
  openMisconceptions: number;
  updated: string;
}

export interface LessonSummary {
  id: string;
  title: string;
  semesterNumber: number;
  order: number;
  concepts: string[];
}

export interface PageSummary {
  id: string;
  kind: string;
  title: string;
  updatedAt: string;
  links: string[];
}

/** Undefined means the source could not be read; its seeds are simply absent this time. */
export interface SeedInputs {
  now: Date;
  logistics?: LogisticsRecord[];
  concepts?: ConceptSummary[];
  lessons?: LessonSummary[];
  studiedLessonIds?: string[];
  pages?: PageSummary[];
  questions?: QuestionPage[];
  findings?: Array<{ id: string; kind: string; pageIds: string[] }>;
  feedItems?: Array<{ id: string; feedId: string; title: string; fetchedAt: string }>;
}

const parsed = (iso: string) => {
  const ms = Date.parse(iso);
  return Number.isNaN(ms) ? 0 : ms;
};

function logisticsSeeds({ logistics = [], now }: SeedInputs): Seed[] {
  const t = now.getTime();
  return logistics.flatMap((record): Seed[] => {
    if (record.state !== 'confirmed' || record.kind === 'timetable') return [];
    if (record.kind === 'notice') {
      const updated = parsed(record.updatedAt);
      if (t - updated > NOTICE_WINDOW_MS) return [];
      return [{ key: `notice:${record.id}`, kind: 'notice', slots: { title: record.title }, refs: [`logistics:${record.id}`], why: 'A notice you confirmed recently', urgency: 0.3, at: updated, expiresAt: updated + NOTICE_WINDOW_MS }];
    }
    const due = dueInstant(record);
    if (due === null || due <= t || due - t > DEADLINE_HORIZON_MS) return [];
    return [
      {
        key: `deadline:${record.id}`,
        kind: 'deadline',
        slots: { title: record.title, day: weekday(due, record.timeZone) },
        refs: [`logistics:${record.id}`],
        why: 'A confirmed deadline in the next two weeks',
        urgency: Math.max(0.4, 1 - (due - t) / DEADLINE_HORIZON_MS),
        at: parsed(record.updatedAt),
        // The chip leaves with the deadline.
        expiresAt: due,
      },
    ];
  });
}

function weekday(instant: number, timeZone: string | null): string {
  try {
    return new Intl.DateTimeFormat('en-GB', { weekday: 'long', ...(timeZone ? { timeZone } : {}) }).format(new Date(instant));
  } catch {
    return new Intl.DateTimeFormat('en-GB', { weekday: 'long' }).format(new Date(instant));
  }
}

function conceptSeeds({ concepts = [], now }: SeedInputs): Seed[] {
  const t = now.getTime();
  return concepts.flatMap((c): Seed[] => {
    const at = parsed(c.updated);
    if (c.status === 'shaky' || c.openMisconceptions > 0) {
      return [{ key: `weak_concept:${c.key}`, kind: 'weak_concept', slots: { concept: c.concept }, refs: [`page:${c.key}`], why: c.openMisconceptions ? 'An open misconception on this concept' : 'Your evidence on this concept is still shaky', urgency: 0.6, at, expiresAt: t + DEFAULT_TTL_MS }];
    }
    if ((c.status === 'met' || c.status === 'solid') && t - at > STALE_CONCEPT_MS) {
      return [{ key: `stale_concept:${c.key}`, kind: 'stale_concept', slots: { concept: c.concept }, refs: [`page:${c.key}`], why: 'You have not revisited this concept in three weeks', urgency: 0.3, at, expiresAt: t + DEFAULT_TTL_MS }];
    }
    return [];
  });
}

function lessonSeeds({ lessons = [], studiedLessonIds, concepts, now }: SeedInputs): Seed[] {
  // Without both, every lesson would look unstarted.
  if (!studiedLessonIds || !concepts) return [];
  const studied = new Set(studiedLessonIds);
  const known = new Set(concepts.map((c) => c.key));
  return [...lessons]
    .sort((a, b) => a.semesterNumber - b.semesterNumber || a.order - b.order)
    .filter((lesson) => !studied.has(lesson.id) && !lesson.concepts.some((key) => known.has(key)))
    .slice(0, MAX_UNSTARTED_LESSONS)
    .map((lesson, index) => ({
      key: `unstarted_lesson:${lesson.id}`,
      kind: 'unstarted_lesson' as const,
      slots: { title: lesson.title },
      refs: [`lesson:${lesson.id}`],
      why: 'A released lesson you have not started — next in course order',
      urgency: 0.2,
      // Course order stands in for recency: earlier lessons rank first.
      at: now.getTime() - index,
      expiresAt: now.getTime() + DEFAULT_TTL_MS,
    }));
}

function questionSeeds({ questions = [], now }: SeedInputs): Seed[] {
  return questions.map((q) => ({
    key: `open_question:${q.id}`,
    kind: 'open_question' as const,
    slots: { title: q.title },
    refs: [`page:${q.id}`],
    why: 'An open question in your wiki',
    urgency: 0.4,
    at: parsed(q.lastActivityAt),
    expiresAt: now.getTime() + DEFAULT_TTL_MS,
  }));
}

function connectionSeeds({ pages = [], findings = [], now }: SeedInputs): Seed[] {
  const byId = new Map(pages.map((p) => [p.id, p]));
  const ttl = now.getTime() + DEFAULT_TTL_MS;
  const syntheses = pages.flatMap((page): Seed[] => {
    if (page.kind !== 'synthesis') return [];
    const [a, b] = page.links.map((id) => byId.get(id)).filter((p) => p !== undefined);
    if (!a || !b) return [];
    return [{ key: `synthesis_link:${page.id}`, kind: 'synthesis_link', slots: { a: a.title, b: b.title }, refs: [`page:${page.id}`, `page:${a.id}`, `page:${b.id}`], why: `Your synthesis “${page.title}” connects these`, urgency: 0.3, at: parsed(page.updatedAt), expiresAt: ttl }];
  });
  const missing = findings.flatMap((finding): Seed[] => {
    if (finding.kind !== 'missing_connection' && finding.kind !== 'unrecorded_link') return [];
    const [a, b] = finding.pageIds.map((id) => byId.get(id));
    if (!a || !b) return [];
    return [{ key: `missing_connection:${finding.id}`, kind: 'missing_connection', slots: { a: a.title, b: b.title }, refs: [`finding:${finding.id}`, `page:${a.id}`, `page:${b.id}`], why: 'Maintenance noticed these pages may be connected', urgency: 0.25, at: Math.max(parsed(a.updatedAt), parsed(b.updatedAt)), expiresAt: ttl }];
  });
  return [...syntheses, ...missing];
}

function feedSeeds({ feedItems = [], now }: SeedInputs): Seed[] {
  const t = now.getTime();
  return feedItems
    .filter((item) => t - parsed(item.fetchedAt) <= FEED_SEED_WINDOW_MS)
    .slice(0, MAX_FEED_SEEDS)
    .map((item) => ({
      key: `feed_item:${item.id}`,
      kind: 'feed_item' as const,
      slots: { title: item.title },
      refs: [`feed:${item.feedId}`, `feed_item:${item.id}`],
      why: 'A recent headline from a subject feed you follow',
      urgency: 0.2,
      at: parsed(item.fetchedAt),
      expiresAt: parsed(item.fetchedAt) + FEED_SEED_WINDOW_MS,
      draftable: false as const,
    }));
}

export function extractSeeds(inputs: SeedInputs): Seed[] {
  return [...logisticsSeeds(inputs), ...conceptSeeds(inputs), ...lessonSeeds(inputs), ...questionSeeds(inputs), ...connectionSeeds(inputs), ...feedSeeds(inputs)];
}

/** The seeds this teacher may suggest from: scoped by kind, then re-checked against its policy. */
export function seedsFor(teacher: TeacherId, seeds: Seed[]): Seed[] {
  const allowed: readonly string[] = TEACHER_POLICIES[teacher].knowledge;
  return seeds.filter((seed) => {
    const knowledge = SEED_SCOPE[seed.kind][teacher];
    return knowledge !== undefined && allowed.includes(knowledge);
  });
}
