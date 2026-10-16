import assert from 'node:assert/strict';
import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import {
  CONTRACT_VERSION,
  type EngineSettings,
  type Lesson,
  type MaintenanceFinding,
  type SourceCitation,
  type WikiClaim,
  type WikiLink,
} from '@sef/shared';
import type { ContentStore } from '../../content/store';
import type { SettingsReader } from '../../settings/store';
import { WikiCompiler } from '../compiler/compile';
import { readProposalRecord } from '../proposals';
import { conceptDraft, legacyPage, PROFILE, proposal, sourceFixture, synthesisDraft, T0, vault, writeLegacyVault } from '../testing/fixtures';
import { VaultConflictError } from '../vault-errors';
import type { WikiStore } from '../wiki-store';
import { pageContent, serializePageFile } from '../wiki-page-format';
import { MaintenanceService } from './service';
import type { SemanticReviewDraft } from './semantic';

process.env.ENGINE_DATA_DIR = await mkdtemp(path.join(tmpdir(), 'sef-maintenance-'));

const settings: SettingsReader = {
  get: async () =>
    ({
      uniServerUrl: 'https://uni.example.test',
      searxngUrl: '',
      thinking: false,
      providers: [{ id: 'p', kind: 'ollama', label: 'Test model' }],
      roles: { tutor: { provider: 'p', model: 'm' }, brain: { provider: 'p', model: 'm' }, vision: { provider: 'p', model: 'm' } },
    }) as EngineSettings,
};

const lesson = (over: Partial<Lesson> = {}): Lesson => ({
  id: 'lesson-momentum',
  courseId: 'phys-1',
  courseName: 'Physics I',
  moduleId: 'mod-mechanics',
  moduleName: 'Mechanics',
  subjectId: 'physics',
  semesterNumber: 1,
  order: 1,
  title: 'Momentum',
  concepts: ['Momentum', 'Impulse'],
  prerequisites: [],
  tags: [],
  markdown: '# Momentum\n\nMomentum is mass times velocity.',
  ...over,
});

const withLessons = (lessons: Lesson[]) => ({ academicLessons: async () => lessons }) as unknown as ContentStore;

const claim = (id: string, text: string, over: Partial<WikiClaim> = {}): WikiClaim => ({
  id,
  text,
  kind: 'deduction',
  origin: 'model',
  status: 'current',
  citations: [],
  supersedes: [],
  ...over,
});

const link = (toPageId: string, over: Partial<WikiLink> = {}): WikiLink => ({
  toPageId,
  type: 'related_to',
  origin: 'suggested',
  why: 'Test link',
  citations: [],
  ...over,
});

interface Harness {
  store: WikiStore;
  service: MaintenanceService;
  compiler: WikiCompiler;
}

async function harness(
  prefix: string,
  opts: { lessons?: Lesson[]; propose?: (prompt: string) => Promise<SemanticReviewDraft> } = {},
): Promise<Harness> {
  const store = await vault(prefix);
  const content = withLessons(opts.lessons ?? []);
  const identity = async () => PROFILE;
  return {
    store,
    service: new MaintenanceService({ wiki: store, content, settings, identity, ...(opts.propose ? { propose: opts.propose } : {}) }),
    compiler: new WikiCompiler(store, { settings, content, profile: identity }),
  };
}

const byKind = (findings: MaintenanceFinding[], kind: MaintenanceFinding['kind']) => findings.filter((finding) => finding.kind === kind);

test('a seeded orphan produces an orphan finding, deterministically', async () => {
  const { service, store } = await harness('orphan');
  await store.applyProposal(proposal([{ op: 'upsert_page', page: conceptDraft('lone-page', { courseRefs: [] }) }], { 'lone-page': null }));

  const first = await service.report();
  const second = await service.report();
  const orphans = byKind(first.findings, 'orphan');
  assert.equal(orphans.length, 1);
  assert.equal(orphans[0]?.pageIds[0], 'lone-page');
  assert.match(orphans[0]?.prompt ?? '', /relate/i, 'an orphan finding offers a Socratic opener');
  // Same vault, same findings — the pass reads disk, not memory.
  assert.deepEqual(second.findings.map((finding) => finding.id), first.findings.map((finding) => finding.id));
});

test('erased sources surface as missing_source and missing_citation, and the repair only lands on accept', async () => {
  const { service, compiler, store } = await harness('sources');
  const live = sourceFixture('src-notes', 'Force changes momentum over time.');
  const gone = sourceFixture('src-extra', 'Impulse is force times time.');
  await store.putSource(live.record, live.bytes);
  await store.putSource(gone.record, gone.bytes);
  const citation: SourceCitation = { sourceId: 'src-extra', sourceRevision: gone.record.revision, sha256: gone.record.sha256, locator: { kind: 'text', start: 0, end: 10 } };
  await store.applyProposal(
    proposal(
      [
        {
          op: 'upsert_page',
          page: synthesisDraft('force-notes', ['src-notes', 'src-extra'], { claims: [claim('clm_fact', 'Force changes momentum', { kind: 'source_fact', citations: [citation] })] }),
        },
      ],
      { 'force-notes': null },
    ),
  );
  await store.eraseSource('src-extra');

  const report = await service.report();
  const missingSource = byKind(report.findings, 'missing_source').find((finding) => finding.pageIds.includes('force-notes'));
  const missingCitation = byKind(report.findings, 'missing_citation').find((finding) => finding.pageIds.includes('force-notes'));
  assert.ok(missingSource, 'the sourceIds reference is reported');
  assert.ok(missingCitation, 'the claim citation is reported');

  const filed = await service.fileProposal([missingSource!.id, missingCitation!.id]);
  assert.ok(filed.proposalId);
  // Nothing changed yet — the proposal waits in the queue.
  const before = await store.readPage('force-notes');
  assert.equal(before?.metadata?.sourceIds.length, 2);

  await compiler.accept(filed.proposalId!, 'student');
  const after = await store.readPage('force-notes');
  assert.deepEqual(after?.metadata?.sourceIds, ['src-notes'], 'the erased source is off the page');
  assert.equal(after?.metadata?.claims.length, 0, 'the claim left without evidence went with it');
  const next = await service.report();
  assert.equal(byKind(next.findings, 'missing_source').length, 0);
  assert.equal(byKind(next.findings, 'missing_citation').length, 0);
});

test('a dead link is found, previewed as a removal, and removed only on accept', async () => {
  const { service, compiler, store } = await harness('dead-link');
  await store.applyProposal(
    proposal([{ op: 'upsert_page', page: conceptDraft('momentum', { courseRefs: [], links: [link('ghost-page')] }) }], { momentum: null }),
  );

  const report = await service.report();
  const dead = byKind(report.findings, 'dead_link').find((finding) => finding.pageIds.includes('momentum'));
  assert.ok(dead);
  assert.match(dead.detail, /ghost-page/);

  const filed = await service.fileProposal([dead!.id]);
  assert.ok(filed.proposalId);
  const preview = await compiler.preview(filed.proposalId!);
  assert.equal(preview?.pages[0]?.removedLinks.length, 1, 'the preview shows the link coming off');
  assert.equal(preview?.pages[0]?.removedLinks[0]?.toPageId, 'ghost-page');

  // A pending proposal changes nothing until the student says so.
  assert.equal((await store.readPage('momentum'))?.metadata?.links.length, 1);
  await compiler.accept(filed.proposalId!, 'student');
  assert.equal((await store.readPage('momentum'))?.metadata?.links.length, 0);
});

test('a page file written by hand is unindexed until the catalogue rebuild runs', async () => {
  const { service, store } = await harness('unindexed');
  const content = pageContent(
    {
      schemaVersion: CONTRACT_VERSION,
      id: 'handmade',
      kind: 'concept',
      state: 'committed',
      title: 'Handmade page',
      summary: 'Written in Obsidian, not by the keeper.',
      updatedAt: T0,
      courseRefs: [],
      claims: [],
      links: [],
      learner: { inMyWords: 'Mine.', stuck: '', connections: '', evidenceIds: [] },
      sourceIds: [],
      provenance: null,
    },
    '# Handmade\n',
  );
  await writeFile(path.join(store.root, 'concepts', 'handmade.md'), serializePageFile(content));

  const report = await service.report();
  const unindexed = byKind(report.findings, 'unindexed').find((finding) => finding.pageIds.includes('handmade'));
  assert.ok(unindexed, 'the hand-written file is missing from index.md');
  assert.equal(unindexed.action.kind, 'rebuild_catalogue');

  // Catalogue findings do not file proposals — they run the journaled rebuild.
  const filed = await service.fileProposal([unindexed.id]);
  assert.equal(filed.proposalId, null);
  assert.match(filed.skipped[0]?.reason ?? '', /Rebuild the index/i);

  const repaired = await service.repairCatalogue();
  assert.equal(repaired.changed, true);
  const next = await service.report();
  assert.equal(byKind(next.findings, 'unindexed').length, 0);
  assert.match((await store.readIndex()) ?? '', /\[\[handmade\|Handmade page\]\]/);
});

test('a manual edit flags revision_drift, and a stale maintenance proposal is refused', async () => {
  const { service, compiler, store } = await harness('drift');
  await store.applyProposal(proposal([{ op: 'upsert_page', page: conceptDraft('momentum', { courseRefs: [], links: [link('ghost')] }) }], { momentum: null }));

  const dead = byKind((await service.report()).findings, 'dead_link')[0]!;
  const filed = await service.fileProposal([dead.id]);
  assert.ok(filed.proposalId);

  // The student edits the file directly — the proposal prepared against the old revision must not land.
  const file = path.join(store.root, 'concepts', 'momentum.md');
  await writeFile(file, `${await readFile(file, 'utf8')}\nI changed my mind about this.\n`);

  const report = await service.report();
  const drift = byKind(report.findings, 'revision_drift').find((finding) => finding.pageIds.includes('momentum'));
  assert.ok(drift, 'the out-of-band edit is reported');
  assert.equal(drift.action.kind, 'repair_page');

  await assert.rejects(compiler.accept(filed.proposalId!, 'student'), VaultConflictError, 'a stale proposal refuses, writes nothing');
  assert.equal((await store.readPage('momentum'))?.state, 'out_of_band');

  // Adopting the drift keeps the student's on-disk words and clears the finding.
  const adopted = await service.fileProposal([drift.id]);
  assert.ok(adopted.proposalId);
  await compiler.accept(adopted.proposalId!, 'student');
  const page = await store.readPage('momentum');
  assert.equal(page?.state, 'ok');
  assert.match(page?.body ?? '', /changed my mind/);
});

test('a course mapping that disagrees with the sky is found and re-derived, never guessed', async () => {
  const { service, compiler, store } = await harness('mapping', { lessons: [lesson()] });
  await store.applyProposal(
    proposal(
      [{ op: 'upsert_page', page: conceptDraft('momentum', { courseRefs: [{ programmeId: 'bsc-physics', courseId: 'wrong-course', conceptKey: 'momentum' }] }) }],
      { momentum: null },
    ),
  );

  const report = await service.report();
  const bad = byKind(report.findings, 'bad_mapping').find((finding) => finding.pageIds.includes('momentum'));
  assert.ok(bad);
  assert.match(bad.detail, /phys-1/);

  const filed = await service.fileProposal([bad!.id]);
  assert.ok(filed.proposalId);
  await compiler.accept(filed.proposalId!, 'student');
  const refs = (await store.readPage('momentum'))?.metadata?.courseRefs ?? [];
  assert.deepEqual(
    refs.map((ref) => [ref.courseId, ref.conceptKey, ref.lessonId]),
    [['phys-1', 'momentum', 'lesson-momentum']],
    'courseRefs are recomputed from the installed course graph',
  );
});

test('an oversized page and an earlier-format page are both found', async () => {
  const { service, store } = await harness('shape');
  await store.applyProposal(
    proposal([{ op: 'upsert_page', page: conceptDraft('huge-page', { courseRefs: [], markdown: `# Huge\n\n${'filled prose. '.repeat(2000)}` }) }], { 'huge-page': null }),
  );
  await writeLegacyVault(store.root, { pages: [legacyPage('legacy-page', { links: [] })] });

  const report = await service.report();
  assert.ok(byKind(report.findings, 'oversized').some((finding) => finding.pageIds.includes('huge-page')));
  const schema = byKind(report.findings, 'schema_issue').find((finding) => finding.pageIds.includes('legacy-page'));
  assert.ok(schema);
  assert.equal(schema.action.kind, 'repair_page');
});

test('the semantic review validates every reference, cites both sides, and persists until the pages move', async () => {
  const draft: SemanticReviewDraft = {
    contradictions: [
      { pageId: 'page-a', claimId: 'clm_a', otherPageId: 'page-b', otherClaimId: 'clm_b', why: 'One says conserved, the other says not.' },
      { pageId: 'page-a', claimId: 'clm_invented', otherPageId: 'page-b', otherClaimId: 'clm_b', why: 'made up' },
    ],
    staleClaims: [{ pageId: 'page-a', claimId: 'clm_old', supersededBy: 'clm_a', why: 'The newer claim says it better.' }],
    connections: [
      { fromPageId: 'page-a', toPageId: 'page-b', type: 'contrasts_with', why: 'They disagree on conservation.' },
      { fromPageId: 'page-a', toPageId: 'nowhere', type: 'related_to', why: 'invented target' },
    ],
    questions: [{ pageId: 'page-a', question: 'When is momentum not conserved?' }],
  };
  const { service, store } = await harness('semantic', { propose: async () => draft });
  await store.applyProposal(
    proposal(
      [
        { op: 'upsert_page', page: conceptDraft('page-a', { courseRefs: [], claims: [claim('clm_a', 'Momentum is conserved'), claim('clm_old', 'Momentum was unclear')] }) },
        { op: 'upsert_page', page: conceptDraft('page-b', { courseRefs: [], claims: [claim('clm_b', 'Momentum is not conserved')] }) },
      ],
      { 'page-a': null, 'page-b': null },
    ),
  );

  const result = await service.review();
  assert.equal(result.pagesReviewed > 0, true);
  assert.equal(result.dropped.length, 2, 'invented references are dropped with reasons, never silently fixed');

  const contradiction = byKind(result.findings, 'contradiction')[0];
  assert.ok(contradiction);
  // Both sides of a contradiction are cited.
  assert.deepEqual(
    contradiction.evidence.map((ev) => [ev.pageId, ev.claimId]).sort(),
    [
      ['page-a', 'clm_a'],
      ['page-b', 'clm_b'],
    ],
  );
  assert.equal(contradiction.action.kind, 'repair_page');

  assert.ok(byKind(result.findings, 'stale_claim')[0]);
  assert.ok(byKind(result.findings, 'missing_connection')[0]);
  const question = byKind(result.findings, 'open_question')[0];
  assert.ok(question);

  // The findings persist in the report until their pages move or the student dismisses them.
  const report = await service.report();
  assert.equal(report.semantic.state, 'ran');
  assert.ok(byKind(report.findings, 'contradiction').length > 0, 'stored suggestions reappear in the live report');

  const dismissed = await service.dismiss(question!.id);
  assert.ok(!dismissed.findings.some((finding) => finding.id === question!.id), 'a dismissed suggestion does not resurface');
  assert.equal(dismissed.dismissed, 1);

  // A manual page change invalidates the stored semantic findings rather than leaving them stale.
  const pageA = path.join(store.root, 'concepts', 'page-a.md');
  await writeFile(pageA, `${await readFile(pageA, 'utf8')}\nNew paragraph.\n`);
  const afterEdit = await service.report();
  assert.equal(byKind(afterEdit.findings, 'contradiction').length, 0, 'the contradiction finding goes stale with the page');
});

test('an accepted contradiction proposal disputes both claims', async () => {
  const { service, compiler, store } = await harness('dispute', {
    propose: async () => ({
      contradictions: [{ pageId: 'page-a', claimId: 'clm_a', otherPageId: 'page-b', otherClaimId: 'clm_b', why: 'They disagree.' }],
      staleClaims: [],
      connections: [],
      questions: [],
    }),
  });
  await store.applyProposal(
    proposal(
      [
        { op: 'upsert_page', page: conceptDraft('page-a', { courseRefs: [], claims: [claim('clm_a', 'Momentum is conserved')] }) },
        { op: 'upsert_page', page: conceptDraft('page-b', { courseRefs: [], claims: [claim('clm_b', 'Momentum is not conserved')] }) },
      ],
      { 'page-a': null, 'page-b': null },
    ),
  );

  // The stubbed review's finding is stored; the report serves it like a live one.
  await service.review();
  const report = await service.report();
  const contradiction = byKind(report.findings, 'contradiction')[0];
  assert.ok(contradiction, 'the stubbed review stored the finding');

  const filed = await service.fileProposal([contradiction.id]);
  assert.ok(filed.proposalId);
  await compiler.accept(filed.proposalId!, 'student');

  const statusOf = (page: NonNullable<Awaited<ReturnType<WikiStore['readPage']>>>, claimId: string) => page.metadata?.claims.find((c) => c.id === claimId)?.status;
  const a = await store.readPage('page-a');
  const b = await store.readPage('page-b');
  assert.equal(statusOf(a!, 'clm_a'), 'disputed');
  assert.equal(statusOf(b!, 'clm_b'), 'disputed');
});

test('a superseded claim and a suggested connection land through the proposal path', async () => {
  const { service, compiler, store } = await harness('supersede', {
    propose: async () => ({
      contradictions: [],
      staleClaims: [{ pageId: 'page-a', claimId: 'clm_old', supersededBy: 'clm_new', why: 'The newer claim replaces it.' }],
      connections: [{ fromPageId: 'page-a', toPageId: 'page-b', type: 'related_to', why: 'Same idea.' }],
      questions: [],
    }),
  });
  await store.applyProposal(
    proposal(
      [
        { op: 'upsert_page', page: conceptDraft('page-a', { courseRefs: [], claims: [claim('clm_old', 'Momentum is mass'), claim('clm_new', 'Momentum is mass times velocity')] }) },
        { op: 'upsert_page', page: conceptDraft('page-b', { courseRefs: [] }) },
      ],
      { 'page-a': null, 'page-b': null },
    ),
  );

  const result = await service.review();
  const filed = await service.fileProposal(result.findings.map((finding) => finding.id));
  assert.ok(filed.proposalId);
  const record = await readProposalRecord(store.root, filed.proposalId!);
  assert.equal(record?.state, 'pending');
  assert.equal(record?.jobId, null, 'maintenance proposals carry no job');

  await compiler.accept(filed.proposalId!, 'student');
  const a = await store.readPage('page-a');
  const stale = a?.metadata?.claims.find((c) => c.id === 'clm_old');
  const current = a?.metadata?.claims.find((c) => c.id === 'clm_new');
  assert.equal(stale?.status, 'superseded');
  assert.deepEqual(current?.supersedes, ['clm_old'], 'the standing claim records what it replaced');
  assert.equal(a?.metadata?.links.some((l) => l.toPageId === 'page-b' && l.type === 'related_to'), true);

  // The reported findings that produced them are gone — the vault no longer shows the issue.
  const report = await service.report();
  assert.equal(report.findings.length, 0);
});

test('dismissed structural findings stay dismissed until the underlying issue changes', async () => {
  const { service, store } = await harness('dismissed');
  await store.applyProposal(proposal([{ op: 'upsert_page', page: conceptDraft('lone', { courseRefs: [] }) }], { lone: null }));

  const orphan = byKind((await service.report()).findings, 'orphan')[0]!;
  const report = await service.dismiss(orphan.id, 'I am keeping this page separate on purpose');
  assert.equal(report.findings.length, 0);
  assert.equal(report.dismissed, 1);
  // A re-run does not resurrect it — the id is stable on the same issue.
  assert.equal((await service.report()).findings.length, 0);
});
