import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { Lesson } from '@sef/shared';
import { attributeLessons, lessonSections } from './attribution';

const lesson = (id: string, title: string, markdown: string): Lesson => ({
  id,
  courseId: 'mechanics',
  courseName: 'Mechanics',
  moduleId: 'm1',
  moduleName: 'Newtonian mechanics',
  subjectId: 'physics',
  semesterNumber: 1,
  order: 1,
  title,
  concepts: [],
  prerequisites: [],
  tags: [],
  markdown,
});

const inertia = lesson(
  'inertia',
  "Newton's Laws and Inertial Frames",
  [
    '# Newton\'s Laws',
    'Intro text about the course.',
    '## First law',
    'A body continues in uniform velocity unless a net external force acts. Friction on the puck eventually slows it; without friction it would glide on ice indefinitely.',
    '```',
    '# not a heading',
    '```',
    '## Inertial frames',
    'Frames where the first law holds are inertial frames.',
  ].join('\n'),
);

const energy = lesson('energy', 'Conservation of Energy', '## Work\nWork done by a conservative field equals the loss in potential energy. Kinetic plus potential energy stays constant.');

test('lessonSections counts h1–h4 headings in order and ignores fenced code', () => {
  const sections = lessonSections(inertia.markdown);
  assert.deepEqual(
    sections.map((s) => [s.index, s.heading]),
    [
      [0, "Newton's Laws"],
      [1, 'First law'],
      [2, 'Inertial frames'],
    ],
  );
  assert.match(sections[1]!.text, /# not a heading/);
});

test('cites the lesson the answer draws on, with its best section, and not the merely retrieved one', () => {
  const question = 'Why does a moving object need a force to keep moving?';
  const answer =
    'It does not. A body keeps its uniform velocity unless a net external force acts — friction is what slows a puck gliding on ice. Remove friction and it glides indefinitely.';
  const result = attributeLessons(answer, question, [inertia, energy]);
  assert.equal(result.get('inertia')?.cited, true);
  assert.deepEqual(result.get('inertia')?.section, { heading: 'First law', index: 1 });
  assert.match(result.get('inertia')?.excerpt ?? '', /uniform velocity/);
  assert.equal(result.get('energy')?.cited, false);
});

test('naming a lesson in the answer counts as citing it', () => {
  const result = attributeLessons('As the lesson on Conservation of Energy puts it, energy is conserved.', 'what is conserved', [energy]);
  assert.equal(result.get('energy')?.cited, true);
});
