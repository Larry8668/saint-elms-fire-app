import type { LearningEvent, Lesson } from '@sef/shared';
import type { PageSnapshot } from '../brain/wiki-plan';
import type { InstalledCourse } from '../content/store';
import { attempt } from '../lib/attempt';

/** Signal kinds whose titles carry outside text; they never enter a planner prompt. */
export const PLANNER_EXCLUDED_SIGNALS = new Set(['feed_item', 'share_incoming']);

/** Everything plans read, as one snapshot. Every field is derived from existing stores. */
export interface PlanWorld {
  now: Date;
  pages: Map<string, { id: string; kind: string; title: string; updatedAt: string }>;
  lessons: Map<string, { id: string; title: string; courseId: string; concepts: string[] }>;
  /** Live (not dismissed) signals by key. */
  signals: Map<string, { key: string; kind: string; title: string }>;
  /** Signals the student dismissed from the Attention panel — handled, as far as a plan is concerned. */
  dismissedSignals: Set<string>;
  /** False when the ledger could not be read; signal steps then neither complete nor go stale. */
  signalsKnown: boolean;
  events: Array<{ pageId: string; at: string }>;
  /** Completed quiz results, by the concept page they were taken on. */
  quizzes: Array<{ pageId: string; at: string }>;
  /** When a conversation last drew on each lesson. */
  lessonActivity: Array<{ lessonId: string; at: string }>;
  courseVersions: Record<string, string>;
}

export interface PlanWorldSources {
  pages: () => Promise<PageSnapshot[]>;
  events: () => Promise<LearningEvent[]>;
  lessons: () => Promise<Lesson[]>;
  installed: () => Promise<Record<string, InstalledCourse>>;
  signals: () => Promise<Array<{ key: string; kind: string; title: string; dismissed?: boolean }>>;
  quizzes: () => Promise<Array<{ pageId: string; at: string }>>;
  lessonActivity: () => Promise<Array<{ lessonId: string; at: string }>>;
}

/**
 * Builds the snapshot. A source that cannot be read becomes empty — for plans that errs
 * towards "not resolvable" (a step is dropped or marked stale), never towards inventing.
 */
export async function gatherPlanWorld(sources: PlanWorldSources, now = new Date()): Promise<PlanWorld> {
  const read = <T>(source: string, fn: () => Promise<T>, fallback: T) => attempt('plan_input_failed', source, fn).then((v) => v ?? fallback);
  const [pages, events, lessons, installed, signals, quizzes, lessonActivity] = await Promise.all([
    read('pages', sources.pages, []),
    read('events', sources.events, []),
    read('lessons', sources.lessons, []),
    read('installed', sources.installed, {}),
    attempt('plan_input_failed', 'signals', sources.signals),
    read('quizzes', sources.quizzes, []),
    read('lessonActivity', sources.lessonActivity, []),
  ]);
  return {
    now,
    pages: new Map(
      pages.flatMap((p) => (p.state === 'ok' && p.metadata ? [[p.id, { id: p.id, kind: p.metadata.kind, title: p.metadata.title, updatedAt: p.metadata.updatedAt }] as const] : [])),
    ),
    lessons: new Map(lessons.map((l) => [l.id, { id: l.id, title: l.title, courseId: l.courseId, concepts: l.concepts }])),
    signals: new Map((signals ?? []).filter((s) => !s.dismissed).map((s) => [s.key, { key: s.key, kind: s.kind, title: s.title }])),
    dismissedSignals: new Set((signals ?? []).filter((s) => s.dismissed).map((s) => s.key)),
    signalsKnown: signals !== undefined,
    events: events.map((e) => ({ pageId: e.pageId, at: e.at })),
    quizzes,
    lessonActivity,
    courseVersions: Object.fromEntries(Object.values(installed).map((c) => [c.id, c.version])),
  };
}
