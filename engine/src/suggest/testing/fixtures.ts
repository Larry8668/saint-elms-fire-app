import type { LogisticsRecord } from '@sef/shared';
import type { SeedInputs } from '../seeds';

export const NOW = new Date('2026-10-17T10:00:00Z');
const DAY = 86_400_000;
export const daysFromNow = (days: number) => new Date(NOW.getTime() + days * DAY).toISOString();

export function logisticsRecord(id: string, over: Partial<LogisticsRecord> = {}): LogisticsRecord {
  return {
    id,
    title: `Item ${id}`,
    kind: 'deadline',
    state: 'confirmed',
    dueAt: daysFromNow(3),
    allDay: false,
    timeZone: 'UTC',
    details: '',
    provenance: { kind: 'manual' },
    createdAt: daysFromNow(-5),
    updatedAt: daysFromNow(-1),
    ...over,
  };
}

/** One seed source of every kind, so each teacher has something to suggest. */
export function richInputs(): Omit<SeedInputs, 'now'> {
  return {
    logistics: [logisticsRecord('lab-report', { title: 'Lab report' }), logisticsRecord('notice-1', { kind: 'notice', title: 'Library hours', dueAt: null })],
    concepts: [
      { key: 'entropy', concept: 'Entropy', status: 'shaky', openMisconceptions: 1, updated: daysFromNow(-2) },
      { key: 'momentum', concept: 'Momentum', status: 'solid', openMisconceptions: 0, updated: daysFromNow(-30) },
    ],
    lessons: [
      { id: 'l-heat', title: 'Heat engines', semesterNumber: 1, order: 2, concepts: ['heat-engine'] },
      { id: 'l-entropy', title: 'Entropy basics', semesterNumber: 1, order: 1, concepts: ['entropy'] },
    ],
    studiedLessonIds: [],
    pages: [
      { id: 'entropy', kind: 'concept', title: 'Entropy', updatedAt: daysFromNow(-2), links: [] },
      { id: 'momentum', kind: 'concept', title: 'Momentum', updatedAt: daysFromNow(-30), links: [] },
      { id: 'syn-1', kind: 'synthesis', title: 'Energy and order', updatedAt: daysFromNow(-1), links: ['entropy', 'momentum'] },
    ],
    questions: [{ id: 'q-1', title: 'Why does time have a direction?', revision: 'r1', lastActivityAt: daysFromNow(-1) }],
    findings: [{ id: 'f-1', kind: 'missing_connection', pageIds: ['entropy', 'momentum'] }],
  };
}
