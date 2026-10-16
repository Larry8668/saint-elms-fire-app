import assert from 'node:assert/strict';
import { test } from 'node:test';
import { CONTRACT_VERSION, SharePayloadSchema, type PublishedShare, type SharedAttachment } from '@sef/shared';
import { sha256Hex } from '../lib/hash';
import {
  buildSharePayload,
  extractCitations,
  fitShareMarkdown,
  NEVER_SHARED,
  peerSourceDocument,
  shareIdempotencyKey,
  shareRequest,
  SHARE_MARKDOWN_MAX_BYTES,
  SHARE_MARKDOWN_MAX_CHARS,
  SHARE_TITLE_MAX,
  type ShareSourcePage,
} from './payload';

const page = (over: Partial<ShareSourcePage> = {}): ShareSourcePage => ({
  title: 'Damped oscillations',
  kind: 'concept',
  summary: 'Energy leaks out of the system each cycle.',
  body: '# Damped oscillations\n\nAmplitude decays exponentially.',
  ...over,
});

const attachment = (id: string): SharedAttachment => ({
  id,
  name: `${id}.pdf`,
  mediaType: 'application/pdf',
  sha256: sha256Hex(Buffer.from(id)),
  bytes: 1024,
});

test('the payload is the allowlist: title, summary, public body, citations, descriptors', () => {
  const { payload } = buildSharePayload(
    page({ body: '# Damped oscillations\n\nAmplitude decays exponentially.\n\n## What I learned\n\nThe envelope is $A_0 e^{-\\gamma t}$.' }),
    [attachment('notes-pdf')],
  );
  assert.equal(payload.title, 'Damped oscillations');
  assert.match(payload.markdown, /_Energy leaks out of the system each cycle\._/);
  assert.match(payload.markdown, /The envelope is/);
  // The document's own H1 is not duplicated inside the payload.
  assert.equal(payload.markdown.match(/^# Damped oscillations$/gm)?.length, 1);
  assert.equal(payload.attachments.length, 1);
  assert.equal(payload.attachments[0]?.sha256.length, 64, 'only the descriptor travels');
  assert.ok(SharePayloadSchema.safeParse(payload).success);
});

test('private sections — struggles, misconceptions, quizzes, contacts — are cut with their subsections', () => {
  const { payload, excluded } = buildSharePayload(
    page({
      body: [
        '# Damped oscillations',
        '',
        'Public material stays.',
        '',
        '## Where I got stuck',
        '',
        'The exponential confused me.',
        '',
        '### Nested detail',
        '',
        'Still private — a deeper heading cannot leak back.',
        '',
        '## Misconceptions',
        '',
        'Thought damping sped things up.',
        '',
        '## Quiz results',
        '',
        '2 out of 3.',
        '',
        '## Contact details',
        '',
        'tutor@example.test 01234',
        '',
        '## Public again',
        '',
        'The envelope shrinks each period.',
      ].join('\n'),
    }),
  );
  for (const secret of ['exponential confused', 'Nested detail', 'damping sped', '2 out of 3', 'tutor@example.test']) {
    assert.ok(!payload.markdown.includes(secret), `"${secret}" must not appear in the payload`);
  }
  assert.match(payload.markdown, /Public material stays/);
  assert.match(payload.markdown, /envelope shrinks each period/);
  for (const heading of ['Where I got stuck', 'Misconceptions', 'Quiz results', 'Contact details']) {
    assert.ok(excluded.some((item) => item.includes(heading)), `excluded names the ${heading} section`);
  }
});

test('the allowlist exclusions are always declared to the author', () => {
  const { excluded } = buildSharePayload(page());
  for (const item of NEVER_SHARED) assert.ok(excluded.includes(item));
});

test('[[page-id]] links stay in the text as explicit references to unshared pages', () => {
  const { payload } = buildSharePayload(page({ body: 'See [[energy]] for the other half.' }));
  assert.match(payload.markdown, /\[\[energy\]\]/);
  assert.match(payload.markdown, /references the sender kept, not material the sender shared/);
});

test('citations come from the text itself: linked labels, bare urls, deduped, http only', () => {
  const { items } = extractCitations(
    [
      'Read [the notes](https://uni.example.test/notes).',
      'Again https://uni.example.test/notes — a duplicate.',
      'Bare: https://open.example.test/osc.',
      'Not a link: ftp://files.example.test/x and [bad](javascript:alert(1)).',
      'And a sentence-ending url https://period.example.test/a.',
    ].join('\n'),
  );
  assert.equal(items.length, 3);
  assert.equal(items[0]?.title, 'the notes');
  assert.equal(items[0]?.url, 'https://uni.example.test/notes');
  assert.ok(items.some((c) => c.url === 'https://open.example.test/osc'));
  assert.ok(items.some((c) => c.url === 'https://period.example.test/a'), 'trailing punctuation is trimmed');
  assert.ok(!items.some((c) => c.url?.startsWith('javascript:') || c.url?.startsWith('ftp:')));
});

test('the 20-citation cap is enforced and the overflow is reported for the excluded list', () => {
  const markdown = Array.from({ length: 25 }, (_, i) => `https://site-${i}.example.test/`).join('\n');
  const { items, overflow } = extractCitations(markdown);
  assert.equal(items.length, 20);
  assert.equal(overflow, 5);
  const { excluded } = buildSharePayload(page({ body: markdown }));
  assert.ok(excluded.some((item) => item.includes('5 further link')));
});

test('attachments are capped at the contract limit', () => {
  const { payload, excluded } = buildSharePayload(
    page(),
    Array.from({ length: 9 }, (_, i) => attachment(`file-${i}`)),
  );
  assert.equal(payload.attachments.length, 8);
  assert.ok(SharePayloadSchema.safeParse(payload).success);
  void excluded;
});

test('title and markdown fit the contract caps — even unicode-heavy text', () => {
  const { payload } = buildSharePayload(page({ title: 'Ω'.repeat(400), body: 'É'.repeat(30_000) }));
  assert.ok(payload.title.length <= SHARE_TITLE_MAX);
  assert.ok(payload.markdown.length <= SHARE_MARKDOWN_MAX_CHARS);
  assert.ok(Buffer.byteLength(payload.markdown, 'utf8') <= SHARE_MARKDOWN_MAX_BYTES);
  assert.match(payload.markdown, /trimmed to fit the share limit/);
  assert.ok(SharePayloadSchema.safeParse(payload).success, 'a trimmed payload still validates');
});

test('short markdown is returned untouched by the fitter', () => {
  const text = '# Small\n\nFine as it is.';
  assert.equal(fitShareMarkdown(text), text);
});

test('the idempotency key is stable for the same page+markdown and changes with either', () => {
  const a = shareIdempotencyKey('damping', 'same body');
  assert.equal(a, shareIdempotencyKey('damping', 'same body'), 'a retry replays the first publish');
  assert.notEqual(a, shareIdempotencyKey('damping', 'edited body'));
  assert.notEqual(a, shareIdempotencyKey('energy', 'same body'));
  assert.match(shareIdempotencyKey('page with spaces!', 'x'), /^pub_[A-Za-z0-9_-]+$/);
});

test('the request the prepare step shows is the literal publish body', () => {
  const { payload } = buildSharePayload(page());
  const request = shareRequest('damping', 'bsc-physics', payload);
  assert.equal(request.programmeId, 'bsc-physics');
  assert.equal(request.payload, payload, 'the payload object is carried through verbatim');
  assert.equal(request.idempotencyKey, shareIdempotencyKey('damping', payload.markdown));
});

test('an imported share freezes as a markdown document with attribution, citations and attachment descriptors only', () => {
  const share: PublishedShare = {
    schemaVersion: CONTRACT_VERSION,
    id: 'share-9',
    revision: 'rev-2',
    senderId: 'student-b',
    senderName: 'Bea',
    programmeId: 'bsc-physics',
    cohortId: 'coh-1',
    createdAt: '2026-10-15T10:00:00.000Z',
    state: 'published',
    payload: {
      title: 'Damping notes',
      markdown: 'The envelope falls exponentially.',
      citations: [{ title: 'Resonance', url: 'https://open.example.test/res' }],
      attachments: [attachment('data-pdf')],
    },
  };
  const document = peerSourceDocument(share);
  assert.match(document, /Shared by Bea · cohort coh-1/);
  assert.match(document, /Share share-9 · revision rev-2/);
  assert.match(document, /The envelope falls exponentially/);
  assert.match(document, /Resonance — https:\/\/open\.example\.test\/res/);
  assert.match(document, /data-pdf\.pdf · application\/pdf · 1024 bytes · sha256/);
  assert.match(document, /descriptors only/);
});
