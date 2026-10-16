import assert from 'node:assert/strict';
import { appendFile, mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import type { Lesson } from '@sef/shared';
import { buildCourseGraph } from '../brain/course-graph';
import { pendingProposalRecord, writeProposalRecord } from '../brain/proposals';
import { conceptDraft, legacyPage, PROFILE, proposal, synthesisDraft, vault, writeLegacyVault } from '../brain/testing/fixtures';
import { BrainVault } from '../brain/vault';
import { vaultPath } from '../brain/vault-layout';
import type { WikiStore } from '../brain/wiki-store';
import { anchorCatalog, anchorTargetOf, anchorTopic, matchAnchorPages, profileAnchors, type AnchorContext } from './anchors';

process.env.ENGINE_DATA_DIR = await mkdtemp(path.join(tmpdir(), 'sef-anchors-'));

/** One released course, so the graph names exactly what this programme teaches. */
const LESSONS: Lesson[] = [
  {
    id: 'lesson-momentum',
    courseId: 'classical-mechanics',
    courseName: 'Classical Mechanics',
    moduleId: 'm1',
    moduleName: 'Mechanics I',
    subjectId: 'physics',
    semesterNumber: 1,
    order: 1,
    title: 'Momentum and Its Conservation',
    concepts: ['momentum', 'damping', 'impulse', 'force balance', 'force diagrams'],
    prerequisites: [],
    tags: [],
    markdown: 'Momentum is conserved in isolated systems.',
  },
];

/** The real stores over the real vault: nothing about the anchor seam is mocked. */
const ctx = async (store: WikiStore): Promise<AnchorContext> => {
  const view = new BrainVault(store.root);
  await view.init();
  return { wiki: store, vault: view, graph: buildCourseGraph(LESSONS), programmeId: PROFILE.programmeId };
};

const resolve = (c: AnchorContext, request: Parameters<ReturnType<typeof profileAnchors>['resolve']>[0]) => profileAnchors(c).resolve(request);

test('the catalogue lists only committed, course-linked concept pages', async () => {
  const store = await vault('anchors-catalogue');
  await store.applyProposal(
    proposal(
      [
        { op: 'upsert_page', page: conceptDraft('damping') },
        { op: 'upsert_page', page: conceptDraft('momentum') },
        // Claims a concept this programme's releases no longer teach.
        { op: 'upsert_page', page: conceptDraft('telekinesis', { courseRefs: [{ programmeId: PROFILE.programmeId, courseId: 'classical-mechanics', conceptKey: 'telekinesis' }] }) },
        // A concept page that never linked to the course at all.
        { op: 'upsert_page', page: conceptDraft('private-idea', { courseRefs: [] }) },
        // Generated pages are context, never an origin.
        { op: 'upsert_page', page: synthesisDraft('notes-digest', ['source-note']) },
      ],
      { damping: null, momentum: null, telekinesis: null, 'private-idea': null, 'notes-digest': null },
    ),
  );

  const c = await ctx(store);
  const anchors = await anchorCatalog(c);
  assert.deepEqual(
    anchors.map((a) => a.pageId).sort(),
    ['damping', 'momentum'],
    'remapped, unlinked and generated pages never reach the catalogue',
  );
  const damping = anchors.find((a) => a.pageId === 'damping');
  assert.equal(damping?.courseConceptKey, 'damping');
  assert.deepEqual(damping?.courseRefs, ['classical-mechanics']);
  assert.equal(damping?.courseName, 'Classical Mechanics');
  assert.match(damping?.pageRevision ?? '', /^rev-/);
});

test('a committed page resolves and carries its catalogue row', async () => {
  const store = await vault('anchors-happy');
  await store.applyProposal(proposal([{ op: 'upsert_page', page: conceptDraft('damping') }], { damping: null }));
  const c = await ctx(store);
  const snapshot = await store.readPage('damping');

  const resolved = await resolve(c, { teacher: 'philosopher', anchorPageId: 'damping', committed: new Map() });
  assert.equal(resolved.ok, true);
  if (!resolved.ok) return;
  assert.equal(resolved.anchor.pageId, 'damping');
  assert.equal(resolved.anchor.pageRevision, snapshot?.revision);
  assert.equal(resolved.anchor.courseConceptKey, 'damping');
  assert.equal(resolved.candidate?.pageId, 'damping');
  assert.equal(resolved.candidate?.conceptLabel, 'damping');
  assert.equal(resolved.candidate?.pageRevision, snapshot?.revision);

  const pinned = await resolve(c, { teacher: 'philosopher', anchorPageId: 'damping', claimedRevision: snapshot?.revision, committed: new Map() });
  assert.equal(pinned.ok, true, 'the current revision is the claim that holds');
});

test('a revision claim against a page that grew is a stale anchor', async () => {
  const store = await vault('anchors-stale');
  await store.applyProposal(proposal([{ op: 'upsert_page', page: conceptDraft('damping', { markdown: 'First.' }) }], { damping: null }));
  const first = await store.readPage('damping');
  await store.applyProposal(proposal([{ op: 'upsert_page', page: conceptDraft('damping', { markdown: 'Second.' }) }], { damping: first?.revision ?? '' }));

  const c = await ctx(store);
  const stale = await resolve(c, { teacher: 'philosopher', anchorPageId: 'damping', claimedRevision: first?.revision ?? '', committed: new Map() });
  assert.deepEqual(stale, { ok: false, reason: 'stale_revision' }, 'the page was re-read; the earlier claim is refused');
});

test('a released syllabus concept resolves only to this student’s own page for it', async () => {
  const store = await vault('anchors-syllabus');
  await store.applyProposal(proposal([{ op: 'upsert_page', page: conceptDraft('momentum') }], { momentum: null }));
  const c = await ctx(store);

  const own = await resolve(c, { teacher: 'philosopher', syllabusConceptKey: 'momentum', committed: new Map() });
  assert.equal(own.ok, true);
  if (own.ok) assert.equal(own.anchor.pageId, 'momentum');

  const absent = await resolve(c, { teacher: 'philosopher', syllabusConceptKey: 'impulse', committed: new Map() });
  assert.deepEqual(absent, { ok: false, reason: 'syllabus_concept_not_an_anchor' }, 'the released concept alone is still no anchor');

  const none = await resolve(c, { teacher: 'philosopher', committed: new Map() });
  assert.deepEqual(none, { ok: false, reason: 'no_anchor' });
});

test('pages that are not committed course concepts refuse by name', async () => {
  const store = await vault('anchors-refusals');
  await store.applyProposal(
    proposal(
      [
        { op: 'upsert_page', page: conceptDraft('damping') },
        { op: 'upsert_page', page: conceptDraft('telekinesis', { courseRefs: [{ programmeId: PROFILE.programmeId, courseId: 'classical-mechanics', conceptKey: 'telekinesis' }] }) },
        { op: 'upsert_page', page: conceptDraft('private-idea', { courseRefs: [] }) },
        { op: 'upsert_page', page: synthesisDraft('notes-digest', ['source-note']) },
      ],
      { damping: null, 'notes-digest': null, telekinesis: null, 'private-idea': null },
    ),
  );
  const c = await ctx(store);
  const request = (anchorPageId: string) => ({ teacher: 'philosopher' as const, anchorPageId, committed: new Map() });

  assert.deepEqual(await resolve(c, request('no-such-page')), { ok: false, reason: 'uncommitted_page' });
  assert.deepEqual(await resolve(c, request('notes-digest')), { ok: false, reason: 'not_a_course_concept' }, 'a generated page is context, not an origin');
  assert.deepEqual(await resolve(c, request('telekinesis')), { ok: false, reason: 'not_a_course_concept' }, 'a remapped course concept is no anchor');
  assert.deepEqual(await resolve(c, request('private-idea')), { ok: false, reason: 'not_a_course_concept' });

  // A pending proposal is not yet a page: the file on disk is a record, not a committed page.
  await writeProposalRecord(store.root, pendingProposalRecord(proposal([{ op: 'upsert_page', page: conceptDraft('ghost-page') }], { 'ghost-page': null }), 'job-1'));
  assert.deepEqual(await resolve(c, request('ghost-page')), { ok: false, reason: 'uncommitted_page' }, 'a pending proposal cannot anchor');

  // An unaccepted peer share lands outside the page directories — it is not this student's wiki.
  await writeFile(vaultPath(store.root, '.meta', 'shared-page.md'), '---\nshared: true\n---\nA peer page not yet accepted.\n');
  assert.deepEqual(await resolve(c, request('shared-page')), { ok: false, reason: 'uncommitted_page' }, 'an unaccepted share cannot anchor');
});

test('out-of-band, malformed and deleted pages are all uncommitted', async () => {
  const store = await vault('anchors-drift');
  await store.applyProposal(
    proposal(
      [
        { op: 'upsert_page', page: conceptDraft('damping') },
        { op: 'upsert_page', page: conceptDraft('momentum') },
      ],
      { damping: null, momentum: null },
    ),
  );
  const c = await ctx(store);
  const request = (anchorPageId: string) => ({ teacher: 'philosopher' as const, anchorPageId, committed: new Map() });

  // An edit made outside the keeper drifts the file off its committed revision.
  await appendFile(vaultPath(store.root, 'concepts', 'damping.md'), '\nEdited by hand.\n');
  assert.equal((await store.readPage('damping'))?.state, 'out_of_band');
  assert.deepEqual(await resolve(c, request('damping')), { ok: false, reason: 'uncommitted_page' });
  assert.equal(anchorTargetOf(await store.readPage('damping'), c), null, 'a drifted file has no anchor target');

  // A file the format cannot read is not a page at all.
  await writeFile(vaultPath(store.root, 'concepts', 'broken.md'), 'this is not a page file\n');
  assert.deepEqual(await resolve(c, request('broken')), { ok: false, reason: 'uncommitted_page' });

  // A deleted page is gone even though its history is kept.
  const gone = await store.readPage('momentum');
  await store.removePage('momentum', gone?.revision ?? '');
  assert.deepEqual(await resolve(c, request('momentum')), { ok: false, reason: 'uncommitted_page' });
});

test('a shaky concept page still anchors — mastery never gates exploration', async () => {
  const store = await vault('anchors-shaky');
  await writeLegacyVault(store.root, { pages: [legacyPage('momentum', { courseRefs: ['classical-mechanics'] })] });
  const c = await ctx(store);

  const anchors = await anchorCatalog(c);
  const momentum = anchors.find((a) => a.pageId === 'momentum');
  assert.equal(momentum?.status, 'shaky', 'the unresolved misconception computes shaky');
  assert.deepEqual(momentum?.courseRefs, ['classical-mechanics']);

  const resolved = await resolve(c, { teacher: 'philosopher', anchorPageId: 'momentum', committed: new Map() });
  assert.equal(resolved.ok, true);
  if (resolved.ok) assert.equal(resolved.candidate?.status, 'shaky');
});

test('another profile’s page is not this student’s wiki', async () => {
  const mine = await vault('anchors-mine');
  const theirs = await vault('anchors-theirs');
  await mine.applyProposal(proposal([{ op: 'upsert_page', page: conceptDraft('damping') }], { damping: null }));

  const mineCtx = await ctx(mine);
  const theirsCtx = await ctx(theirs);
  assert.equal((await resolve(mineCtx, { teacher: 'philosopher', anchorPageId: 'damping', committed: new Map() })).ok, true);
  assert.deepEqual(await resolve(theirsCtx, { teacher: 'philosopher', anchorPageId: 'damping', committed: new Map() }), { ok: false, reason: 'uncommitted_page' });
  assert.equal((await anchorCatalog(theirsCtx)).length, 0);
});

test('free text resolves one page, hands ambiguity back, and never guesses', async () => {
  const store = await vault('anchors-match');
  await store.applyProposal(
    proposal(
      [
        { op: 'upsert_page', page: conceptDraft('force-balance') },
        // conceptKey strips the plural: the course concept is 'force-diagram'.
        { op: 'upsert_page', page: conceptDraft('force-diagram') },
        { op: 'upsert_page', page: conceptDraft('damping') },
      ],
      { 'force-balance': null, 'force-diagram': null, damping: null },
    ),
  );
  const catalog = await anchorCatalog(await ctx(store));

  const resolved = matchAnchorPages(catalog, 'force balance');
  assert.equal(resolved.outcome, 'resolved');
  assert.equal(resolved.anchors[0]?.pageId, 'force-balance');

  const ambiguous = matchAnchorPages(catalog, 'force');
  assert.equal(ambiguous.outcome, 'ambiguous', 'two covered terms — the student chooses, the engine does not');
  assert.deepEqual(
    ambiguous.anchors.map((a) => a.pageId).sort(),
    ['force-balance', 'force-diagram'],
  );

  assert.equal(matchAnchorPages(catalog, 'damping').outcome, 'resolved');
  assert.equal(matchAnchorPages(catalog, 'alchemy').outcome, 'none');
  assert.equal(matchAnchorPages(catalog, '   ').outcome, 'none', 'an empty query names nothing');
});

test('the web topic is the released course’s label, never the student’s text', async () => {
  const store = await vault('anchors-topic');
  await store.applyProposal(proposal([{ op: 'upsert_page', page: conceptDraft('damping') }], { damping: null }));
  const [candidate] = await anchorCatalog(await ctx(store));
  assert.equal(anchorTopic(candidate!), 'damping');
});
