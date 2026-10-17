import type { PlanWorld } from '../world';

export const NOW = new Date('2026-10-15T10:00:00.000Z');

/** A small seeded workspace: two concepts, an open question, a note, two lessons, one signal. */
export function makeWorld(overrides: Partial<PlanWorld> = {}): PlanWorld {
  return {
    now: NOW,
    pages: new Map([
      ['thermo-first-law', { id: 'thermo-first-law', kind: 'concept', title: 'First law of thermodynamics', updatedAt: '2026-10-10T00:00:00.000Z' }],
      ['entropy', { id: 'entropy', kind: 'concept', title: 'Entropy', updatedAt: '2026-10-11T00:00:00.000Z' }],
      ['q-carnot', { id: 'q-carnot', kind: 'question', title: 'Why is Carnot efficiency the upper bound?', updatedAt: '2026-10-12T00:00:00.000Z' }],
      ['note-lab', { id: 'note-lab', kind: 'note', title: 'Calorimetry lab notes', updatedAt: '2026-10-09T00:00:00.000Z' }],
    ]),
    lessons: new Map([
      ['l-heat-engines', { id: 'l-heat-engines', title: 'Heat engines', courseId: 'phys201', concepts: ['entropy'] }],
      ['l-enthalpy', { id: 'l-enthalpy', title: 'Enthalpy', courseId: 'phys201', concepts: [] }],
    ]),
    signals: new Map([['deadline:log-1:48h', { key: 'deadline:log-1:48h', kind: 'deadline', title: 'Thermo problem set due Thursday' }]]),
    dismissedSignals: new Set(),
    signalsKnown: true,
    events: [],
    quizzes: [],
    lessonActivity: [],
    courseVersions: { phys201: '1.2.0' },
    ...overrides,
  };
}
