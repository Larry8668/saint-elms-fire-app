import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, readdir, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { readManifest, VaultManifestSchema } from './vault-manifest';
import { VaultConflictError, VaultIntegrityError, VaultPathError, VaultSchemaError } from './vault-errors';
import { conceptDraft, proposal, sourceFixture, synthesisDraft, tempRoot, T0, vault } from './testing/fixtures';
import { WikiStore } from './wiki-store';
import { readPageFile, serializePageFile, pageContent } from './wiki-page-format';
import { BrainVault } from './vault';

process.env.ENGINE_DATA_DIR = await mkdtemp(path.join(tmpdir(), 'sef-wiki-store-'));

const exists = async (file: string) => stat(file).then(() => true, () => false);

test('init lays out the agreed vault: raw, sources, concepts, syntheses, questions, index, log, schema, history and meta', async () => {
  const store = await vault('layout');
  for (const relative of ['raw', 'sources', 'concepts', 'syntheses', 'questions', 'index.md', 'log.md', 'SCHEMA.md', '.history', '.meta', '.meta/jobs', '.meta/journal', '.meta/recovery']) {
    assert.equal(await exists(path.join(store.root, relative)), true, `${relative} should exist`);
  }
  const status = await store.status();
  assert.equal(status.layout, 2);
  assert.equal(status.pages, 0);
  assert.equal(status.manifestIntegrity, 'missing');
  assert.equal(status.pendingCommits, 0);
  assert.match((await store.readIndex()) ?? '', /^# Index/);
});

test('one proposal commits pages, index, log and manifest together', async () => {
  const store = await vault('commit');
  const report = await store.applyProposal(
    proposal([{ op: 'upsert_page', page: conceptDraft('newton-second-law') }, { op: 'upsert_page', page: synthesisDraft('force-synthesis', ['source-openstax']) }], {
      'newton-second-law': null,
      'force-synthesis': null,
    }),
  );

  assert.equal(report.committed, true);
  assert.deepEqual(report.pages.map((page) => [page.id, page.change]).sort(), [
    ['force-synthesis', 'created'],
    ['newton-second-law', 'created'],
  ]);
  assert.equal(await exists(path.join(store.root, 'concepts/newton-second-law.md')), true);
  assert.equal(await exists(path.join(store.root, 'syntheses/force-synthesis.md')), true);

  const concept = await store.readPage('newton-second-law');
  assert.equal(concept?.state, 'ok');
  assert.equal(concept?.format, 2);
  assert.equal(concept?.metadata?.kind, 'concept');
  assert.equal(concept?.metadata?.learner?.inMyWords, 'Force changes momentum.');

  const index = (await store.readIndex()) ?? '';
  assert.match(index, /\[\[newton-second-law\|Concept newton-second-law\]\]/);
  assert.match(index, /\[\[force-synthesis\|Synthesis force-synthesis\]\]/);
  assert.match(index, /sources: source-openstax/);

  const log = await store.readLog();
  assert.equal(log[0]?.kind, 'wiki');
  assert.match(log[0]?.title ?? '', /proposal-1/);

  const manifest = (await readManifest(store.root)).manifest;
  assert.equal(manifest?.pages['newton-second-law']?.revision, concept?.metadata?.revision);
  assert.equal(manifest?.pages['force-synthesis']?.kind, 'synthesis');
  assert.equal(VaultManifestSchema.safeParse(manifest).success, true);
});

test('the log keeps the earlier keeper\u2019s format, so both readers see the same timeline', async () => {
  const store = await vault('log');
  await store.applyProposal(proposal([{ op: 'upsert_page', page: conceptDraft('damping') }], { damping: null }));
  await store.appendLog({ kind: 'lint', title: 'Two open misconceptions' });

  const legacy = new BrainVault(store.root);
  const seen = await legacy.readLog();
  assert.deepEqual(seen.map((entry) => entry.kind), ['lint', 'wiki']);
  assert.equal(seen[1]?.title, 'Wiki update from proposal proposal-1');
});

test('a proposal whose base revision is stale is refused, and nothing is written', async () => {
  const store = await vault('stale');
  await store.applyProposal(proposal([{ op: 'upsert_page', page: conceptDraft('damping') }], { damping: null }));
  const before = await readFile(path.join(store.root, 'concepts/damping.md'), 'utf8');
  const indexBefore = await store.readIndex();

  const committed = (await readManifest(store.root)).manifest?.pages.damping?.revision ?? '';
  await assert.rejects(
    () => store.applyProposal(proposal([{ op: 'upsert_page', page: conceptDraft('damping', { summary: 'Rewritten.' }) }], { damping: 'rev-0000000000' })),
    (error: unknown) => {
      assert.equal(error instanceof VaultConflictError, true);
      assert.deepEqual((error as VaultConflictError).details, [{ id: 'damping', expected: 'rev-0000000000', found: committed, reason: 'revision_changed' }]);
      return true;
    },
  );
  assert.equal(committed.startsWith('rev-'), true);

  assert.equal(await readFile(path.join(store.root, 'concepts/damping.md'), 'utf8'), before, 'the page is untouched');
  assert.equal(await store.readIndex(), indexBefore, 'the index is untouched');
});

test('a page created outside the keeper is detected rather than trusted to a cache', async () => {
  const store = await vault('out-of-band');
  await store.applyProposal(proposal([{ op: 'upsert_page', page: conceptDraft('damping') }], { damping: null }));
  const committed = await store.readPage('damping');
  assert.equal(committed?.state, 'ok');

  await writeFile(path.join(store.root, 'concepts/damping.md'), `${committed?.raw.replace('Force changes momentum.', 'Someone else rewrote this.')}`, 'utf8');

  const reread = await store.readPage('damping');
  assert.equal(reread?.state, 'out_of_band');
  assert.match(reread?.revision ?? '', /^file-/);
  assert.match(reread?.issue ?? '', /outside the keeper/);

  await assert.rejects(
    () => store.applyProposal(proposal([{ op: 'upsert_page', page: conceptDraft('damping', { summary: 'Mine again.' }) }], { damping: committed?.revision ?? '' })),
    (error: unknown) => error instanceof VaultConflictError && (error as VaultConflictError).details[0]?.reason === 'out_of_band',
  );
  assert.match(await readFile(path.join(store.root, 'concepts/damping.md'), 'utf8'), /Someone else rewrote this\./, 'the external edit survives');

  // Adopting what is on disk is explicit: the caller must have read the file's current revision.
  const adopted = await store.applyProposal(proposal([{ op: 'upsert_page', page: conceptDraft('damping', { summary: 'Mine again.' }) }], { damping: reread?.revision ?? '' }));
  assert.equal(adopted.committed, true);
  const settled = await store.readPage('damping');
  assert.equal(settled?.state, 'ok');
  assert.equal(settled?.metadata?.summary, 'Mine again.');
  const history = await readdir(path.join(store.root, '.history/concepts/damping'));
  assert.deepEqual(history, [`${reread?.revision}.md`], 'the external edit is snapshotted under the revision it had on disk');
  assert.match(await readFile(path.join(store.root, '.history/concepts/damping', history[0] ?? ''), 'utf8'), /Someone else rewrote this\./);
});

test('a whitespace-only edit is still caught, through the manifest', async () => {
  const store = await vault('whitespace');
  await store.applyProposal(proposal([{ op: 'upsert_page', page: conceptDraft('damping') }], { damping: null }));
  const file = path.join(store.root, 'concepts/damping.md');
  await writeFile(file, `${(await readFile(file, 'utf8')).trimEnd()}\n\n`, 'utf8');

  const reread = await store.readPage('damping');
  assert.equal(reread?.state, 'out_of_band', 'the file no longer matches the revision the keeper recorded');
});

test('malformed frontmatter is rejected safely: readable, flagged, and not overwritten', async () => {
  const store = await vault('malformed');
  const file = path.join(store.root, 'concepts/broken.md');
  await writeFile(file, '---\nid: broken\nkind: concept\n---\nhand edited\n', 'utf8');

  const snapshot = await store.readPage('broken');
  assert.equal(snapshot?.state, 'malformed');
  assert.equal(snapshot?.metadata, null);
  assert.match(snapshot?.issue ?? '', /legacy page key/);
  assert.equal((await store.listPages()).length, 1);

  await assert.rejects(
    () => store.applyProposal(proposal([{ op: 'upsert_page', page: conceptDraft('broken') }], { broken: snapshot?.revision ?? '' })),
    (error: unknown) => error instanceof VaultConflictError && (error as VaultConflictError).details[0]?.reason === 'malformed',
  );
  assert.equal(await readFile(file, 'utf8'), '---\nid: broken\nkind: concept\n---\nhand edited\n', 'a malformed page is never silently replaced');
});

test('a page from a newer engine is read, never downgraded', async () => {
  const store = await vault('newer');
  const newer = pageContent(
    {
      schemaVersion: 2,
      id: 'future',
      kind: 'concept',
      state: 'committed',
      title: 'From the future',
      summary: 'Written by a newer engine.',
      updatedAt: T0,
      courseRefs: [],
      claims: [],
      links: [],
      learner: { inMyWords: 'x', stuck: '', connections: '', evidenceIds: [] },
      sourceIds: [],
      provenance: null,
    },
    'body',
  );
  const file = path.join(store.root, 'concepts/future.md');
  await writeFile(file, serializePageFile(newer).replace('schemaVersion: 2', 'schemaVersion: 3'), 'utf8');

  const snapshot = await store.readPage('future');
  assert.equal(snapshot?.state, 'newer_schema');
  assert.match(snapshot?.issue ?? '', /newer engine/);
  await assert.rejects(
    () => store.applyProposal(proposal([{ op: 'upsert_page', page: conceptDraft('future') }], { future: snapshot?.revision ?? '' })),
    (error: unknown) => error instanceof VaultConflictError && (error as VaultConflictError).details[0]?.reason === 'newer_schema',
  );
  await assert.rejects(() => store.removePage('future', snapshot?.revision ?? ''), VaultSchemaError);
  assert.match(await readFile(file, 'utf8'), /schemaVersion: 3/, 'the newer page is left alone');
});

test('a newer manifest blocks writes instead of being overwritten', async () => {
  const store = await vault('manifest-newer');
  await writeFile(path.join(store.root, '.meta/manifest.json'), JSON.stringify({ schemaVersion: 3, updatedAt: T0, pages: {}, sources: {} }), 'utf8');
  await assert.rejects(() => store.applyProposal(proposal([{ op: 'upsert_page', page: conceptDraft('damping') }], { damping: null })), VaultSchemaError);
  const { record, bytes } = sourceFixture('source-note', 'notes');
  await assert.rejects(() => store.putSource(record, bytes), VaultSchemaError);
  assert.equal((await store.status()).manifestIntegrity, 'newer_schema');
});

test('source originals are frozen: exclusive, verified, and untouched by page commits', async () => {
  const store = await vault('sources');
  const { record, bytes } = sourceFixture('source-note', 'Transcribed note: F = dp/dt');
  const written = await store.putSource(record, bytes);
  assert.equal(written.alreadyPresent, false);
  assert.equal(await exists(path.join(store.root, 'raw/source-note/rev-1.markdown')), true);
  assert.deepEqual(await store.readSourceBytes('source-note'), bytes);
  assert.deepEqual(await store.readSource('source-note'), record);

  const frozen = await readFile(path.join(store.root, 'raw/source-note/rev-1.markdown'));
  await assert.rejects(
    () => store.putSource(record, Buffer.from('different snapshot', 'utf8')),
    VaultIntegrityError,
    'bytes that do not match the declared hash are refused',
  );
  const other = sourceFixture('source-note', 'Transcribed note: F = ma');
  await assert.rejects(() => store.putSource(other.record, other.bytes), VaultConflictError, 'a revision is written once');
  assert.deepEqual(await readFile(path.join(store.root, 'raw/source-note/rev-1.markdown')), frozen, 'the original is intact');

  const again = await store.putSource(record, bytes);
  assert.equal(again.alreadyPresent, true, 're-freezing the same bytes is a no-op');

  await store.applyProposal(proposal([{ op: 'upsert_page', page: conceptDraft('damping') }], { damping: null }));
  assert.equal(await store.upgradeLegacyPage('missing-page'), null, 'a missing page is not invented');
  assert.deepEqual(await readFile(path.join(store.root, 'raw/source-note/rev-1.markdown')), frozen, 'no keeper path rewrites an original');
  assert.deepEqual((await readdir(path.join(store.root, 'raw'))).sort(), ['source-note']);
});

test('a corrupted original is reported rather than returned', async () => {
  const store = await vault('corrupt');
  const { record, bytes } = sourceFixture('source-note', 'notes');
  await store.putSource(record, bytes);
  await writeFile(path.join(store.root, 'raw/source-note/rev-1.markdown'), 'tampered', 'utf8');
  await assert.rejects(() => store.readSourceBytes('source-note'), VaultIntegrityError);
});

test('identifiers that would escape the vault are refused everywhere', async () => {
  const store = await vault('traversal');
  for (const id of ['../../etc/passwd', '..', '.meta', 'concepts/x', '']) {
    await assert.rejects(() => store.readPage(id), VaultPathError, `readPage(${JSON.stringify(id)})`);
    await assert.rejects(() => store.removePage(id, 'rev-1'), VaultPathError, `removePage(${JSON.stringify(id)})`);
    await assert.rejects(() => store.readSource(id), VaultPathError, `readSource(${JSON.stringify(id)})`);
    await assert.rejects(() => store.eraseSource(id), VaultPathError, `eraseSource(${JSON.stringify(id)})`);
  }
  assert.equal(await exists(path.join(store.root, '..', 'etc')), false);
});

test('the student can remove a page and erase a source; the keeper cannot', async () => {
  const store = await vault('erasure');
  const { record, bytes } = sourceFixture('source-note', 'notes');
  await store.putSource(record, bytes);
  await store.applyProposal(proposal([{ op: 'upsert_page', page: conceptDraft('damping') }], { damping: null }));
  const page = await store.readPage('damping');

  await assert.rejects(() => store.removePage('damping', 'rev-wrong'), VaultConflictError);
  const removed = await store.removePage('damping', page?.revision ?? '');
  assert.equal(removed.removed, true);
  assert.equal(await exists(path.join(store.root, 'concepts/damping.md')), false);
  const history = await readdir(path.join(store.root, '.history/concepts/damping'));
  assert.deepEqual(history, [`${page?.revision}.md`], 'the last revision is kept');

  const index = (await store.readIndex()) ?? '';
  assert.doesNotMatch(index, /damping/);
  assert.equal((await readManifest(store.root)).manifest?.pages.damping, undefined);
  assert.equal((await store.readLog())[0]?.kind, 'remove');

  assert.equal((await store.eraseSource('source-note')).erased, true);
  assert.equal(await exists(path.join(store.root, 'raw/source-note/rev-1.markdown')), false);
  assert.equal(await store.readSource('source-note'), null);
  assert.deepEqual(await store.listSources(), {});
});

test('a proposal cannot smuggle an unevidenced student link in, and the vault keeps the student\u2019s own links', async () => {
  const store = await vault('links');
  const first = await store.applyProposal(proposal([{ op: 'upsert_page', page: conceptDraft('momentum') }], { momentum: null }));
  assert.equal(first.committed, true);
  const momentum = await store.readPage('momentum');

  await store.applyProposal(proposal([{ op: 'upsert_page', page: conceptDraft('force') }], { force: null }));
  const force = await store.readPage('force');
  const linked = await store.applyProposal(
    proposal(
      [
        {
          op: 'add_link',
          fromPageId: 'force',
          link: { toPageId: 'momentum', type: 'builds_upon', origin: 'suggested', why: 'Momentum follows from force.', citations: [] },
        },
      ],
      { force: force?.revision ?? '' },
    ),
  );
  assert.equal(linked.committed, true);
  assert.equal((await store.readPage('force'))?.metadata?.links.length, 1);
  assert.equal(momentum?.metadata?.links.length, 0, 'a link is recorded on the page that made it');

  const replay = await store.applyProposal(
    proposal(
      [
        {
          op: 'add_link',
          fromPageId: 'force',
          link: { toPageId: 'momentum', type: 'builds_upon', origin: 'suggested', why: 'Momentum follows from force.', citations: [] },
        },
      ],
      { force: linked.pages[0]?.revisionAfter ?? '' },
    ),
  );
  assert.equal(replay.committed, false, 'an operation that changes nothing is not a commit');
  assert.deepEqual(replay.pages.map((page) => [page.id, page.change]), [['force', 'unchanged']], 'and it is reported as unchanged');
  assert.equal((await store.readPage('force'))?.metadata?.links.length, 1);
});

test('conventions are read from the vault and a proposal prepared against an older revision is refused', async () => {
  const store = await vault('conventions');
  const conventions = await store.readConventions();
  assert.equal(conventions.source, 'vault');
  assert.equal(conventions.conventions.revision, 'conventions-v2');

  await assert.rejects(
    () => store.applyProposal(proposal([{ op: 'upsert_page', page: conceptDraft('damping') }], { damping: null }, { conventionRevision: 'conventions-v1' })),
    (error: unknown) => error instanceof VaultConflictError && (error as VaultConflictError).details[0]?.reason === 'conventions_changed',
  );

  const schema = await readFile(path.join(store.root, 'SCHEMA.md'), 'utf8');
  await writeFile(path.join(store.root, 'SCHEMA.md'), schema.replace('"revision": "conventions-v2"', '"revision": "conventions-v3"'), 'utf8');
  assert.equal((await store.readConventions()).conventions.revision, 'conventions-v3');
  await assert.rejects(
    () => store.applyProposal(proposal([{ op: 'upsert_page', page: conceptDraft('damping') }], { damping: null })),
    VaultConflictError,
    'a proposal prepared against the old conventions is stale',
  );
  await store.applyProposal(proposal([{ op: 'upsert_page', page: conceptDraft('damping') }], { damping: null }, { conventionRevision: 'conventions-v3' }));
  assert.equal((await store.readPage('damping'))?.state, 'ok');
});

test('jobs live under .meta/jobs and are read back only when they match their contract', async () => {
  const store = await vault('jobs');
  await store.writeJob({
    schemaVersion: 2,
    id: 'job-1',
    profile: { issuer: 'https://uni.example.test', studentId: 'student-a', programmeId: 'bsc-physics' },
    sourceIds: ['source-note'],
    createdAt: T0,
    updatedAt: T0,
    stage: 'queued',
    progress: { completed: 0, total: 1 },
    proposalId: null,
    error: null,
  });
  assert.equal((await store.readJob('job-1'))?.stage, 'queued');
  assert.equal((await store.listJobs()).length, 1);

  await mkdir(path.join(store.root, '.meta/jobs'), { recursive: true });
  await writeFile(path.join(store.root, '.meta/jobs/job-2.json'), JSON.stringify({ id: 'job-2' }), 'utf8');
  assert.equal(await store.readJob('job-2'), null, 'a job that does not match the contract is not returned');
});

test('two stores on the same root see each other\u2019s pages (nothing is cached)', async () => {
  const root = await tempRoot('two-stores');
  const first = new WikiStore(root, { now: () => new Date(T0) });
  const second = new WikiStore(root, { now: () => new Date(T0) });
  await first.init();
  await first.applyProposal(proposal([{ op: 'upsert_page', page: conceptDraft('damping') }], { damping: null }));
  assert.equal((await second.readPage('damping'))?.metadata?.summary, 'What damping says in one line.');
  assert.equal(readPageFile(await readFile(path.join(root, 'concepts/damping.md'), 'utf8')).format, 2);
});
