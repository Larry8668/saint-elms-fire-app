import type { LearningEvent, LogisticsRecord, MaintenanceReport, WikiJob } from '@sef/shared';
import type { PageSnapshot } from '../brain/wiki-store';
import { attempt } from '../lib/attempt';
import type { HealthProbe } from '../system/health';
import type { FindingSummary, QuestionPage, SignalInputs } from './detectors';

/** The existing stores a workspace already holds — signals only ever read them. */
export interface SignalSources {
  logistics: () => Promise<LogisticsRecord[]>;
  jobs: () => Promise<WikiJob[]>;
  pages: () => Promise<PageSnapshot[]>;
  events: () => Promise<LearningEvent[]>;
  maintenance: () => Promise<MaintenanceReport>;
  health: () => Promise<HealthProbe>;
}

/** A failed read stays undefined so its detector preserves, rather than clears, what it knew. */
const read = <T>(source: string, fn: () => Promise<T>) => attempt('signal_input_failed', source, fn);

export function questionPages(pages: PageSnapshot[], events: LearningEvent[]): QuestionPage[] {
  const lastEvent = new Map<string, string>();
  for (const event of events) {
    const previous = lastEvent.get(event.pageId);
    if (!previous || Date.parse(event.at) > Date.parse(previous)) lastEvent.set(event.pageId, event.at);
  }
  return pages.flatMap((page) => {
    const meta = page.metadata;
    if (page.state !== 'ok' || meta?.kind !== 'question') return [];
    const touched = lastEvent.get(page.id);
    const lastActivityAt = touched && Date.parse(touched) > Date.parse(meta.updatedAt) ? touched : meta.updatedAt;
    return [{ id: page.id, title: meta.title, revision: page.revision, lastActivityAt }];
  });
}

export async function gatherSignalInputs(sources: SignalSources): Promise<Omit<SignalInputs, 'now' | 'observations'>> {
  const [logistics, jobs, pages, events, report, health] = await Promise.all([
    read('logistics', sources.logistics),
    read('jobs', sources.jobs),
    read('pages', sources.pages),
    read('events', sources.events),
    read('maintenance', sources.maintenance),
    read('health', sources.health),
  ]);
  const findings: FindingSummary[] | undefined = report?.findings.map((f) => ({ id: f.id, title: f.title, pageIds: f.pageIds }));
  return {
    logistics,
    jobs,
    questions: pages && events ? questionPages(pages, events) : undefined,
    findings,
    health,
  };
}
