import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { Evidence, Misconception } from '@sef/shared';
import { computeStatus } from './mastery';

const quiz = (score: number, at: string): Evidence => ({ kind: 'quiz', ref: `q-${at}`, at, score, outOf: 5 });
const open: Misconception = { claim: 'damping raises frequency', course: 'damping lowers it', flagged: '2026-10-14', resolved: false };

test('no page is unseen', () => {
  assert.equal(computeStatus(null), 'unseen');
});

test('a page with only session evidence is met', () => {
  assert.equal(computeStatus({ evidence: [{ kind: 'session', ref: 's1', at: '2026-10-14' }], misconceptions: [] }), 'met');
});

test('an unresolved misconception makes a concept shaky even with good quizzes', () => {
  assert.equal(computeStatus({ evidence: [quiz(5, '1'), quiz(5, '2')], misconceptions: [open] }), 'shaky');
});

test('a failing latest quiz makes a concept shaky', () => {
  assert.equal(computeStatus({ evidence: [quiz(5, '1'), quiz(2, '2')], misconceptions: [] }), 'shaky');
});

test('two passing quizzes in a row make a concept solid', () => {
  assert.equal(computeStatus({ evidence: [quiz(2, '1'), quiz(4, '2'), quiz(5, '3')], misconceptions: [] }), 'solid');
});

test('one passing quiz is not yet solid', () => {
  assert.equal(computeStatus({ evidence: [quiz(5, '1')], misconceptions: [{ ...open, resolved: true }] }), 'met');
});

test('the same attempt retried or re-imported never stacks as extra evidence', () => {
  const once = { kind: 'quiz' as const, ref: 'q-1', at: '2026-10-01', score: 5, outOf: 5 };
  assert.equal(computeStatus({ evidence: [once, { ...once }, { ...once }], misconceptions: [] }), 'met', 'three copies of one pass are still one check');
});

test('two passes on the same quiz count once — solid needs two different checks', () => {
  const evidence = [
    { kind: 'quiz' as const, ref: 'q-1', at: '2026-10-01', score: 4, outOf: 5 },
    { kind: 'quiz' as const, ref: 'q-1', at: '2026-10-03', score: 5, outOf: 5 },
  ];
  assert.equal(computeStatus({ evidence, misconceptions: [] }), 'met');
});

test('a retake replaces the earlier attempt — a failed redo turns a pass shaky', () => {
  const evidence = [
    { kind: 'quiz' as const, ref: 'q-1', at: '2026-10-01', score: 5, outOf: 5 },
    { kind: 'quiz' as const, ref: 'q-1', at: '2026-10-03', score: 1, outOf: 5 },
  ];
  assert.equal(computeStatus({ evidence, misconceptions: [] }), 'shaky');
});
