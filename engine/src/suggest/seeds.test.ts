import assert from 'node:assert/strict';
import { test } from 'node:test';
import { TEACHER_IDS, TEACHER_POLICIES } from '@sef/shared';
import { extractSeeds, SEED_KINDS, SEED_SCOPE, seedsFor } from './seeds';
import { daysFromNow, logisticsRecord, NOW, richInputs } from './testing/fixtures';

const kindsFor = (teacher: (typeof TEACHER_IDS)[number]) => new Set(seedsFor(teacher, extractSeeds({ ...richInputs(), now: NOW })).map((s) => s.kind));

test('every seed scope entry names a knowledge class its teacher actually holds', () => {
  for (const kind of SEED_KINDS) {
    for (const [teacher, knowledge] of Object.entries(SEED_SCOPE[kind])) {
      assert.ok((TEACHER_POLICIES[teacher as keyof typeof TEACHER_POLICIES].knowledge as readonly string[]).includes(knowledge!), `${kind} → ${teacher}`);
    }
  }
});

test('the Friend only ever sees logistics; the Guide and Philosopher never do', () => {
  assert.deepEqual([...kindsFor('friend')].sort(), ['deadline', 'notice']);
  const guide = kindsFor('guide');
  const philosopher = kindsFor('philosopher');
  for (const kinds of [guide, philosopher]) {
    assert.ok(!kinds.has('deadline') && !kinds.has('notice'), 'no logistics outside the Friend');
  }
  assert.deepEqual([...guide].sort(), ['open_question', 'stale_concept', 'unstarted_lesson', 'weak_concept']);
  assert.deepEqual([...philosopher].sort(), ['missing_connection', 'open_question', 'synthesis_link']);
});

test('a policy that withdraws a knowledge class silences its seeds', (t) => {
  const original = TEACHER_POLICIES.guide.knowledge;
  t.after(() => Object.assign(TEACHER_POLICIES.guide, { knowledge: original }));
  Object.assign(TEACHER_POLICIES.guide, { knowledge: ['released_courseware'] });
  assert.deepEqual([...kindsFor('guide')], ['unstarted_lesson']);
});

test('deadline seeds: confirmed, upcoming, within two weeks — and they expire with the deadline', () => {
  const logistics = [
    logisticsRecord('ok', { title: 'Essay', dueAt: daysFromNow(2) }),
    logisticsRecord('past', { dueAt: daysFromNow(-1) }),
    logisticsRecord('far', { dueAt: daysFromNow(30) }),
    logisticsRecord('draft', { state: 'proposed' }),
    logisticsRecord('class', { kind: 'timetable' }),
  ];
  const seeds = extractSeeds({ now: NOW, logistics });
  assert.deepEqual(seeds.map((s) => s.key), ['deadline:ok']);
  assert.equal(seeds[0]!.expiresAt, Date.parse(daysFromNow(2)));
  assert.equal(seeds[0]!.slots.day, 'Monday');
});

test('unstarted lessons follow course order and skip studied or already-known concepts', () => {
  const lessons = [
    { id: 'a', title: 'A', semesterNumber: 1, order: 3, concepts: [] },
    { id: 'b', title: 'B', semesterNumber: 1, order: 1, concepts: ['known'] },
    { id: 'c', title: 'C', semesterNumber: 1, order: 2, concepts: [] },
    { id: 'd', title: 'D', semesterNumber: 2, order: 0, concepts: [] },
  ];
  const concepts = [{ key: 'known', concept: 'Known', status: 'met' as const, openMisconceptions: 0, updated: daysFromNow(-1) }];
  const seeds = extractSeeds({ now: NOW, lessons, concepts, studiedLessonIds: ['a'] });
  assert.deepEqual(seeds.filter((s) => s.kind === 'unstarted_lesson').map((s) => s.refs[0]), ['lesson:c', 'lesson:d']);
  assert.deepEqual(extractSeeds({ now: NOW, lessons, studiedLessonIds: [] }), [], 'unknown concepts → no lesson seeds rather than all of them');
});

test('a connection seed needs both pages to exist', () => {
  const seeds = extractSeeds({ now: NOW, pages: [{ id: 'x', kind: 'concept', title: 'X', updatedAt: daysFromNow(-1), links: [] }], findings: [{ id: 'f', kind: 'missing_connection', pageIds: ['x', 'ghost'] }] });
  assert.deepEqual(seeds, []);
});

test('plan steps: the next pending step per plan, Guide only, signal steps left to attention', () => {
  const step = (planId: string, id: string, kind: 'quiz' | 'read_lesson' | 'resolve_signal', subject: string) => ({
    planId,
    goal: 'Revise thermodynamics',
    deadlineAt: planId === 'plan_soon' ? daysFromNow(2) : null,
    step: { id, kind, subject, entityRefs: [kind === 'read_lesson' ? 'lesson:l1' : 'page:entropy'] },
  });
  const seeds = extractSeeds({
    now: NOW,
    planSteps: [
      step('plan_soon', 'st_1', 'resolve_signal', 'Problem set due'),
      step('plan_soon', 'st_2', 'quiz', 'Entropy'),
      step('plan_soon', 'st_3', 'read_lesson', 'Heat engines'),
      step('plan_later', 'st_1', 'read_lesson', 'Enthalpy'),
    ],
  });
  assert.deepEqual(seeds.map((s) => [s.key, s.variant, s.urgency]), [
    ['plan_step:plan_soon:st_2', 'quiz', 0.9],
    ['plan_step:plan_later:st_1', 'read_lesson', 0.7],
  ]);
  assert.deepEqual(seeds[0]!.slots, { subject: 'Entropy' });
  assert.deepEqual(seeds[0]!.refs, ['plan:plan_soon', 'page:entropy']);
  assert.equal(seedsFor('guide', seeds).length, 2);
  assert.equal(seedsFor('friend', seeds).length, 0);
  assert.equal(seedsFor('philosopher', seeds).length, 0);
});
