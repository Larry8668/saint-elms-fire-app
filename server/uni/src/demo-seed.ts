import { DEMO_PERSONAS, type DispersalRecord } from '@sef/shared';
import type { UniDeps } from './deps';
import { log } from './logger';

const daysAgo = (days: number, hour = 10) => {
  const d = new Date(Date.now() - days * 86_400_000);
  d.setHours(hour, (days * 37) % 60, 0, 0);
  return d.toISOString();
};

/** Courses each persona's device is "behind" on, so the dispersal view has something to flag. */
const STALE: Record<string, string[]> = { brinda: ['real-analysis'], chetna: ['linear-algebra', 'solid-state-physics'] };

const SHARES = [
  {
    cohortId: 'bsc-pma-2026',
    fromStudent: 'Rohan',
    title: 'Free-body diagrams: my 4-step checklist',
    markdown:
      '1. Isolate the body.\n2. Draw every contact force, then gravity.\n3. Pick axes along the acceleration.\n4. Write ΣF = ma per axis *before* plugging numbers.\n\nThe Guide kept asking me "what touches it?" and that is honestly the whole trick.',
    days: 2,
  },
  {
    cohortId: 'bsc-pma-2025',
    fromStudent: 'Brinda',
    fromAccountId: 'brinda',
    title: 'Why the ε-δ definition is just a contract',
    markdown:
      'Think of ε as a challenge from a sceptic and δ as your reply. Continuity means you can always answer.\n\nThis made uniform continuity click: the same δ must work everywhere.',
    days: 5,
  },
  {
    cohortId: 'bsc-pma-2024',
    fromStudent: 'Chetna',
    fromAccountId: 'chetna',
    title: 'Reading list: band theory without tears',
    markdown:
      '- Kittel ch. 7 for the nearly-free electron picture\n- Ashcroft & Mermin ch. 8 for Bloch\'s theorem\n- The Philosopher found a good review on tight-binding in 2D materials (link in my wiki).',
    days: 1,
  },
];

/** Runs once, right after accounts are seeded, so the admin panel has a believable history. */
export async function seedUniDemo(deps: UniDeps): Promise<void> {
  const records: DispersalRecord[] = [];
  for (const persona of DEMO_PERSONAS) {
    const cohort = deps.releases.cohorts().find((c) => c.id === persona.cohortId);
    for (const [index, courseId] of (cohort?.courses ?? []).entries()) {
      const course = deps.courseware.courses.get(courseId);
      if (!course) continue;
      const stale = STALE[persona.id]?.includes(courseId);
      records.push({
        accountId: persona.id,
        cohortId: persona.cohortId,
        courseId,
        version: stale ? `${course.summary.version.slice(0, 8)}prev0001` : course.summary.version,
        at: daysAgo(stale ? 24 : 1 + (index % 9), 9 + (index % 8)),
      });
    }
  }
  await deps.dispersal.seed(records);

  for (const { days, ...share } of SHARES) await deps.shares.add({ ...share, createdAt: daysAgo(days, 16) });

  await deps.audit.record('admin', 'cohort_created', 'bsc-pma-2026 (Semester 1 intake)');
  await deps.audit.record('admin', 'courses_released', 'semester 1 for bsc-pma-2026');
  log.info('uni_demo_seeded', { dispersal: records.length, shares: SHARES.length });
}
