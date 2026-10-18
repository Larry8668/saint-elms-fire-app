import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { LearningEvent, MaintenanceFinding, WikiDispute } from '@sef/shared';
import { buildDisagreements, buildStory, claimSourceIds, dayLabel, groupByDay, modalityOf, readingOf, sourceNumbers } from './story';

let seq = 0;
const event = (over: Partial<LearningEvent> & Pick<LearningEvent, 'pageId' | 'at' | 'kind'>, sourceId?: string): LearningEvent =>
  ({
    schemaVersion: 1,
    id: `evt_${++seq}`,
    profile: { studentId: 's', programmeId: 'p' },
    actor: 'model',
    knowledgeOnly: true,
    evidence: [{ kind: 'revision', ref: 'rev-x' }, ...(sourceId ? [{ kind: 'source' as const, ref: sourceId, revision: 'rev-1' }] : [])],
    ...over,
  }) as LearningEvent;

const titles: Record<string, string> = { momentum: 'Momentum', collisions: 'Collisions', coriolis: 'Coriolis force', frames: 'Rotating frames', impulse: 'Impulse', energy: 'Energy', work: 'Work', synth: 'Momentum meets collisions' };
const sources = [
  { id: 'src-memo', kind: 'audio' as const, mediaType: 'audio/wav' },
  { id: 'src-lecture', kind: 'video' as const, mediaType: 'video/mp4' },
  { id: 'src-peer', kind: 'peer' as const, mediaType: 'text/markdown' },
];
const T1 = '2026-10-18T09:00:00.000Z';
const T2 = '2026-10-18T10:00:00.000Z';
const T3 = '2026-10-18T11:00:00.000Z';
const T4 = '2026-10-18T12:00:00.000Z';

test('one commit from one source reads as one sentence: new pages and changed ones', () => {
  const events = [
    event({ pageId: 'energy', at: T1, kind: 'encounter' }),
    event({ pageId: 'work', at: T1, kind: 'encounter' }),
    event({ pageId: 'impulse', at: T1, kind: 'encounter' }),
    // The memo commit: two pages new, three already there.
    event({ pageId: 'momentum', at: T2, kind: 'encounter', actor: 'student', knowledgeOnly: false }, 'src-memo'),
    event({ pageId: 'collisions', at: T2, kind: 'encounter', actor: 'student', knowledgeOnly: false }, 'src-memo'),
    event({ pageId: 'energy', at: T2, kind: 'explanation', actor: 'student', knowledgeOnly: false }, 'src-memo'),
    event({ pageId: 'work', at: T2, kind: 'encounter' }, 'src-memo'),
    event({ pageId: 'impulse', at: T2, kind: 'struggle' }, 'src-memo'),
    event({ pageId: 'impulse', at: T2, kind: 'encounter' }, 'src-memo'),
  ];
  const story = buildStory({ events, sources, titleOf: (id) => titles[id] });
  const memo = story.find((e) => e.modality === 'voice')!;
  assert.equal(memo.sentence, 'A voice memo became 2 new pages and changed 3');
  assert.deepEqual(memo.pages.filter((p) => p.created).map((p) => p.title), ['Momentum', 'Collisions']);
  assert.equal(memo.yours, true);
  assert.equal(story[0], memo, 'newest first');
});

test('a lecture video that writes a synthesis names the two pages it links', () => {
  const events = [
    event({ pageId: 'synth', at: T3, kind: 'application' }, 'src-lecture'),
    event({ pageId: 'synth', at: T3, kind: 'connection', note: '→ momentum' }, 'src-lecture'),
    event({ pageId: 'synth', at: T3, kind: 'connection', note: '→ collisions' }, 'src-lecture'),
  ];
  const [entry] = buildStory({ events, sources, titleOf: (id) => titles[id], kindOf: (id) => (id === 'synth' ? 'synthesis' : 'concept') });
  assert.equal(entry!.sentence, 'A lecture video added a synthesis linking Momentum to Collisions');
  assert.equal(entry!.modality, 'video');
  assert.deepEqual(entry!.pages.map((p) => p.id), ['synth', 'momentum', 'collisions']);

  // A commit that also disputes an older claim still reads as one line: its suggested links
  // carry no source and the dispute cites older material, but the proposal's source wins.
  const mixed = [
    event({ pageId: 'momentum', at: T1, kind: 'encounter' }, 'src-memo'),
    event({ pageId: 'synth', at: T3, kind: 'application' }, 'src-lecture'),
    event({ pageId: 'synth', at: T3, kind: 'connection', note: '→ momentum' }),
    event({ pageId: 'synth', at: T3, kind: 'connection', note: '→ collisions' }),
    event({ pageId: 'momentum', at: T3, kind: 'correction', evidence: [{ kind: 'revision', ref: 'r' }, { sourceId: 'src-memo', sourceRevision: 'rev-1', sha256: 'a'.repeat(64), locator: { kind: 'text', start: 0, end: 3 } }] }),
    event({ pageId: 'momentum', at: T3, kind: 'encounter' }, 'src-lecture'),
  ];
  const story = buildStory({ events: mixed, sources, titleOf: (id) => titles[id], kindOf: (id) => (id === 'synth' ? 'synthesis' : 'concept') });
  assert.equal(story[0]!.sentence, 'A lecture video added a synthesis linking Momentum to Collisions and changed 1 page');
  assert.equal(story.length, 2);
});

test('a link the student made, a quiz review and a peer import each read as their own line', () => {
  const events = [
    event({ pageId: 'coriolis', at: T1, kind: 'encounter' }),
    event({ pageId: 'coriolis', at: T2, kind: 'connection', actor: 'student', knowledgeOnly: false, note: '→ frames' }),
    event({ pageId: 'coriolis', at: T3, kind: 'review', actor: 'student', knowledgeOnly: false, evidence: [{ kind: 'artifact', ref: 'res_1' }, { kind: 'revision', ref: 'rev-y' }] }),
    event({ pageId: 'impulse', at: T4, kind: 'encounter', actor: 'peer' }, 'src-peer'),
  ];
  const sentences = buildStory({ events, sources, titleOf: (id) => titles[id] }).map((e) => e.sentence);
  assert.deepEqual(sentences, ["A peer's page was imported", 'You checked Coriolis force with a quiz', 'You linked Coriolis force to Rotating frames', 'The keeper became a new page']);
});

test('the older log joins in, but course progress is not brain growth', () => {
  const story = buildStory({
    events: [],
    log: [
      { at: '2026-10-17 03:28:20', kind: 'quiz', title: 'Quiz on Band gap', detail: 'Scored 2/3.' },
      { at: '2026-10-16 06:28:25', kind: 'lesson', title: 'Started Differential Equations' },
      { at: '2026-10-16 05:00:00', kind: 'wiki', title: 'Wiki update from proposal prop-1' },
      { at: '2026-10-16 04:00:00', kind: 'source', title: 'Frozen source: Voice memo' },
      { at: '2026-10-15 04:00:00', kind: 'wiki', title: 'Restored momentum from revision rev-1' },
    ],
    sources,
    titleOf: () => undefined,
  });
  assert.deepEqual(story.map((e) => e.sentence), ['Quiz on Band gap: scored 2/3', 'Restored momentum from revision rev-1'], 'commit and intake lines are told by the ledger instead');
  assert.equal(story[0]!.at, '2026-10-17T03:28:20.000Z', 'log.md time is UTC');
});

test('modalities and readings are named honestly', () => {
  assert.equal(modalityOf({ kind: 'image', mediaType: 'image/png' }), 'photo');
  assert.equal(modalityOf({ kind: 'audio', mediaType: 'audio/wav', origin: 'external' }), 'recording');
  assert.equal(modalityOf({ kind: 'document', mediaType: 'application/pdf' }), 'pdf');
  assert.equal(modalityOf({ kind: 'session', mediaType: 'text/markdown' }), 'chat');
  assert.equal(readingOf([{ method: 'vision' }]).label, 'read by Gemma · vision');
  assert.equal(readingOf([{ method: 'audio' }, { method: 'student_correction' }]).label, 'read by Gemma · audio, corrected by you');
  assert.equal(readingOf([{ method: 'pdf' }]).byModel, false, 'a PDF text layer is not a model reading');
  assert.equal(readingOf([{ method: 'text' }]).label, 'kept as written · text');
  assert.equal(readingOf([]).label, 'not read yet');
});

test('days group under Today, Yesterday and a date', () => {
  const now = new Date('2026-10-18T15:00:00');
  assert.equal(dayLabel('2026-10-18T09:00:00', now), 'Today');
  assert.equal(dayLabel('2026-10-17T23:00:00', now), 'Yesterday');
  assert.match(dayLabel('2025-10-02T09:00:00', now), /2025/);
  const groups = groupByDay([{ at: '2026-10-18T10:00:00' }, { at: '2026-10-18T09:00:00' }, { at: '2026-10-17T09:00:00' }], now);
  assert.deepEqual(groups.map((g) => [g.label, g.entries.length]), [['Today', 2], ['Yesterday', 1]]);
});

test('sources are numbered once each and a claim names the ones it cites', () => {
  const numbers = sourceNumbers(['a', 'b', 'a', 'c']);
  assert.deepEqual([...numbers], [['a', 1], ['b', 2], ['c', 3]]);
  assert.deepEqual(claimSourceIds({ citations: [{ sourceId: 'b' }, { sourceId: 'b' }, { sourceId: 'a' }] }), ['b', 'a']);
});

test('disagreements: disputes first, a flagged contradiction once, misconceptions last', () => {
  const side = (claimId: string | undefined, text: string, origin: WikiDispute['sides'][number]['origin']) => ({ ...(claimId ? { claimId } : {}), text, origin, sources: [], missingSourceIds: [] });
  const disputes: WikiDispute[] = [
    { id: 'm', kind: 'misconception', pageId: 'band-gap', pageTitle: 'Band gap', pageKind: 'concept', at: null, sides: [side(undefined, 'Collisions', 'student'), side(undefined, 'Bragg reflection', 'course')], prompt: 'p1' },
    { id: 'd', kind: 'disputed_claims', pageId: 'free-fall', pageTitle: 'Free fall', pageKind: 'concept', at: T1, sides: [side('c1', 'Heavier falls faster', 'external'), side('c2', 'Same rate', 'student')], prompt: 'p2' },
  ];
  const contradiction = (id: string, claimId: string): MaintenanceFinding => ({
    id,
    origin: 'semantic',
    kind: 'contradiction',
    pageIds: ['free-fall', 'drag'],
    title: 'These disagree',
    detail: 'One says x, one says y.',
    evidence: [
      { pageId: 'free-fall', claimId, note: 'Same rate' },
      { pageId: 'drag', claimId: 'c9', note: 'Drag changes everything' },
    ],
    action: { kind: 'suggestion' },
    revisions: {},
    prompt: 'p3',
  });
  const list = buildDisagreements(disputes, [contradiction('f1', 'c2'), { ...contradiction('f2', 'c2'), kind: 'orphan' }], (id) => ({ 'free-fall': 'Free fall', drag: 'Drag' })[id]);
  assert.deepEqual(list.map((d) => d.state), ['disputed', 'flagged', 'misconception']);
  assert.deepEqual(list[0]!.sides.map((s) => s.label), ['Earlier · an outside source says', 'Later · in your words']);
  assert.equal(list[1]!.pageTitle, 'Free fall · Drag');
  assert.deepEqual(list[2]!.sides.map((s) => s.label), ['You wrote', 'The course says']);
  const both = buildDisagreements([{ ...disputes[1]!, sides: [side('c1', 'a', 'external'), side('c2', 'b', 'student')] }], [{ ...contradiction('f1', 'c2'), evidence: [{ pageId: 'free-fall', claimId: 'c1', note: 'a' }, { pageId: 'free-fall', claimId: 'c2', note: 'b' }] }], () => undefined);
  assert.equal(both.length, 1, 'a flagged contradiction already marked on the page shows once');
});
