import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { WikiClaim } from '@sef/shared';
import { currentClaims, decideClaimMerge, planClaimMerges } from './merge-policy';

const CITATION = {
  sourceId: 'src_notes',
  sourceRevision: 'r1',
  sha256: 'a'.repeat(64),
  locator: { kind: 'text' as const, start: 0, end: 12 },
};

const claim = (over: Partial<WikiClaim> & Pick<WikiClaim, 'id' | 'text'>): WikiClaim => ({
  kind: 'source_fact',
  origin: 'student',
  status: 'current',
  citations: [CITATION],
  supersedes: [],
  ...over,
});

const candidate = (over: Partial<MergeIn> = {}) => ({
  id: 'cand_new',
  text: 'a new statement about tides',
  kind: 'source_fact' as const,
  origin: 'model' as const,
  citations: [CITATION],
  ...over,
});
type MergeIn = Parameters<typeof decideClaimMerge>[0]['candidate'];

test('a new supported claim is added', () => {
  const decision = decideClaimMerge({ candidate: candidate(), existing: [] });
  assert.equal(decision.disposition, 'add');
});

test('an unsupported fact is refused, whatever the text says', () => {
  const decision = decideClaimMerge({ candidate: candidate({ citations: [] }), existing: [] });
  assert.equal(decision.disposition, 'reject_unsupported');
  assert.match(decision.reason, /needs a source/);
});

test('a question or deduction needs no citation to be added', () => {
  assert.equal(decideClaimMerge({ candidate: candidate({ kind: 'question', citations: [] }), existing: [] }).disposition, 'add');
  assert.equal(decideClaimMerge({ candidate: candidate({ kind: 'deduction', citations: [] }), existing: [] }).disposition, 'add');
});

test('saying the same thing twice is a duplicate, not a second claim', () => {
  const existing = [claim({ id: 'a', text: 'Tides are caused by gravity.' })];
  const decision = decideClaimMerge({ candidate: candidate({ text: 'tides are caused by  gravity' }), existing });
  assert.equal(decision.disposition, 'duplicate');
  assert.equal(decision.supersedes, 'a');
});

test('a restatement with more evidence supersedes rather than duplicating', () => {
  const existing = [claim({ id: 'a', text: 'Tides are caused by gravity.' })];
  const decision = decideClaimMerge({
    candidate: candidate({ text: 'Tides are caused by gravity.', citations: [CITATION, CITATION] }),
    existing,
  });
  assert.equal(decision.disposition, 'supersede');
  assert.equal(decision.supersedes, 'a');
});

test('a restatement with no more evidence stays a duplicate', () => {
  const existing = [claim({ id: 'a', text: 'Tides are caused by gravity.', citations: [CITATION, CITATION] })];
  const decision = decideClaimMerge({ candidate: candidate({ text: 'Tides are caused by gravity.' }), existing });
  assert.equal(decision.disposition, 'duplicate');
});

test('a claim that contradicts an existing one is disputed and both are kept', () => {
  const existing = [claim({ id: 'a', text: 'The Moon makes the tides.' })];
  const decision = decideClaimMerge({ candidate: candidate({ text: 'The Sun makes all of the tides.' }), existing });
  assert.equal(decision.disposition, 'dispute');
  assert.equal(decision.supersedes, 'a');
  assert.match(decision.reason, /does not match/);
});

test('claims that are already retired do not block an equivalent new claim', () => {
  const existing = [claim({ id: 'a', text: 'The Moon makes the tides.', status: 'superseded' })];
  const decision = decideClaimMerge({ candidate: candidate({ text: 'The Moon makes the tides.' }), existing });
  assert.equal(decision.disposition, 'add', 'a retired claim should not resurrect as a duplicate');
});

test('planning is pure: the caller\'s claims are never mutated', () => {
  const existing = [claim({ id: 'a', text: 'The Moon makes the tides.' })];
  const snapshot = structuredClone(existing);
  planClaimMerges([candidate({ id: 'c1', text: 'The Sun makes all of the tides.' })], existing);
  assert.deepEqual(existing, snapshot);
});

test('planning retires a superseded claim for the next candidate to see', () => {
  const existing = [claim({ id: 'a', text: 'The Moon makes the tides.' })];
  const plan = planClaimMerges(
    [
      candidate({ id: 'c1', text: 'The Moon makes the tides.' }), // duplicate
      candidate({ id: 'c2', text: 'The Sun makes the tides.' }), // dispute
      candidate({ id: 'c3', text: 'Spring tides occur at new and full moons.' }), // add
    ],
    existing,
  );
  assert.deepEqual(plan.map((p) => p.decision.disposition), ['duplicate', 'dispute', 'add']);
  assert.equal(plan[0]!.decision.supersedes, 'a');
  assert.equal(plan[1]!.decision.supersedes, 'a');
});

test('one unsupported candidate does not stop the others being planned', () => {
  const plan = planClaimMerges(
    [candidate({ id: 'bad', text: 'Unsupported.', citations: [] }), candidate({ id: 'good', text: 'Tides relate to the moon.' })],
    [],
  );
  assert.equal(plan[0]!.decision.disposition, 'reject_unsupported');
  assert.equal(plan[1]!.decision.disposition, 'add');
});

test('a claim already retired is not retired twice', () => {
  const existing = [claim({ id: 'a', text: 'The Moon makes the tides.' })];
  const plan = planClaimMerges(
    [
      candidate({ id: 'c1', text: 'The Sun makes the tides.' }),
      candidate({ id: 'c2', text: 'Only the Sun makes the tides.' }),
    ],
    existing,
  );
  // The first disputes `a`; the second then sees `a` as no longer current and must add.
  assert.equal(plan[0]!.decision.disposition, 'dispute');
  assert.equal(plan[1]!.decision.disposition, 'add');
  assert.equal(existing[0]!.status, 'current', 'the original page is untouched');
});

test('claims sharing only one content word are not called conflicts', () => {
  // A deliberate false negative: this is a cheap deterministic pre-filter, not a semantic
  // contradiction detector. "tides" alone is too weak a signal to accuse two claims of
  // disagreeing, and flagging them would bury the student in noise.
  const existing = [claim({ id: 'a', text: 'The Moon makes the tides.' })];
  const decision = decideClaimMerge({ candidate: candidate({ text: 'Tides fall fastest through a narrow channel.' }), existing });
  assert.equal(decision.disposition, 'add');
});

test('currentClaims reports only what is still standing', () => {
  const claims = [
    claim({ id: 'a', text: 'alpha' }),
    claim({ id: 'b', text: 'beta', status: 'superseded' }),
    claim({ id: 'c', text: 'gamma', status: 'disputed' }),
    claim({ id: 'd', text: 'delta' }),
  ];
  assert.deepEqual(currentClaims(claims).map((c) => c.id), ['a', 'd']);
});
