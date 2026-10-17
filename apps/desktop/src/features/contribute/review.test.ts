import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { ProposalPreview, SourceCitation, WikiJob } from '@sef/shared';
import { STAGE_INFO, canCorrect, citationExcerpt, flowStep, formatSeconds, isLiveJob, locatorLabel, normalizeMediaType, pageBody, previewSummary, sourceKindLabel, textContribution, uploadContribution } from './review';

const STAGES: WikiJob['stage'][] = ['queued', 'extracting', 'awaiting_source_review', 'compiling', 'awaiting_review', 'committed', 'no_changes', 'failed', 'cancelled'];

test('every durable stage has honest copy and a terminal answer', () => {
  for (const stage of STAGES) {
    assert.ok(STAGE_INFO[stage].label, `${stage} needs a label`);
    assert.ok(STAGE_INFO[stage].hint, `${stage} needs a hint`);
  }
  for (const stage of ['committed', 'no_changes', 'failed', 'cancelled'] as const) assert.equal(isLiveJob(stage), false);
  for (const stage of ['queued', 'extracting', 'awaiting_source_review', 'compiling', 'awaiting_review'] as const) assert.equal(isLiveJob(stage), true);
});

test('the rail walks kept → read → proposed → decided → in your wiki', () => {
  assert.equal(flowStep('queued'), 0);
  assert.equal(flowStep('extracting'), 1);
  assert.equal(flowStep('awaiting_source_review'), 1);
  assert.equal(flowStep('compiling'), 2);
  assert.equal(flowStep('awaiting_review'), 3);
  assert.equal(flowStep('committed'), 4);
  assert.equal(flowStep('no_changes'), 4);
  assert.equal(flowStep('cancelled'), 0);
});

test('uploads map onto kinds the schema allows', () => {
  assert.deepEqual(uploadContribution('image/png', true), { kind: 'image', origin: 'student' });
  assert.deepEqual(uploadContribution('image/jpeg', false), { kind: 'image', origin: 'external' });
  assert.deepEqual(uploadContribution('application/pdf', true), { kind: 'document', origin: 'external' }, 'a PDF is always external — own words arrive as notes');
  assert.deepEqual(uploadContribution('text/plain', false), { kind: 'document', origin: 'external' });
  assert.deepEqual(uploadContribution('audio/wav', true), { kind: 'audio', origin: 'student' }, 'a voice memo can be the student’s own');
  assert.deepEqual(uploadContribution('audio/mp4', false), { kind: 'audio', origin: 'external' }, 'a lecture recording can be external material');
});

test('typed text can be the student\u2019s own understanding or external material', () => {
  assert.deepEqual(textContribution(true), { kind: 'note', origin: 'student' });
  assert.deepEqual(textContribution(false), { kind: 'document', origin: 'external' });
});

test('media types fall back to the extension when the platform gives none', () => {
  assert.equal(normalizeMediaType({ type: '', name: 'scan.pdf' }), 'application/pdf');
  assert.equal(normalizeMediaType({ type: '', name: 'notes.md' }), 'text/markdown');
  assert.equal(normalizeMediaType({ type: '', name: 'photo.PNG' }), 'image/png');
  assert.equal(normalizeMediaType({ type: 'image/webp', name: 'photo.bin' }), 'image/webp');
  // A recording the platform cannot type still reaches the audio lane.
  assert.equal(normalizeMediaType({ type: '', name: 'lecture.m4a' }), 'audio/mp4');
  assert.equal(normalizeMediaType({ type: '', name: 'memo.WAV' }), 'audio/wav');
  assert.equal(normalizeMediaType({ type: '', name: 'voicemail.3gp' }), 'audio/3gpp');
  assert.equal(normalizeMediaType({ type: '', name: 'thing.bin' }), 'application/octet-stream');
});

test('kind labels and durations render for every source kind', () => {
  assert.equal(sourceKindLabel('video'), 'Video');
  assert.equal(sourceKindLabel('audio'), 'Recording');
  assert.equal(formatSeconds(95), '1:35');
  assert.equal(formatSeconds(3600 + 125), '1:02:05');
  assert.equal(formatSeconds(0), '0:00');
});

test('a correction is possible while no committed proposal has read the text', () => {
  const job = (stage: WikiJob['stage']) => ({ stage }) as WikiJob;
  assert.equal(canCorrect(null), true);
  for (const stage of ['queued', 'extracting', 'awaiting_source_review', 'failed'] as const) assert.equal(canCorrect(job(stage)), true, stage);
  for (const stage of ['awaiting_review', 'committed', 'no_changes', 'cancelled'] as const) assert.equal(canCorrect(job(stage)), false, stage);
});

const cite = (locator: SourceCitation['locator']): SourceCitation => ({
  sourceId: 'src_1',
  sourceRevision: 'r1',
  sha256: 'a'.repeat(64),
  locator,
});

test('citation excerpts come from the retained text, never from memory', () => {
  const extraction = 'kinetic energy grows with v squared';
  assert.equal(citationExcerpt(cite({ kind: 'text', start: 0, end: 14 }), extraction), 'kinetic energy');
  assert.equal(citationExcerpt(cite({ kind: 'text', start: 0, end: 14 }), null), null);
  assert.equal(citationExcerpt(cite({ kind: 'pdf', page: 3, excerpt: 'Newton saw it' }), null), 'Newton saw it');
  assert.equal(citationExcerpt(cite({ kind: 'image', extractionRevision: 'r1', excerpt: 'notes say' }), extraction), 'notes say');
  assert.equal(citationExcerpt(cite({ kind: 'session', firstTurn: 0, lastTurn: 3 }), 'anything'), null);
});

test('locator labels point at the evidence inside the source', () => {
  assert.equal(locatorLabel({ kind: 'text', start: 4, end: 9 }), 'a passage');
  assert.equal(locatorLabel({ kind: 'pdf', page: 12, excerpt: 'x' }), 'page 12');
  assert.equal(locatorLabel({ kind: 'session', firstTurn: 0, lastTurn: 2 }), 'turns 1–3');
});

test('the review banner counts what the preview would change', () => {
  const page = (change: 'created' | 'updated' | 'unchanged', claims: number, links: number) => ({
    id: `p-${change}-${claims}-${links}`,
    kind: 'concept' as const,
    change,
    title: 't',
    summaryAfter: 's',
    addedClaims: Array.from({ length: claims }, (_, i) => ({ id: `c${i}` }) as never),
    addedLinks: Array.from({ length: links }, () => ({}) as never),
  });
  const preview = {
    record: {} as never,
    conflicts: [],
    pages: [page('created', 2, 1), page('updated', 1, 0), page('unchanged', 0, 0)],
  } as unknown as ProposalPreview;
  assert.deepEqual(previewSummary(preview), { created: 1, updated: 1, unchanged: 1, claims: 3, links: 1 });
});

test('a revision reader shows prose, not the frontmatter it is kept under', () => {
  const raw = '---\nkind: concept\nrevision: rev-1\n---\n# Gravity\n\nFalls.\n';
  assert.equal(pageBody(raw), '# Gravity\n\nFalls.\n');
  assert.equal(pageBody('# No frontmatter\n'), '# No frontmatter\n');
});
