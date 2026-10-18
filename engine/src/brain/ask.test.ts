import assert from 'node:assert/strict';
import { test } from 'node:test';
import { WikiAskResultSchema, type WikiAskStreamEvent } from '@sef/shared';
import {
  askWiki,
  AskStore,
  CitationStreamFilter,
  EMPTY_BRAIN_ANSWER,
  MODEL_UNAVAILABLE_ANSWER,
  NO_HITS_ANSWER,
  sanitizeAnswer,
  type AskComplete,
} from './ask';
import { conceptDraft, proposal, sourceFixture, synthesisDraft, tempRoot, vault } from './testing/fixtures';
import type { WikiStore } from './wiki-store';

async function* tokens(...parts: string[]): AsyncIterable<string> {
  for (const part of parts) yield part;
}

const fake = (parts: string[], seen: { prompt?: string; instructions?: string; calls: number } = { calls: 0 }): AskComplete => async (input) => {
  seen.calls += 1;
  seen.prompt = input.prompt;
  seen.instructions = input.instructions;
  return { label: 'fake-model · Test', text: tokens(...parts) };
};

async function seeded(prefix: string): Promise<WikiStore> {
  const store = await vault(prefix);
  const { record, bytes } = sourceFixture('source-note', 'Band gap notes.');
  await store.putSource(record, bytes);
  await store.applyProposal(
    proposal(
      [
        {
          op: 'upsert_page',
          page: conceptDraft('band-gap', {
            title: 'Band gap',
            summary: 'The band gap decides whether a material conducts.',
            markdown: '# Band gap\n\nA small band gap lets electrons jump into the conduction band; a large one makes an insulator.',
          }),
        },
        {
          op: 'upsert_page',
          page: conceptDraft('doping', { title: 'Doping', summary: 'Impurities add carriers to a semiconductor band gap.', markdown: '# Doping\n\nDonors add electrons near the conduction band.' }),
        },
        { op: 'upsert_page', page: synthesisDraft('band-gap-worked', ['source-note'], { title: 'Band gap, worked', summary: 'A saved answer: how the band gap decides whether a material conducts.' }) },
      ],
      { 'band-gap': null, doping: null, 'band-gap-worked': null },
    ),
  );
  return store;
}

const collect = () => {
  const events: WikiAskStreamEvent[] = [];
  return { events, emit: (e: WikiAskStreamEvent) => events.push(e) };
};

test('sanitizeAnswer keeps citations to pages in context and drops the rest', () => {
  const allowed = new Set(['band-gap', 'doping']);
  const out = sanitizeAnswer('A small gap conducts [[band-gap]]. Donors help [[doping|Doping]]. Made up [[quantum-foam]]. Course says so [lesson: semis-1]. Also [brain: band-gap].', allowed);
  assert.equal(out.text, 'A small gap conducts [[band-gap]]. Donors help [[doping]]. Made up. Course says so. Also [[band-gap]].');
  assert.deepEqual(out.cited, ['band-gap', 'doping']);
  assert.deepEqual(out.dropped, ['quantum-foam', 'lesson: semis-1']);
});

test('the stream filter never releases an unjudged citation, and joins back to the sanitised answer', () => {
  const allowed = new Set(['band-gap']);
  const filter = new CitationStreamFilter(allowed);
  const parts = ['Gaps decide ', 'conduction [', '[band-', 'gap]]. Not [[inv', 'ented]] here.'];
  const released = parts.map((p) => filter.push(p));
  released.push(filter.flush());
  for (const piece of released) assert.doesNotMatch(piece, /invented|\[\[band-$/);
  assert.equal(released.join('').trim(), sanitizeAnswer(parts.join(''), allowed).text);
});

test('askWiki: a cited answer from the student’s own pages, unknown citations dropped, kept for saving', async () => {
  const store = await seeded('ask-cited');
  const asks = new AskStore(await tempRoot('ask-store'));
  const seen = { calls: 0 } as { prompt?: string; instructions?: string; calls: number };
  const { events, emit } = collect();
  const result = await askWiki(
    'How does the band gap decide whether a material conducts?',
    { wiki: store, complete: fake(['A small band gap lets electrons reach the conduction band [[band-gap]]', '. I saved a worked version [[band-gap-worked]]. ', 'Doping adds carriers [[doping]]. Phonons too [[phonon-page]].'], seen), store: asks },
    emit,
  );
  WikiAskResultSchema.parse(result);
  assert.equal(seen.calls, 1);
  assert.equal(result.outcome, 'answered');
  assert.equal(result.evidence, 'student_wiki');
  assert.deepEqual(
    result.citations.map((c) => c.pageId),
    ['band-gap', 'band-gap-worked'],
  );
  assert.equal(result.citations[0]!.title, 'Band gap');
  assert.ok(!result.pagesRead.some((p) => p.pageId === 'doping'), 'doping did not match the question');
  // A page that exists in the vault but was not in the context is dropped like an invented one.
  assert.deepEqual(result.droppedCitations, ['doping', 'phonon-page']);
  assert.equal(result.citations[1]!.generated, true);
  assert.doesNotMatch(result.answer, /phonon-page/);
  assert.equal(result.pagesSearched, 3);
  assert.ok(result.pagesRead.some((p) => p.pageId === 'band-gap-worked' && p.generated), 'the saved synthesis is read but marked model-written');
  assert.match(seen.prompt!, /MODEL-WRITTEN/);
  assert.match(seen.prompt!, /QUESTION: How does the band gap/);
  assert.match(seen.instructions!, /ONLY the student's own wiki pages/);

  // Events: status first, the pages read, deltas with no unknown citation, never a 'done' from askWiki itself.
  assert.equal(events[0]?.type, 'status');
  assert.ok(events.some((e) => e.type === 'pages'));
  const streamed = events.flatMap((e) => (e.type === 'delta' ? [e.text] : [])).join('');
  assert.doesNotMatch(streamed, /phonon-page/);
  assert.match(streamed, /\[\[band-gap\]\]/);

  const kept = await asks.get(result.askId!);
  assert.equal(kept?.answer, result.answer);
  assert.equal(kept?.question, result.question);
});

test('askWiki: empty brain and no hits answer honestly without calling a model', async () => {
  const seen = { calls: 0 };
  const empty = await askWiki('What is a band gap?', { wiki: await vault('ask-empty'), complete: fake(['x'], seen) }, () => {});
  assert.equal(empty.outcome, 'empty_brain');
  assert.equal(empty.answer, EMPTY_BRAIN_ANSWER);
  assert.equal(empty.askId, null);

  const store = await seeded('ask-nohit');
  const none = await askWiki('Who painted the Sistine chapel ceiling?', { wiki: store, complete: fake(['x'], seen) }, () => {});
  assert.equal(none.outcome, 'no_hits');
  assert.equal(none.answer, NO_HITS_ANSWER);
  assert.equal(none.pagesSearched, 3);
  assert.equal(seen.calls, 0, 'no model call on either honest path');
});

test('askWiki: a model that fails or says nothing is reported, not invented', async () => {
  const store = await seeded('ask-down');
  const throwing: AskComplete = async () => {
    throw new Error('connect ECONNREFUSED');
  };
  const down = await askWiki('band gap conduction', { wiki: store, complete: throwing }, () => {});
  assert.equal(down.outcome, 'model_unavailable');
  assert.equal(down.answer, MODEL_UNAVAILABLE_ANSWER);
  assert.equal(down.askId, null);

  const silent = await askWiki('band gap conduction', { wiki: store, complete: fake([]) }, () => {});
  assert.equal(silent.outcome, 'model_unavailable');

  const hung: AskComplete = async () => ({ label: 'slow', text: { [Symbol.asyncIterator]: () => ({ next: () => new Promise<IteratorResult<string>>(() => {}) }) } });
  const slow = await askWiki('band gap conduction', { wiki: store, complete: hung, firstTokenMs: 20 }, () => {});
  assert.equal(slow.outcome, 'model_unavailable', 'no first token inside the budget');
});
