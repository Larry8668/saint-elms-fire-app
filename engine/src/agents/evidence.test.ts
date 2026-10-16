import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { SourceRef, WikiClaim } from '@sef/shared';
import type { ClaimVerdict } from '../brain/claim-evidence';
import { queryTerms } from '../content/search';
import { buildEvidenceSet, parseCitations, type EvidenceSet } from './evidence';
import { assessAnswer, classifySegment, splitAnswerSegments, UNSUPPORTED_ANSWER } from './validators';

const sources: SourceRef[] = [
  { kind: 'lesson', id: 'damped', title: 'Damped Oscillations' },
  { kind: 'support', id: 'fees', title: 'Fees and Deadlines' },
  { kind: 'web', id: 'https://example.com/resonance', title: 'Resonance in bridges', url: 'https://example.com/resonance' },
  { kind: 'brain', id: 'energy', title: 'Energy' },
];

const evidenceText = new Map([
  ['lesson:damped', 'Damped Oscillations\nA damped oscillator loses amplitude over time as friction drains its energy.'],
  ['support:fees', 'Fees and Deadlines\nFees are due in week 6 of the semester.'],
  ['web:https://example.com/resonance', 'Resonance in bridges\nTacoma Narrows collapsed under aeroelastic flutter in 1940.'],
  ['brain:energy', 'Energy\nI think energy is always conserved, no exceptions.'],
]);

const claim = (over: Partial<WikiClaim> & Pick<WikiClaim, 'id' | 'text'>): WikiClaim =>
  ({
    kind: 'source_fact',
    origin: 'course',
    status: 'current',
    citations: [{ sourceId: 'src-1', sourceRevision: 'r1', sha256: 'a'.repeat(64), locator: { kind: 'text', start: 0, end: 10 } }],
    supersedes: [],
    ...over,
  }) as WikiClaim;

const claimVerdicts: ClaimVerdict[] = [
  { claim: claim({ id: 'c-1', text: 'Damping lowers the resonant frequency' }), assertable: true, sources: ['src-1'] },
  { claim: claim({ id: 'c-2', text: 'The registrar confirmed a fee waiver', citations: [] }), assertable: false, reason: 'uncited', sources: [] },
];

function evidence(extra: { foreignIds?: string[] } = {}): EvidenceSet {
  return buildEvidenceSet({
    sources,
    evidenceText,
    claimVerdicts,
    contextBlocks: ['STUDENT BRAIN:\n- Energy [shaky]: I think energy is always conserved, no exceptions.'],
    shieldedBlocks: ['WIKI CLAIMS:\n- [cited: src-1] Damping lowers the resonant frequency\nCLAIMS YOU MAY NOT ASSERT:\n- [not assertable: uncited] The registrar confirmed a fee waiver'],
    foreignIds: extra.foreignIds ?? ['torsion-pendulum'],
  });
}

const terms = (text: string) => new Set(queryTerms(text));

const resolve = (ev: EvidenceSet, declared: string, id: string | undefined, text = 'damping friction drains energy amplitude over time') =>
  ev.resolve({ raw: id === undefined ? `[${declared}]` : `[${declared}: ${id}]`, declared, id }, terms(text), 3);

test('citation parsing finds declared classes and ignores markdown links and unknown brackets', () => {
  const parsed = parseCitations('As the lesson shows [lesson: damped] and [course], plus [a link](https://x) and [note].');
  assert.deepEqual(
    parsed.map((c) => `${c.declared}:${c.id ?? ''}`),
    ['lesson:damped', 'course:'],
  );
});

test('a citation to a permitted lesson resolves', () => {
  const c = resolve(evidence(), 'lesson', 'damped');
  assert.equal(c.verdict, 'cited');
  assert.equal(c.item?.id, 'damped');
});

test('a citation naming a source that does not exist is forged', () => {
  assert.equal(resolve(evidence(), 'lesson', 'quantum-gravity-notes').verdict, 'forged');
});

test('a citation naming a real source outside this turn’s evidence is wrong-owner', () => {
  assert.equal(resolve(evidence(), 'lesson', 'torsion-pendulum').verdict, 'wrong_owner');
});

test('a citation under the wrong class fails — a lesson is not a web result', () => {
  const c = resolve(evidence(), 'web', 'damped');
  assert.equal(c.verdict, 'wrong_class');
  assert.equal(c.item?.id, 'damped');
});

test('a web citation resolves by result number as well as url', () => {
  assert.equal(resolve(evidence(), 'web', '1').verdict, 'attributed', 'a real result cited without measured support is attributed, not forged');
  assert.equal(resolve(evidence(), 'web', 'https://example.com/resonance', 'aeroelastic flutter collapsed tacoma narrows').verdict, 'cited');
});

test('a citation to a withheld claim is withheld, and declaring it withheld is allowed', () => {
  assert.equal(resolve(evidence(), 'cited', 'c-2').verdict, 'withheld');
  assert.equal(resolve(evidence(), 'withheld', 'c-2').verdict, 'withheld');
  assert.equal(resolve(evidence(), 'withheld', 'c-1').verdict, 'wrong_class', 'declaring withheld on assertable evidence is a class violation');
});

test('a bare [web] tag with no web evidence is forged; with support it resolves', () => {
  const noWeb = buildEvidenceSet({ sources: sources.filter((s) => s.kind !== 'web'), evidenceText });
  assert.equal(noWeb.resolve({ raw: '[web]', declared: 'web' }, terms('flutter collapsed the bridge'), 3).verdict, 'forged');
  assert.equal(resolve(evidence(), 'web', undefined, 'aeroelastic flutter collapsed tacoma narrows').verdict, 'cited');
});

test('a bare tag backed only by another class is wrong-class, not re-labelled', () => {
  assert.equal(resolve(evidence(), 'web', undefined, 'damping friction drains energy amplitude').verdict, 'wrong_class');
  assert.equal(resolve(evidence(), 'course', undefined, 'nothing overlaps here at all').verdict, 'unsupported');
});

test('segments split on sentence boundaries without breaking inline maths or abbreviations', () => {
  const segments = splitAnswerSegments('The force is $F = m.a$ in this case. It is e.g. damping. What next?');
  assert.deepEqual(
    segments.map((s) => s.text),
    ['The force is $F = m.a$ in this case.', 'It is e.g. damping.', 'What next?'],
  );
});

test('segment kinds separate facts, beliefs, deductions, uncertainty and questions', () => {
  assert.equal(classifySegment('A damped oscillator loses amplitude over time.'), 'fact');
  assert.equal(classifySegment('You wrote in your notes that energy is always conserved.'), 'belief');
  assert.equal(classifySegment('Therefore the amplitude decays exponentially.'), 'deduction');
  assert.equal(classifySegment("That isn't covered by your released lessons."), 'uncertainty');
  assert.equal(classifySegment('What do you think happens next?'), 'question');
  assert.equal(classifySegment('Trailhead: where else does resonance show up?'), 'question');
  assert.equal(classifySegment('Here we go.'), 'other');
});

test('a supported fact is served; an unsupported one is withheld before display', () => {
  const assessed = assessAnswer(
    'A damped oscillator loses amplitude over time as friction drains its energy. The moon is made of green cheese.',
    'why does amplitude decay?',
    evidence(),
    { teacher: 'guide' },
  );
  assert.match(assessed.text, /damped oscillator loses amplitude/);
  assert.doesNotMatch(assessed.text, /green cheese/, 'the unsupported statement was withheld');
  assert.equal(assessed.withheld, 1);
  assert.equal(assessed.checks.find((c) => c.id === 'evidence')?.passed, false);
});

test('a forged citation marker never displays and always fails the check', () => {
  const assessed = assessAnswer(
    'A damped oscillator loses amplitude over time as friction drains its energy. [lesson: quantum-gravity-notes]',
    'why does amplitude decay?',
    evidence(),
    { teacher: 'guide' },
  );
  assert.doesNotMatch(assessed.text, /quantum-gravity|\[lesson:/, 'the forged marker is not display text');
  assert.match(assessed.text, /damped oscillator/, 'the statement stands on its own measured support');
  assert.equal(assessed.checks.find((c) => c.id === 'citations')?.passed, false);
});

test('a statement resting on a forged citation is withheld', () => {
  const assessed = assessAnswer('As [lesson: quantum-gravity-notes] proves, gravitons oscillate weekly.', 'damping?', evidence(), { teacher: 'guide' });
  assert.doesNotMatch(assessed.text, /gravitons|quantum-gravity/);
  assert.equal(assessed.withheld, 1);
});

test('a verified citation marker is stripped from the served text and the source recorded', () => {
  const assessed = assessAnswer(
    'A damped oscillator loses amplitude over time as friction drains its energy. [lesson: damped]',
    'why does amplitude decay?',
    evidence(),
    { teacher: 'guide' },
  );
  assert.doesNotMatch(assessed.text, /\[lesson:/, 'the citation marker is not display text');
  assert.match(assessed.text, /damped oscillator loses amplitude/);
  assert.deepEqual(assessed.segments.find((s) => s.kind === 'fact')?.sources, ['damped']);
  assert.equal(assessed.checks.find((c) => c.id === 'citations')?.passed, true);
});

test('a fabricated student belief is withheld; one the brain backs is served', () => {
  const assessed = assessAnswer(
    'You wrote in your notes that energy is always conserved, no exceptions. You told me you love quadratic reciprocity.',
    'where am I stuck?',
    evidence(),
    { teacher: 'guide' },
  );
  assert.match(assessed.text, /energy is always conserved/);
  assert.doesNotMatch(assessed.text, /quadratic reciprocity/, 'the invented belief was withheld');
  assert.equal(assessed.segments.find((s) => s.kind === 'belief')?.support, 'supported');
});

test('an honest "not covered" answer needs no evidence and is served whole', () => {
  const assessed = assessAnswer("That isn't covered by your released lessons. Want me to search for something else?", 'what is quantum gravity?', evidence(), { teacher: 'guide' });
  assert.equal(assessed.withheld, 0);
  assert.match(assessed.text, /isn't covered/);
  assert.equal(assessed.checks.find((c) => c.id === 'evidence')?.passed, true);
});

test('when nothing claim-bearing can be backed, the answer declines honestly', () => {
  const assessed = assessAnswer('Quantum gravity unifies all four forces. It predicts graviton oscillations.', 'explain quantum gravity', evidence(), { teacher: 'guide' });
  assert.equal(assessed.text, UNSUPPORTED_ANSWER.guide);
  assert.ok(assessed.withheld >= 2);
});

test('the Philosopher keeps verified tags and withholds claims that carry none', () => {
  const assessed = assessAnswer(
    '[web] Tacoma Narrows collapsed under aeroelastic flutter in 1940.\nA bare claim with no tag at all.\n\nTrailhead: where else does resonance appear?',
    'where does resonance appear?',
    evidence(),
    { teacher: 'philosopher' },
  );
  assert.match(assessed.text, /\[web\] Tacoma Narrows/);
  assert.doesNotMatch(assessed.text, /no tag at all/, 'the untagged claim was withheld, not re-labelled');
  assert.equal(assessed.checks.find((c) => c.id === 'tagged-lines')?.passed, false);
  assert.equal(assessed.checks.find((c) => c.id === 'one-trailhead')?.passed, true);
});

test('a withheld claim cannot launder into a fact through the claims context block', () => {
  const assessed = assessAnswer(
    'The registrar confirmed a fee waiver for every student. Fees are due in week 6 of the semester.',
    'do I still owe fees?',
    evidence(),
    { teacher: 'friend' },
  );
  assert.doesNotMatch(assessed.text, /fee waiver/, 'repeating a withheld claim as fact is withheld');
  assert.match(assessed.text, /week 6/);
});

test('a withheld claim may still be named honestly, never asserted', () => {
  const assessed = assessAnswer(
    'You have a claim in your wiki that the registrar confirmed a fee waiver [withheld: c-2], but nothing released backs it.',
    'what did my wiki claim?',
    evidence(),
    { teacher: 'friend' },
  );
  assert.match(assessed.text, /fee waiver/, 'naming the claim as withheld is allowed');
  assert.doesNotMatch(assessed.text, /\[withheld:/, 'the marker itself is not display text');
});

test('a philosopher line tagged [web] over course-only evidence is withheld as wrong-class', () => {
  const assessed = assessAnswer(
    '[web] A damped oscillator loses amplitude as friction drains its energy.\n\nTrailhead: what breaks next?',
    'damping?',
    evidence(),
    { teacher: 'philosopher' },
  );
  assert.doesNotMatch(assessed.text, /damped oscillator/, 'the [web] tag was not quietly re-labelled [course]');
  assert.match(assessed.checks.find((c) => c.id === 'citations')?.detail ?? '', /wrong class/);
});
