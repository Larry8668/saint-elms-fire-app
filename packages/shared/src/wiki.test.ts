import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  LearningEventSchema,
  SearchMatchKindSchema,
  SearchModeSchema,
  SourceCitationSchema,
  SourceLocatorSchema,
  SourceRecordSchema,
  WikiClaimSchema,
  WikiEditSchema,
  WikiJobSchema,
  WikiLinkSchema,
  WikiPageDraftSchema,
  WikiPageHitSchema,
  WikiPageSchema,
  WikiProposalSchema,
} from './wiki';
import { makeContractFixtures } from './testing/fixtures';

type AnySchema = { safeParse: (v: unknown) => { success: boolean }; parse: (v: unknown) => unknown };

const rejects = (schema: AnySchema, value: unknown, message?: string) =>
  assert.equal(schema.safeParse(value).success, false, message);

test('all eight source kinds parse from fixtures', () => {
  const { sources } = makeContractFixtures();
  for (const [name, record] of Object.entries(sources)) {
    assert.equal(SourceRecordSchema.safeParse(record).success, true, `${name} should parse`);
  }
});

test('source variants enforce their origin and detail requirements', () => {
  const { sources } = makeContractFixtures();
  rejects(SourceRecordSchema, { ...sources.answer, origin: 'student' });
  rejects(SourceRecordSchema, { ...sources.peer, share: undefined });
  rejects(SourceRecordSchema, {
    ...sources.session,
    session: { sessionId: 'session-1', teacher: 'guide', firstTurn: 4, lastTurn: 2 },
  });
  rejects(SourceRecordSchema, { ...sources.studentNote, origin: 'course' });
  rejects(SourceRecordSchema, { ...sources.externalDocument, extraneous: 'field' });
  // A recording is only ever the student's own voice or external material.
  rejects(SourceRecordSchema, { ...sources.audio, origin: 'course' });
  rejects(SourceRecordSchema, { ...sources.audio, origin: 'model' });
  // A fetched video is always external and must carry its link provenance.
  const video = sources.video;
  if (video.kind !== 'video') throw new Error('fixture drift — video source must be kind video');
  rejects(SourceRecordSchema, { ...video, origin: 'student' });
  rejects(SourceRecordSchema, { ...video, link: undefined });
  rejects(SourceRecordSchema, { ...video, link: { ...video.link, provider: 'vimeo' } });
});

test('an audio source and its audio extraction pass round-trip the contract', () => {
  const { sources } = makeContractFixtures();
  const parsed = SourceRecordSchema.parse(sources.audio);
  assert.equal(parsed.kind, 'audio');
  assert.equal(parsed.mediaType, 'audio/wav');
  assert.equal(parsed.extractions.at(-1)?.method, 'audio');
});

test('locators reject reversed ranges and invalid pages', () => {
  rejects(SourceLocatorSchema, { kind: 'text', start: 50, end: 10 });
  rejects(SourceLocatorSchema, { kind: 'text', start: 10, end: 10 });
  rejects(SourceLocatorSchema, { kind: 'pdf', page: 0, excerpt: 'x' });
  rejects(SourceLocatorSchema, { kind: 'session', firstTurn: 5, lastTurn: 2 });
  rejects(SourceLocatorSchema, { kind: 'hologram' });
});

test('a structurally valid citation can still be runtime-unresolved', () => {
  const { citations, sources } = makeContractFixtures();
  const missing = citations.runtimeUnresolvedSourceCitation;
  assert.equal(SourceCitationSchema.safeParse(missing).success, true, 'shape parses');
  assert.equal(
    Object.values(sources).some((s) => s.id === missing.sourceId),
    false,
    'no fixture source backs it: resolution is engine work',
  );
});

test('claims require citations for facts and beliefs only', () => {
  const { wiki } = makeContractFixtures();
  const fact = wiki.mechanicsDraft.claims[0]!;
  rejects(WikiClaimSchema, { ...fact, citations: [] });
  const belief = wiki.mechanicsDraft.claims[1]!;
  rejects(WikiClaimSchema, { ...belief, citations: [] });
  assert.equal(
    WikiClaimSchema.safeParse({ ...fact, kind: 'deduction', citations: [] }).success,
    true,
    'deductions may stand without direct citations',
  );
});

test('contradicted claim pair stays structurally valid for semantic tests later', () => {
  const { wiki } = makeContractFixtures();
  assert.equal(WikiClaimSchema.safeParse(wiki.contradictedClaims.course).success, true);
  assert.equal(WikiClaimSchema.safeParse(wiki.contradictedClaims.student).success, true);
});

test('student-made links require evidence; suggested links may not', () => {
  const { wiki } = makeContractFixtures();
  const studentLink = wiki.mechanicsDraft.links[0]!;
  rejects(WikiLinkSchema, { ...studentLink, citations: [] });
  const suggested = { ...studentLink, origin: 'suggested', citations: [] };
  assert.equal(WikiLinkSchema.safeParse(suggested).success, true);
});

test('wiki pages are committed only and carry no editable mastery fields', () => {
  const { wiki } = makeContractFixtures();
  rejects(WikiPageSchema, { ...wiki.mechanicsPage, state: 'pending' });
  rejects(WikiPageSchema, { ...wiki.mechanicsPage, status: 'solid' });
  rejects(WikiPageDraftSchema, {
    ...wiki.mechanicsDraft,
    learner: { ...wiki.mechanicsDraft.learner, status: 'solid' },
  });
  rejects(WikiPageDraftSchema, {
    ...wiki.mechanicsDraft,
    learner: { ...wiki.mechanicsDraft.learner, score: 0.8 },
  });
});

test('page draft variants each carry their required fields', () => {
  const { wiki } = makeContractFixtures();
  assert.equal(WikiPageDraftSchema.safeParse(wiki.mechanicsDraft).success, true);
  assert.equal(WikiPageDraftSchema.safeParse(wiki.sourceSummaryDraft).success, true);
  assert.equal(WikiPageDraftSchema.safeParse(wiki.synthesisDraft).success, true);
  assert.equal(WikiPageDraftSchema.safeParse(wiki.questionDraft).success, true);
  rejects(WikiPageDraftSchema, { ...wiki.sourceSummaryDraft, sourceIds: [] });
  rejects(WikiPageDraftSchema, { ...wiki.synthesisDraft, sourceIds: [] });
});

test('proposals need sources and a base revision per edited page', () => {
  const { wiki } = makeContractFixtures();
  assert.equal(WikiProposalSchema.safeParse(wiki.proposal).success, true);
  rejects(WikiProposalSchema, { ...wiki.proposal, sourceIds: [] });
  const missingBase = { ...wiki.proposal, baseRevisions: { 'page-mechanics': 'rev-3' } };
  rejects(WikiProposalSchema, missingBase, 'every edited page needs a baseRevision entry');
  const createOnly = {
    ...wiki.proposal,
    baseRevisions: { 'page-force-synthesis': null },
    operations: [{ op: 'upsert_page', page: wiki.synthesisDraft }],
  };
  assert.equal(WikiProposalSchema.safeParse(createOnly).success, true, 'null base revision marks a new page');
});

test('wiki edits admit no raw-write or mastery operations', () => {
  const { wiki } = makeContractFixtures();
  for (const op of [
    { op: 'write_file', path: 'vault/x.md', content: 'raw' },
    { op: 'delete_page', pageId: 'page-mechanics' },
    { op: 'set_mastery', pageId: 'page-mechanics', status: 'solid' },
    { op: 'upsert_page', page: wiki.mechanicsDraft, status: 'solid' },
  ]) {
    rejects(WikiEditSchema, op);
  }
});

test('a search hit carries its match lane and the mode enum round-trips', () => {
  const entry = {
    id: 'page-mechanics',
    kind: 'concept',
    title: 'Mechanics',
    summary: 'Force and motion.',
    revision: 'rev-3',
    updatedAt: null,
    state: 'ok',
    sourceIds: [],
    claims: 2,
    links: 1,
  };
  const hit = { ...entry, score: 0.91, match: 'both' };
  assert.deepEqual(WikiPageHitSchema.parse(hit), hit);
  for (const match of ['keyword', 'semantic', 'both']) {
    assert.equal(SearchMatchKindSchema.parse(match), match);
  }
  rejects(WikiPageHitSchema, { ...hit, match: 'vibes' });
  rejects(WikiPageHitSchema, { ...hit, match: undefined }, 'a hit without its lane is not a hit');

  for (const mode of ['hybrid', 'keyword_only']) {
    assert.equal(SearchModeSchema.parse(mode), mode);
  }
  rejects(SearchModeSchema, 'embeddings');
});

test('jobs tie error to failed and proposal to review stages', () => {
  const { jobs } = makeContractFixtures();
  assert.equal(WikiJobSchema.safeParse(jobs.queued).success, true);
  assert.equal(WikiJobSchema.safeParse(jobs.failed).success, true);
  assert.equal(WikiJobSchema.safeParse(jobs.awaitingReview).success, true);
  assert.equal(WikiJobSchema.safeParse(jobs.committed).success, true);

  rejects(WikiJobSchema, { ...jobs.queued, stage: 'failed' }, 'failed without error');
  rejects(WikiJobSchema, { ...jobs.queued, error: 'boom' }, 'error on a non-failed stage');
  rejects(WikiJobSchema, { ...jobs.awaitingReview, proposalId: null }, 'awaiting_review needs a proposal');
  rejects(WikiJobSchema, { ...jobs.committed, proposalId: null }, 'committed needs a proposal');
  rejects(WikiJobSchema, { ...jobs.queued, progress: { completed: 3, total: 2 } });
  rejects(WikiJobSchema, { ...jobs.queued, progress: { completed: 0, total: 0 } });
  rejects(WikiJobSchema, { ...jobs.queued, updatedAt: '2024-01-01T00:00:00.000Z' });
});

test('learning events only credit student evidence toward mastery', () => {
  const { events } = makeContractFixtures();
  assert.equal(LearningEventSchema.safeParse(events.studentEvent).success, true);
  assert.equal(LearningEventSchema.safeParse(events.modelEvent).success, true);
  for (const actor of ['peer', 'model']) {
    rejects(LearningEventSchema, { ...events.modelEvent, actor, knowledgeOnly: false });
  }
  rejects(LearningEventSchema, { ...events.studentEvent, evidence: [] });
});
