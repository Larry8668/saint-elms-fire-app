import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { WikiAskResult } from '@sef/shared';
import { answerParts, askReducer, highlightedPageIds, initialAsk, splitFrames } from './ask-brain';

const result = (over: Partial<WikiAskResult> = {}): WikiAskResult => ({
  schemaVersion: 2,
  askId: 'ask-1',
  question: 'How does the band gap decide conduction?',
  answer: 'Small gaps conduct [[band-gap]].',
  outcome: 'answered',
  citations: [{ pageId: 'band-gap', title: 'Band gap', kind: 'concept', generated: false }],
  droppedCitations: [],
  pagesSearched: 4,
  pagesRead: [
    { pageId: 'band-gap', title: 'Band gap', kind: 'concept', generated: false },
    { pageId: 'doping', title: 'Doping', kind: 'concept', generated: false },
  ],
  searchMode: 'hybrid',
  model: 'fake',
  evidence: 'student_wiki',
  ...over,
});

test('splitFrames returns whole frames and keeps the unfinished tail', () => {
  const { frames, rest } = splitFrames('data: {"type":"status","message":"a"}\n\ndata: {"type":"delta","text":"Hi"}\n\ndata: {"type":"del');
  assert.deepEqual(frames, [
    { type: 'status', message: 'a' },
    { type: 'delta', text: 'Hi' },
  ]);
  assert.equal(rest, 'data: {"type":"del');
  assert.deepEqual(splitFrames('data: not json\n\n').frames, [], 'a malformed frame is skipped');
});

test('the reducer streams text, then the done answer replaces it; events after done are ignored', () => {
  let state = askReducer(initialAsk, { type: 'start', question: 'q' });
  assert.equal(state.phase, 'asking');
  state = askReducer(state, { type: 'event', event: { type: 'pages', pages: result().pagesRead } });
  assert.deepEqual(highlightedPageIds(state), ['band-gap', 'doping'], 'read pages light up while the answer is written');
  state = askReducer(state, { type: 'event', event: { type: 'delta', text: 'Small gaps ' } });
  state = askReducer(state, { type: 'event', event: { type: 'delta', text: 'conduct' } });
  assert.equal(state.text, 'Small gaps conduct');
  state = askReducer(state, { type: 'event', event: { type: 'done', result: result() } });
  assert.equal(state.phase, 'done');
  assert.equal(state.text, 'Small gaps conduct [[band-gap]].');
  assert.deepEqual(highlightedPageIds(state), ['band-gap'], 'then only the cited ones');
  assert.equal(askReducer(state, { type: 'event', event: { type: 'delta', text: 'late' } }), state);

  const failed = askReducer(askReducer(initialAsk, { type: 'start', question: 'q' }), { type: 'event', event: { type: 'error', message: 'down' } });
  assert.equal(failed.phase, 'error');
  assert.equal(failed.error, 'down');
});

test('answerParts numbers each cited page once and hides citations the engine did not confirm', () => {
  const parts = answerParts('A [[band-gap]] b [[doping]] c [[band-gap]] d [[ghost]].', [
    { pageId: 'band-gap', title: 'Band gap' },
    { pageId: 'doping', title: 'Doping' },
  ]);
  assert.deepEqual(
    parts.filter((p) => p.kind === 'cite').map((p) => (p.kind === 'cite' ? `${p.pageId}:${p.n}` : '')),
    ['band-gap:1', 'doping:2', 'band-gap:1'],
  );
  assert.equal(
    parts.map((p) => (p.kind === 'text' ? p.text : `(${p.n})`)).join(''),
    'A (1) b (2) c (1) d .',
  );
});
