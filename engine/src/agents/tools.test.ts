import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { BrainService } from '../brain/service';
import type { ContentStore } from '../content/store';
import { TurnContext } from './context';
import { buildTools } from './tools';

const lessons = [
  { id: 'fees', courseId: 'support', courseName: 'Student Life', moduleId: 's1', moduleName: 'Admin', subjectId: 'admin', semesterNumber: 1, order: 1, title: 'Fees and Deadlines', concepts: [], prerequisites: [], tags: [], markdown: 'Fees are due in week 6.' },
  { id: 'damped', courseId: 'mech', courseName: 'Mechanics', moduleId: 'm1', moduleName: 'Oscillations', subjectId: 'physics', semesterNumber: 1, order: 1, title: 'Damped Oscillations', concepts: [], prerequisites: [], tags: [], markdown: 'A damped oscillator loses amplitude.' },
];

const deps = {
  content: {
    supportLessons: async () => lessons.filter((l) => l.courseId === 'support'),
    academicLessons: async () => lessons.filter((l) => l.courseId !== 'support'),
  } as unknown as ContentStore,
  brain: { page: async () => null, weakest: async () => [] } as unknown as BrainService,
  searxngUrl: 'http://searx.invalid:8888',
};

type Tool = { execute: (input: unknown) => Promise<unknown> };
const run = (teacher: Parameters<typeof buildTools>[0], ctx: TurnContext, tool: string, input: unknown) =>
  (buildTools(teacher, deps, ctx)[tool] as unknown as Tool).execute(input);

test('every tool is registered for every teacher, so a refusal is visible rather than missing', () => {
  const ctx = new TurnContext(() => {});
  for (const teacher of ['friend', 'guide', 'philosopher'] as const) {
    assert.deepEqual(Object.keys(buildTools(teacher, deps, ctx)).sort(), [
      'brain_lookup',
      'handoff',
      'read_lesson',
      'read_wiki_page',
      'search_lessons',
      'search_wiki',
      'weakest_concepts',
      'web_search',
    ]);
  }
});

test('a tool a teacher was not granted refuses and says which capability was missing', async () => {
  const ctx = new TurnContext(() => {});
  const out = (await run('philosopher', ctx, 'weakest_concepts', { limit: 3 })) as { refused: boolean; capability: string; error: string };
  assert.equal(out.refused, true);
  assert.equal(out.capability, 'tool:weakest_concepts');
  assert.match(out.error, /philosopher is not permitted/);
  assert.deepEqual(ctx.denied, ['tool:weakest_concepts']);
  assert.match(ctx.toolCalls.at(-1)?.summary ?? '', /refused/);
});

test('lesson lookup is scoped to the pool a teacher declared, not the whole store', async () => {
  const ctx = new TurnContext(() => {});
  const out = (await run('guide', ctx, 'read_lesson', { lessonId: 'fees' })) as { error: string };
  assert.match(out.error, /not found/i, 'a support lesson is outside the Guide’s pool, so it reads as absent rather than leaking');
  const inside = (await run('guide', ctx, 'read_lesson', { lessonId: 'damped' })) as { title: string };
  assert.equal(inside.title, 'Damped Oscillations');
});

test('the Friend has no lesson-reading capability at all', async () => {
  const ctx = new TurnContext(() => {});
  const out = (await run('friend', ctx, 'read_lesson', { lessonId: 'fees' })) as { refused: boolean; capability: string };
  assert.equal(out.refused, true);
  assert.equal(out.capability, 'tool:read_lesson');
});

test('the Friend has no brain access at all', async () => {
  const ctx = new TurnContext(() => {});
  const out = (await run('friend', ctx, 'brain_lookup', { concept: 'damping' })) as { refused: boolean };
  assert.equal(out.refused, true);
  assert.deepEqual(ctx.denied, ['tool:brain_lookup']);
});

test('web search needs the capability and this turn’s consent', async () => {
  const ctx = new TurnContext(() => {});
  const guide = (await run('guide', ctx, 'web_search', { query: 'anything' })) as { refused: boolean; capability: string };
  assert.equal(guide.refused, true, 'the Guide has no web capability at all');
  assert.equal(guide.capability, 'tool:web_search');

  const consenting = new TurnContext(() => {});
  const consented = buildTools('philosopher', { ...deps, webConsented: true }, consenting);
  const out = (await (consented.web_search as unknown as Tool).execute({ query: 'anything' })) as { refused?: boolean };
  assert.equal(out.refused, undefined, 'with consent the Philosopher’s web tool runs rather than refusing');
});