import type { ConceptPage, LearningEvent, Lesson, LogisticsRecord, MaintenanceReport } from '@sef/shared';
import { computeStatus } from '../brain/mastery';
import type { PageSnapshot } from '../brain/wiki-store';
import { attempt } from '../lib/attempt';
import { questionPages } from '../signals/inputs';
import type { ConceptSummary, LessonSummary, PageSummary, SeedInputs } from './seeds';

/** The existing stores suggestions read from — never written. */
export interface SeedSources {
  logistics: () => Promise<LogisticsRecord[]>;
  pages: () => Promise<PageSnapshot[]>;
  events: () => Promise<LearningEvent[]>;
  maintenance: () => Promise<MaintenanceReport>;
  concepts: () => Promise<ConceptPage[]>;
  lessons: () => Promise<Lesson[]>;
  studiedLessonIds: () => Promise<string[]>;
  feedItems?: () => Promise<NonNullable<SeedInputs['feedItems']>>;
  planSteps?: () => Promise<NonNullable<SeedInputs['planSteps']>>;
}

const read = <T>(source: string, fn: () => Promise<T>) => attempt('suggestion_input_failed', source, fn);

export function pageSummaries(pages: PageSnapshot[]): PageSummary[] {
  return pages.flatMap((page) => {
    const meta = page.metadata;
    if (page.state !== 'ok' || !meta) return [];
    return [{ id: page.id, kind: meta.kind, title: meta.title, updatedAt: meta.updatedAt, links: meta.links.map((link) => link.toPageId) }];
  });
}

export function conceptSummaries(pages: ConceptPage[]): ConceptSummary[] {
  return pages.map((p) => ({
    key: p.key,
    concept: p.concept,
    status: computeStatus(p),
    openMisconceptions: p.misconceptions.filter((m) => !m.resolved).length,
    updated: p.updated,
  }));
}

export function lessonSummaries(lessons: Lesson[]): LessonSummary[] {
  return lessons.map((l) => ({ id: l.id, title: l.title, semesterNumber: l.semesterNumber, order: l.order, concepts: l.concepts }));
}

export async function gatherSeedInputs(sources: SeedSources): Promise<Omit<SeedInputs, 'now'>> {
  const [logistics, pages, events, report, concepts, lessons, studiedLessonIds, feedItems, planSteps] = await Promise.all([
    read('logistics', sources.logistics),
    read('pages', sources.pages),
    read('events', sources.events),
    read('maintenance', sources.maintenance),
    read('concepts', sources.concepts),
    read('lessons', sources.lessons),
    read('sessions', sources.studiedLessonIds),
    sources.feedItems ? read('feeds', sources.feedItems) : undefined,
    sources.planSteps ? read('plans', sources.planSteps) : undefined,
  ]);
  return {
    logistics,
    concepts: concepts && conceptSummaries(concepts),
    lessons: lessons && lessonSummaries(lessons),
    studiedLessonIds,
    pages: pages && pageSummaries(pages),
    questions: pages && events ? questionPages(pages, events) : undefined,
    findings: report?.findings.map((f) => ({ id: f.id, kind: f.kind, pageIds: f.pageIds })),
    feedItems,
    planSteps,
  };
}
