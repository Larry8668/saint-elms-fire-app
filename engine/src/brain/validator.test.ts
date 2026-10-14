import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { BrainProposal, ConceptPage, Lesson } from '@sef/shared';
import { emptyPage } from './page-format';
import { validateProposal, type ValidationContext } from './validator';

const lesson: Lesson = {
  id: 'osc-1',
  courseId: 'waves',
  courseName: 'Waves',
  moduleId: 'm1',
  moduleName: 'Oscillations',
  subjectId: 'physics',
  semesterNumber: 2,
  order: 1,
  title: 'Damped oscillations',
  concepts: ['Damping', 'Natural frequency'],
  prerequisites: [],
  tags: [],
  markdown: '',
};

function ctx(pages: ConceptPage[] = []): ValidationContext {
  return {
    allowed: new Map([
      ['damping', 'Damping'],
      ['natural-frequency', 'Natural frequency'],
    ]),
    pages: new Map(pages.map((p) => [p.key, p])),
    touchedLessons: [lesson],
    evidence: { kind: 'capture', ref: 'cap-1', at: '2026-10-14T10:00:00Z' },
  };
}

const proposal = (patch: Partial<BrainProposal>): BrainProposal => ({ pages: [], misconceptions: [], resolved: [], edges: [], ...patch });

test('creates a page with evidence for a known concept', () => {
  const { ops, rejected } = validateProposal(proposal({ pages: [{ concept: 'Damping', in_my_words: 'Energy leaks out each cycle.', where_i_got_stuck: '' }] }), ctx());
  assert.deepEqual(
    ops.map((o) => o.op),
    ['create_page', 'add_evidence', 'update_section'],
  );
  assert.equal(rejected.length, 0);
});

test('rejects concepts outside the syllabus', () => {
  const { ops, rejected } = validateProposal(proposal({ pages: [{ concept: 'Quantum gravity', in_my_words: 'Something', where_i_got_stuck: '' }] }), ctx());
  assert.equal(ops.length, 0);
  assert.match(rejected[0]!.reason, /Unknown concept/);
});

test('rejects a prerequisite edge that would close a cycle', () => {
  const damping = emptyPage('damping', 'Damping', ['osc-1'], 'now');
  damping.links.push({ to: 'natural-frequency', type: 'prerequisite', origin: 'course' });
  const { rejected } = validateProposal(
    proposal({ edges: [{ from: 'Natural frequency', to: 'Damping', type: 'requires', why: 'x', student_made: false }] }),
    ctx([damping]),
  );
  assert.match(rejected[0]!.reason, /cycle/);
});

test('normalises edge synonyms and marks student-made links', () => {
  const { ops } = validateProposal(proposal({ edges: [{ from: 'Damping', to: 'Natural frequency', type: 'related', why: 'both in SHM', student_made: true }] }), ctx());
  const link = ops.find((o) => o.op === 'add_link');
  assert.deepEqual(link && { type: link.type, origin: link.origin }, { type: 'related_to', origin: 'student' });
});

test('flags a misconception citing the released lesson', () => {
  const { ops } = validateProposal(
    proposal({ misconceptions: [{ concept: 'Damping', student_claim: 'Damping increases the frequency', course_says: 'Damping lowers the frequency' }] }),
    ctx(),
  );
  const flag = ops.find((o) => o.op === 'flag_misconception');
  assert.equal(flag && flag.lessonRef, 'osc-1');
});

test('refuses to resolve a misconception that was never flagged', () => {
  const { rejected } = validateProposal(proposal({ resolved: [{ concept: 'Damping', claim: 'anything' }] }), ctx());
  assert.match(rejected[0]!.reason, /No matching open misconception/);
});
