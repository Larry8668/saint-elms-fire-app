import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { CONTRACT_VERSION, SourceRecordSchema, VAULT_EXPORT_KIND, VAULT_EXPORT_VERSION, type SourceRecord, type VaultExport } from '@sef/shared';
import { sha256Hex } from '../../lib/hash';
import { readManifest } from '../vault-manifest';
import { VaultConflictError } from '../vault-errors';
import { conceptDraft, PROFILE, proposal, sourceFixture, T0, vault } from '../testing/fixtures';
import type { WikiStore } from '../wiki-store';
import { pageContent, serializePageFile } from '../wiki-page-format';
import { parseArchive, VaultImportError } from './archive';
import { VaultPortabilityService } from './service';

process.env.ENGINE_DATA_DIR = await mkdtemp(path.join(tmpdir(), 'sef-portable-'));

const exists = async (file: string) => stat(file).then(() => true, () => false);
const portable = (store: WikiStore) => new VaultPortabilityService(store, { identity: async () => PROFILE });

/** A peer-shared source record, as a prior share acceptance would have filed it. */
const peerFixture = (id: string, text: string): { record: SourceRecord; bytes: Buffer } => {
  const { record, bytes } = sourceFixture(id, text);
  return {
    bytes,
    record: SourceRecordSchema.parse({
      ...record,
      kind: 'peer',
      origin: 'peer',
      share: { id: 'share-1', revision: 'rev-1', senderId: 'student-b', cohortId: 'cohort-a' },
    }),
  };
};

/**
 * A vault worth carrying: two committed revisions of one concept (so .history/ holds the
 * first), a note source with a stored extraction, a peer source, and — when `erase` is set —
 * one erased source so its tombstone travels too.
 */
async function seededVault(prefix: string, opts: { erase?: boolean } = {}) {
  const store = await vault(prefix);
  await store.applyProposal(proposal([{ op: 'upsert_page', page: conceptDraft('damping', { markdown: 'First body.' }) }], { damping: null }));
  const first = await store.readPage('damping');
  await store.applyProposal(
    proposal([{ op: 'upsert_page', page: conceptDraft('damping', { markdown: 'Second body.', id: 'damping' }) }], { damping: first?.revision ?? '' }),
  );
  const note = sourceFixture('note-1', 'My own notes on damping.');
  await store.putSource(note.record, note.bytes);
  await store.recordExtraction('note-1', { method: 'text', sha256: sha256Hex('My own notes on damping.'), chars: 25, partial: false }, 'My own notes on damping.');
  const peer = peerFixture('peer-doc', 'Shared reading from a classmate.');
  await store.putSource(peer.record, peer.bytes);
  if (opts.erase) {
    const stale = sourceFixture('old-note', 'Something I no longer keep.');
    await store.putSource(stale.record, stale.bytes);
    await store.eraseSource('old-note', stale.record.revision);
  }
  return store;
}

test('a full export round-trips pages, history, sources, events and tombstones byte-for-byte', async () => {
  const source = await seededVault('rt-src', { erase: true });
  const before = await source.readPage('damping');
  const archive = await portable(source).exportVault();

  assert.equal(archive.schemaVersion, VAULT_EXPORT_VERSION);
  assert.equal(archive.kind, VAULT_EXPORT_KIND);
  assert.equal(archive.exportedBy.studentId, PROFILE.studentId);
  assert.ok(archive.counts.pages >= 1);
  assert.ok(archive.counts.history >= 1, 'the first revision lives in .history/');
  assert.equal(archive.counts.sources, 2, 'note + peer records; the erased one is a tombstone, not a source');
  assert.ok(archive.counts.events >= 1, 'the growth ledger travels');
  assert.equal(archive.counts.tombstones, 1);
  assert.equal(archive.files.length, archive.counts.files);

  for (const file of archive.files) {
    assert.match(file.sha256, /^[0-9a-f]{64}$/);
    assert.ok(!file.path.startsWith('/') && !file.path.includes('..'), `${file.path} stays inside the vault`);
  }

  const destination = await vault('rt-dst');
  const service = portable(destination);
  const preview = await service.previewImport(archive);
  assert.equal(preview.state, 'ready');
  assert.equal(preview.conflicts.length, 0);
  assert.equal(preview.destination?.pages, 0);

  const result = await service.restore(archive);
  assert.equal(result.committed, true);
  assert.ok(result.journalId);

  const restored = await destination.readPage('damping');
  assert.equal(restored?.revision, before?.revision, 'the committed revision survives the move');
  assert.equal(restored?.raw, before?.raw, 'page bytes arrive verbatim');
  assert.equal(restored?.state, 'ok');

  const revisions = await destination.pageRevisions('damping');
  assert.equal(revisions?.revisions.length, 2, 'the earlier revision rides along under .history/');

  const note = await destination.readSource('note-1');
  assert.equal(note?.id, 'note-1');
  assert.equal(note?.extractions.length, 1, 'the extraction ledger travels');
  const peer = await destination.readSource('peer-doc');
  assert.equal(peer?.origin, 'peer', 'accepted peer provenance keeps its origin');
  assert.equal(peer?.kind, 'peer');
  assert.equal((await destination.readSourceBytes('peer-doc'))?.toString('utf8'), 'Shared reading from a classmate.');

  const events = await destination.listEvents();
  assert.ok(events.length >= 1, 'growth events restored');
  const tombstone = await readFile(path.join(destination.root, '.meta/tombstones/old-note.json'), 'utf8');
  assert.match(tombstone, /"erasedAt"/);
  assert.equal(await destination.readSource('old-note'), null, 'the tombstone does not resurrect the record');

  const manifest = (await readManifest(destination.root)).manifest;
  assert.equal(manifest?.pages['damping']?.revision, before?.revision);
  assert.match((await destination.readIndex()) ?? '', /\[\[damping\|/);
  const log = await readFile(path.join(destination.root, 'log.md'), 'utf8');
  assert.match(log, /Restored a vault export/);
});

test('the export carries only student-owned vault state — no credentials, in-flight or derived files', async () => {
  const store = await seededVault('excl-src');
  // Plant material that must never travel: a pending journal, a proposal, the writer lock,
  // and secret-looking blobs among them.
  await mkdir(path.join(store.root, '.meta/journal'), { recursive: true });
  await writeFile(path.join(store.root, '.meta/journal', 'half-committed.json'), JSON.stringify({ secret: 'entitlement-token-xyz' }));
  await mkdir(path.join(store.root, '.meta/proposals'), { recursive: true });
  await writeFile(path.join(store.root, '.meta/proposals', 'prop.json'), JSON.stringify({ apiKey: 'sk-live-key-123' }));
  await writeFile(path.join(store.root, 'writer.lock'), 'lock');
  await writeFile(path.join(store.root, 'concepts', '.hidden.md'), "unsafe name — still the student's bytes, listed as skipped");

  const archive = await portable(store).exportVault();
  const paths = archive.files.map((file) => file.path);
  for (const forbidden of ['index.md', 'SCHEMA.md', 'writer.lock', '.meta/manifest.json']) {
    assert.ok(!paths.includes(forbidden), `${forbidden} is derived or in-flight — never exported`);
  }
  for (const file of archive.files) {
    assert.ok(
      !file.path.startsWith('.meta/journal') && !file.path.startsWith('.meta/jobs') && !file.path.startsWith('.meta/proposals') && !file.path.startsWith('.meta/recovery'),
      `${file.path} is not vault-owned knowledge`,
    );
  }
  const serialized = JSON.stringify(archive);
  assert.ok(!serialized.includes('entitlement-token-xyz') && !serialized.includes('sk-live-key-123'), 'no credential material leaks into the export');
  assert.ok(archive.skipped.includes('concepts/.hidden.md'), 'an unsafe page name is listed, not silently dropped');
});

test('a restore refuses traversal, absolute paths and state outside the vault-owned areas', async () => {
  const source = await seededVault('safe-src');
  const archive = await portable(source).exportVault();

  for (const bad of ['../escape.md', 'concepts/../../etc/passwd', '/etc/passwd', '.meta/journal/forged.json', '.meta/manifest.json', 'settings.json']) {
    const tampered: VaultExport = JSON.parse(JSON.stringify(archive));
    tampered.files.push({ path: bad, sha256: sha256Hex('x'), bytes: 1, encoding: 'utf8', content: 'x' });
    const preview = await portable(await vault(`safe-dst-${bad.length}-${bad.charCodeAt(0)}`)).previewImport(tampered);
    assert.equal(preview.state, 'refused', `${bad} is refused`);
    assert.equal(preview.code, 'unsafe');
  }
});

test('a restore refuses archives from a newer writer, a broken envelope and a corrupt checksum', async () => {
  const destination = await vault('refused-dst');
  const source = await seededVault('refused-src');
  const archive = await portable(source).exportVault();

  const newer: VaultExport = JSON.parse(JSON.stringify(archive));
  (newer as { schemaVersion: number }).schemaVersion = VAULT_EXPORT_VERSION + 1;
  let preview = await portable(destination).previewImport(newer);
  assert.equal(preview.state, 'refused');
  assert.equal(preview.code, 'newer_schema');

  const newerLayout: VaultExport = JSON.parse(JSON.stringify(archive));
  (newerLayout as { layout: number }).layout = 99;
  preview = await portable(destination).previewImport(newerLayout);
  assert.equal(preview.state, 'refused');
  assert.equal(preview.code, 'newer_schema');

  for (const bad of [null, 'not an archive', { schemaVersion: VAULT_EXPORT_VERSION }, 42]) {
    preview = await portable(destination).previewImport(bad);
    assert.equal(preview.state, 'refused', `${JSON.stringify(bad)} is refused`);
    assert.equal(preview.code, 'malformed');
  }

  const corrupted: VaultExport = JSON.parse(JSON.stringify(archive));
  corrupted.files[0]!.content = `${corrupted.files[0]!.content}tampered`;
  preview = await portable(destination).previewImport(corrupted);
  assert.equal(preview.state, 'refused');
  assert.equal(preview.code, 'integrity');

  const duplicated: VaultExport = JSON.parse(JSON.stringify(archive));
  duplicated.files.push(JSON.parse(JSON.stringify(duplicated.files[0])));
  preview = await portable(destination).previewImport(duplicated);
  assert.equal(preview.state, 'refused');
  assert.equal(preview.code, 'malformed');
});

test('oversize archives are refused before planning', async () => {
  const source = await seededVault('big-src');
  const archive = await portable(source).exportVault();
  const tight = new VaultPortabilityService(await vault('big-dst'), { identity: async () => PROFILE, limits: { maxFileBytes: 4 } });
  const preview = await tight.previewImport(archive);
  assert.equal(preview.state, 'refused');
  assert.equal(preview.code, 'too_large');

  assert.throws(() => parseArchive({ ...archive, files: new Array(30_000).fill(archive.files[0]) }, { maxFiles: 10 }), VaultImportError);
});

test('a page the destination already owns is a conflict — preview is honest, restore waits for a choice', async () => {
  const source = await seededVault('conf-src');
  const archive = await portable(source).exportVault();

  const destination = await vault('conf-dst');
  await destination.applyProposal(proposal([{ op: 'upsert_page', page: conceptDraft('damping', { markdown: 'Destination work — keep this.' }) }], { damping: null }));
  const existing = await destination.readPage('damping');

  const service = portable(destination);
  const preview = await service.previewImport(archive);
  assert.equal(preview.state, 'conflicts');
  const conflict = preview.conflicts.find((entry) => entry.id === 'damping');
  assert.ok(conflict, 'the page difference is named');
  assert.equal(conflict.resolvable, true);
  assert.equal(conflict.existing, existing?.revision);
  assert.equal(conflict.reason, 'different_revision');

  // Restoring without a choice leaves the destination page untouched, and says so.
  const declined = await service.restore(archive);
  assert.equal((await destination.readPage('damping'))?.raw, existing?.raw);
  assert.equal(declined.conflicts.some((entry) => entry.id === 'damping'), true);

  // Choosing the overwrite preserves the live revision under .history/ before the imported
  // bytes take the path — the student's newer work is never the price of a restore.
  const accepted = await service.restore(archive, { overwritePageIds: ['damping'] });
  assert.equal(accepted.conflicts.length, 0);
  const restored = await destination.readPage('damping');
  assert.equal(restored?.raw, (await source.readPage('damping'))?.raw);
  assert.equal(restored?.state, 'ok');
  const revisions = await destination.pageRevisions('damping');
  assert.ok(revisions?.revisions.some((entry) => entry.revision === existing?.revision), 'the pre-restore revision is preserved');
});

test('commitRestore refuses a vault that moved since the plan was read — nothing is written', async () => {
  const store = await vault('drift');
  await store.applyProposal(proposal([{ op: 'upsert_page', page: conceptDraft('damping') }], { damping: null }));
  const snapshot = await store.readPage('damping');

  // The plan was computed while the page was absent; the vault disagrees now.
  await assert.rejects(
    () =>
      store.commitRestore('vault.restore:test', [{ kind: 'write', path: 'concepts/damping.md', content: 'stale imported bytes' }], {
        preconditions: [{ path: 'concepts/damping.md', sha256: null }],
      }),
    (error: unknown) => error instanceof VaultConflictError,
  );
  assert.equal((await store.readPage('damping'))?.raw, snapshot?.raw, 'the live page was not overwritten');

  // With the true sha the same step commits — the precondition is the lock, not the obstacle.
  const journalId = await store.commitRestore(
    'vault.restore:test',
    [{ kind: 'write', path: 'concepts/damping-copy.md', content: 'carried bytes' }],
    { preconditions: [{ path: 'concepts/damping.md', sha256: snapshot?.fileSha256 ?? '' }] },
  );
  assert.ok(journalId);
  assert.equal(await readFile(path.join(store.root, 'concepts/damping-copy.md'), 'utf8'), 'carried bytes');
});

test('a selected-source export names the bytes it left behind', async () => {
  const source = await seededVault('sel-src');
  const archive = await portable(source).exportVault({ sourceIds: ['note-1'] });
  const paths = archive.files.map((file) => file.path);
  assert.ok(paths.some((filePath) => filePath.startsWith('raw/note-1/')), 'the selected original travels');
  assert.ok(!paths.some((filePath) => filePath.startsWith('raw/peer-doc/')), 'the unselected original stays home');
  assert.ok(archive.skipped.some((filePath) => filePath.startsWith('raw/peer-doc/')), 'the omission is listed');
});

test('a minimal hand-built archive restores — the fixture drill', async () => {
  const destination = await vault('drill-dst');
  const content = pageContent(
    {
      schemaVersion: CONTRACT_VERSION,
      id: 'drill-page',
      kind: 'concept',
      title: 'Drill page',
      summary: 'Written into the fixture.',
      state: 'committed',
      updatedAt: T0,
      courseRefs: [],
      claims: [],
      links: [],
      learner: { inMyWords: 'Fixture words.', stuck: 'Nothing.', connections: 'None.', evidenceIds: [] },
      sourceIds: [],
      provenance: null,
    },
    '# Drill\n\nFixture body.\n',
  );
  const page = serializePageFile(content);
  const raw = Buffer.from('fixture original bytes');
  const record = SourceRecordSchema.parse({
    schemaVersion: CONTRACT_VERSION,
    id: 'fixture-source',
    profile: PROFILE,
    revision: 'rev-1',
    title: 'Fixture source',
    createdAt: T0,
    mediaType: 'text/plain',
    sha256: sha256Hex(raw),
    bytes: raw.length,
    attribution: {},
    extractions: [],
    kind: 'note',
    origin: 'student',
  });
  const event = {
    schemaVersion: CONTRACT_VERSION,
    id: 'evt_fixture',
    profile: PROFILE,
    pageId: 'drill-page',
    at: T0,
    kind: 'encounter',
    actor: 'student',
    evidence: [{ kind: 'revision', ref: content.metadata.revision }],
    note: 'fixture drill',
    knowledgeOnly: false,
  };
  const file = (relativePath: string, data: string | Buffer) => ({
    path: relativePath,
    sha256: sha256Hex(data),
    bytes: Buffer.byteLength(data),
    encoding: (typeof data === 'string' ? 'utf8' : 'base64') as 'utf8' | 'base64',
    content: typeof data === 'string' ? data : data.toString('base64'),
  });
  const files = [
    file('concepts/drill-page.md', page),
    file('.meta/sources/fixture-source.json', `${JSON.stringify(record, null, 2)}\n`),
    file('raw/fixture-source/rev-1.plain', raw),
    file('.meta/events/evt_fixture.json', `${JSON.stringify(event, null, 2)}\n`),
  ];
  const archive = {
    schemaVersion: VAULT_EXPORT_VERSION,
    kind: VAULT_EXPORT_KIND,
    createdAt: T0,
    layout: 2,
    exportedBy: PROFILE,
    counts: { pages: 1, history: 0, sources: 1, events: 1, tombstones: 0, files: files.length, bytes: files.reduce((total, entry) => total + entry.bytes, 0) },
    files,
    skipped: [],
  };

  const service = portable(destination);
  const preview = await service.previewImport(archive);
  assert.equal(preview.state, 'ready', preview.reason ?? 'a clean fixture previews ready');

  const result = await service.restore(archive);
  assert.equal(result.committed, true);
  const restored = await destination.readPage('drill-page');
  assert.equal(restored?.state, 'ok');
  assert.equal(restored?.metadata?.title, 'Drill page');
  assert.equal((await destination.readSourceBytes('fixture-source'))?.toString('utf8'), 'fixture original bytes');
  assert.equal((await destination.listEvents()).some((entry) => entry.id === 'evt_fixture'), true);
});

test('source dependents are listed before erasure; the tombstone rides the next export', async () => {
  const store = await vault('dep-src');
  const note = sourceFixture('cited-source', 'Cited work.');
  await store.putSource(note.record, note.bytes);
  const citation = { sourceId: 'cited-source', sourceRevision: note.record.revision, sha256: note.record.sha256, locator: { kind: 'text', start: 0, end: 5 } };
  const citing = conceptDraft('citing-page', {
    claims: [
      {
        id: 'claim-1',
        text: 'Damping removes energy.',
        kind: 'source_fact',
        origin: 'external',
        status: 'current',
        citations: [citation],
        supersedes: [],
      },
    ],
    links: [{ toPageId: 'other-page', type: 'related_to', origin: 'student', why: 'Because evidence.', citations: [citation] }],
    learner: { inMyWords: 'x', stuck: 'y', connections: 'z', evidenceIds: ['cited-source'] },
  } as never);
  await store.applyProposal(proposal([{ op: 'upsert_page', page: citing }], { 'citing-page': null }, { sourceIds: ['cited-source'] }));

  const dependents = await store.sourceDependents('cited-source');
  assert.equal(dependents.length, 1);
  assert.equal(dependents[0]?.id, 'citing-page');
  assert.deepEqual(dependents[0]?.references, ['claim claim-1', 'link → other-page', 'learner evidence']);

  const erased = await store.eraseSource('cited-source', note.record.revision);
  assert.equal(erased.erased, true);
  assert.equal(erased.dependents[0]?.id, 'citing-page', 'the erase answer is honest about what it orphaned');
  assert.equal(await store.readSource('cited-source'), null);
  assert.equal(await exists(path.join(store.root, '.meta/tombstones/cited-source.json')), true, 'the delete is recorded');
  // The student's erase is the one path allowed to remove raw bytes — the tombstone, not the
  // bytes, is what a future sync needs. Maintenance and model actions never reach this path.
  assert.equal(await exists(path.join(store.root, 'raw/cited-source/rev-1.markdown')), false);

  const archive = await portable(store).exportVault();
  assert.ok(archive.files.some((file) => file.path === '.meta/tombstones/cited-source.json'), 'the tombstone travels');
  assert.ok(!archive.files.some((file) => file.path === '.meta/sources/cited-source.json'), 'the record does not');
});
