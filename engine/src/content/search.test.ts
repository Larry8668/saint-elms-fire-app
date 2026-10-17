import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { Lesson } from '@sef/shared';
import { lessonEmbedKey, searchLessons, searchLessonsHybrid } from './search';

const lesson = (id: string, over: Partial<Lesson> = {}): Lesson => ({
  id,
  courseId: 'phys-1',
  courseName: 'Physics I',
  moduleId: 'mod-mechanics',
  moduleName: 'Mechanics',
  subjectId: 'physics',
  semesterNumber: 1,
  order: 1,
  title: 'Momentum',
  concepts: ['Momentum'],
  prerequisites: [],
  tags: [],
  markdown: '# Momentum\n\nMomentum is mass times velocity.',
  ...over,
});

test('the keyword path alone still drives searchLessonsHybrid, honestly marked', async () => {
  const lessons = [lesson('l-momentum'), lesson('l-damping', { title: 'Damping', concepts: ['Damping'], markdown: '# Damping\n\nAmplitude decays each cycle.' })];
  const plain = searchLessons(lessons, 'momentum collisions', 3);
  const hybrid = await searchLessonsHybrid(lessons, 'momentum collisions', { limit: 3 });
  assert.equal(hybrid.searchMode, 'keyword_only', 'no lane wired means keyword-only, marked');
  assert.deepEqual(
    hybrid.hits.map((hit) => hit.lesson.id),
    plain.map((hit) => hit.lesson.id),
    'the fallback returns exactly what the keyword scorer returned',
  );
  assert.equal(hybrid.hits[0]?.match, 'keyword');
});

test('the semantic lane admits a lesson keyword scoring missed, marked both ways', async () => {
  const lessons = [
    lesson('l-momentum'),
    lesson('l-vectors', { title: 'Resolving vectors', concepts: ['Vectors'], markdown: '# Vectors\n\nA vector decomposes into components.' }),
  ];
  const embed = async () => new Map([[`${lessonEmbedKey(lessons[1]!)}`, 0.9]]);
  const found = await searchLessonsHybrid(lessons, 'momentum collisions', { limit: 3, embed });
  assert.equal(found.searchMode, 'hybrid');
  const ids = found.hits.map((hit) => [hit.lesson.id, hit.match] as const);
  assert.deepEqual(ids, [
    ['l-momentum', 'keyword'],
    ['l-vectors', 'semantic'],
  ]);
  assert.ok(found.hits[1]!.excerpt.length > 0, 'a semantic-only hit still carries a readable excerpt');

  // A lane that answers null is the same honest keyword-only result as no lane at all.
  const down = await searchLessonsHybrid(lessons, 'momentum collisions', { limit: 3, embed: async () => null });
  assert.equal(down.searchMode, 'keyword_only');
  assert.deepEqual(down.hits.map((hit) => hit.lesson.id), ['l-momentum']);
});

test('a lesson found by both lanes outranks either alone', async () => {
  const lessons = [lesson('l-momentum'), lesson('l-damping', { title: 'Damping', concepts: ['Damping'], markdown: '# Damping\n\nAmplitude decays each cycle.' })];
  const embed = async () => new Map([[lessonEmbedKey(lessons[0]!), 0.95], [lessonEmbedKey(lessons[1]!), 0.9]]);
  const found = await searchLessonsHybrid(lessons, 'momentum collisions', { limit: 3, embed });
  assert.equal(found.hits[0]?.lesson.id, 'l-momentum');
  assert.equal(found.hits[0]?.match, 'both');
});

test('lessonEmbedKey is memoised per object and re-keys on any content change', () => {
  const original = lesson('l-momentum');
  const first = lessonEmbedKey(original);
  assert.equal(lessonEmbedKey(original), first, 'same object, same key — the memoised hash is not re-derived');
  assert.match(first, /^l-momentum@[0-9a-f]{16}$/);
  const edited = lesson('l-momentum', { markdown: '# Momentum\n\nOne word changed.' });
  assert.notEqual(lessonEmbedKey(edited), first, 'a content change is a new vector, not a stale hit');
});
