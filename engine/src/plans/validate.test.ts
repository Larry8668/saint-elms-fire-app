import assert from 'node:assert/strict';
import { test } from 'node:test';
import { MAX_PLAN_STEPS, PlannerDraftSchema, PlanStepSchema } from '@sef/shared';
import { makeWorld } from './testing/world';
import { validateDraft } from './validate';

const world = makeWorld();
const step = (kind: string, entityRefs: string[], title = 'A step') => ({ title, detail: 'why', kind, entityRefs });

test('steps whose references all resolve are kept, primary ref first, subject from the workspace', () => {
  const { steps, notes } = validateDraft(
    {
      steps: [
        step('review_page', ['page:thermo-first-law'], 'Review the first law'),
        step('quiz', ['lesson:l-heat-engines', 'page:entropy']),
        step('answer_question', ['page:q-carnot']),
        step('read_lesson', ['lesson:l-enthalpy']),
        step('resolve_signal', ['signal:deadline:log-1:48h']),
      ],
    },
    world,
  );
  assert.deepEqual(notes, []);
  assert.equal(steps.length, 5);
  assert.deepEqual(steps[1]!.entityRefs, ['page:entropy', 'lesson:l-heat-engines']);
  assert.equal(steps[1]!.subject, 'Entropy');
  assert.equal(steps[3]!.subject, 'Enthalpy');
  for (const s of steps) {
    assert.equal(s.state, 'pending');
    PlanStepSchema.parse(s);
  }
});

test('bare or mis-prefixed ids are re-anchored to the one real thing they name', () => {
  const { steps, notes } = validateDraft(
    {
      steps: [
        step('read_lesson', ['l-heat-engines']),
        step('review_page', ['lesson:thermo-first-law']),
        step('quiz', ['`entropy`']),
        step('resolve_signal', ['deadline:log-1:48h']),
      ],
    },
    world,
  );
  assert.deepEqual(notes, []);
  assert.deepEqual(
    steps.map((s) => s.entityRefs[0]),
    ['lesson:l-heat-engines', 'page:thermo-first-law', 'page:entropy', 'signal:deadline:log-1:48h'],
  );
});

test('a bare id that names nothing real is still dropped, never guessed', () => {
  const { steps, notes } = validateDraft({ steps: [step('read_lesson', ['l-nonexistent']), step('review_page', ['admin-secrets'])] }, world);
  assert.equal(steps.length, 0);
  assert.equal(notes.length, 2);
  assert.match(notes[0]!, /not in your workspace \(l-nonexistent\)/);
});

test('an id shared by two kinds resolves to the one the step kind is about', () => {
  const shared = makeWorld();
  shared.lessons.set('entropy', { id: 'entropy', title: 'Entropy lecture', courseId: 'phys201', concepts: [] });
  const { steps } = validateDraft({ steps: [step('read_lesson', ['entropy']), step('quiz', ['entropy'])] }, shared);
  assert.deepEqual(
    steps.map((s) => s.entityRefs[0]),
    ['lesson:entropy', 'page:entropy'],
  );
});

test('an injected step on a nonexistent page is dropped and disclosed, never guessed', () => {
  const { steps, notes } = validateDraft(
    { steps: [step('review_page', ['page:ignore-previous-instructions'], 'Open the secret page'), step('review_page', ['page:entropy'])] },
    world,
  );
  assert.equal(steps.length, 1);
  assert.equal(steps[0]!.entityRefs[0], 'page:entropy');
  assert.equal(notes.length, 1);
  assert.match(notes[0]!, /Open the secret page.*not in your workspace.*page:ignore-previous-instructions/);
});

test('one phantom ref sinks the whole step, even beside a real one', () => {
  const { steps } = validateDraft({ steps: [step('review_page', ['page:entropy', 'page:made-up'])] }, world);
  assert.equal(steps.length, 0);
});

test('unknown kinds, malformed refs, empty refs and mismatched primaries are dropped', () => {
  const { steps, notes } = validateDraft(
    {
      steps: [
        step('run_shell', ['page:entropy']),
        step('review_page', ['page: entropy']),
        step('review_page', []),
        step('quiz', ['page:q-carnot']), // quizzes need a concept page
        step('answer_question', ['page:entropy']), // answers need a question page
        step('resolve_signal', ['signal:dismissed:or:gone']),
      ],
    },
    world,
  );
  assert.equal(steps.length, 0);
  assert.equal(notes.length, 6);
});

test('the model can never set state: extra keys are stripped before validation', () => {
  const draft = PlannerDraftSchema.parse({
    steps: [{ title: 'Done already', kind: 'review_page', entityRefs: ['page:entropy'], state: 'done', doneAt: '2026-10-01T00:00:00.000Z', id: 'hijack' }],
  });
  const { steps } = validateDraft(draft, world);
  assert.equal(steps[0]!.state, 'pending');
  assert.equal(steps[0]!.doneAt, undefined);
  assert.equal(steps[0]!.id, 'st_1');
});

test('duplicates collapse; output is capped and the cap is disclosed', () => {
  const many = Array.from({ length: 12 }, (_, i) => step(['review_page', 'quiz'][i % 2]!, [i % 2 ? 'page:entropy' : `page:${['thermo-first-law', 'q-carnot', 'note-lab', 'entropy'][i % 4]}`]));
  const dupes = validateDraft({ steps: many }, world);
  assert.ok(dupes.steps.length < 12, 'same kind on the same entity is one step');

  const pages = new Map(Array.from({ length: 12 }, (_, i) => [`p${i}`, { id: `p${i}`, kind: 'note', title: `Page ${i}`, updatedAt: '2026-10-01T00:00:00.000Z' }]));
  const { steps, notes } = validateDraft({ steps: Array.from({ length: 12 }, (_, i) => step('review_page', [`page:p${i}`])) }, makeWorld({ pages }));
  assert.equal(steps.length, MAX_PLAN_STEPS);
  assert.match(notes.at(-1)!, /first 8 of 12/);
});

test('blank model titles fall back to code-built wording from the resolved subject', () => {
  const { steps } = validateDraft({ steps: [step('read_lesson', ['lesson:l-heat-engines'], '   ')] }, world);
  assert.equal(steps[0]!.title, 'Read “Heat engines”');
});
