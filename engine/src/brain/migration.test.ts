import assert from 'node:assert/strict';
import { mkdtemp, readFile, readdir, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { migrateLegacyVault } from './migration';
import { clock, conceptDraft, legacyPage, proposal, writeLegacyVault } from './testing/fixtures';
import { VaultConflictError } from './vault-errors';
import { conceptPageFromWikiPage, readPageFile } from './wiki-page-format';
import { WikiStore } from './wiki-store';

process.env.ENGINE_DATA_DIR = await mkdtemp(path.join(tmpdir(), 'sef-vault-migration-'));

const HISTORY_STAMP = '2026-09-01T00-00-00-000Z.md';

/** An earlier vault: concept pages, their history, its own SCHEMA.md and a log. */
async function legacyVault(prefix: string, pages = [legacyPage('newton-second-law'), legacyPage('damping', { links: [], misconceptions: [] })]): Promise<WikiStore> {
  const root = await mkdtemp(path.join(tmpdir(), `sef-${prefix}-`));
  await writeLegacyVault(root, {
    pages,
    history: { 'newton-second-law': [{ name: HISTORY_STAMP, content: '# older revision\n' }] },
    log: '# Learning log\n\n## [2026-09-05 09:00:00] session | Guide session on damping\n',
  });
  const store = new WikiStore(root, { now: clock('2026-10-15T10:00:00.000Z') });
  await store.init();
  return store;
}

test('an earlier vault is still readable during the transition, before anything is migrated', async () => {
  const store = await legacyVault('legacy-read');
  const pages = await store.listPages();

  assert.deepEqual(pages.map((page) => [page.id, page.format, page.state]), [
    ['damping', 1, 'ok'],
    ['newton-second-law', 1, 'ok'],
  ]);
  const page = await store.readPage('newton-second-law');
  assert.equal(page?.legacy?.concept, 'Concept newton-second-law');
  assert.equal(page?.metadata, null);
  assert.match(page?.body ?? '', /## In my words/);
  assert.equal(readPageFile(page?.raw ?? '').format, 1);
  assert.equal((await store.readLog())[0]?.title, 'Guide session on damping');
  assert.equal((await store.readConventions()).source, 'vault', 'the earlier SCHEMA.md was upgraded with the versioned block');
});

test('migration adopts every page without losing prose, sections or unresolved provenance', async () => {
  const store = await legacyVault('legacy-migrate');
  const original = legacyPage('newton-second-law');
  const report = await migrateLegacyVault(store);

  assert.deepEqual(report.migrated.map((change) => [change.id, change.change]), [
    ['damping', 'updated'],
    ['newton-second-law', 'updated'],
  ]);
  assert.deepEqual(report.skipped, []);
  assert.equal(report.historyImported, 1);

  const page = await store.readPage('newton-second-law');
  assert.equal(page?.format, 2);
  assert.equal(page?.state, 'ok');
  assert.equal(page?.metadata?.kind, 'concept');
  assert.equal(page?.metadata?.title, original.concept);
  assert.deepEqual(page?.metadata?.provenance?.evidence, original.evidence);
  assert.deepEqual(page?.metadata?.provenance?.misconceptions, original.misconceptions);
  assert.deepEqual(page?.metadata?.provenance?.links, original.links);
  assert.deepEqual(page?.metadata?.learner, {
    inMyWords: original.sections.in_my_words,
    stuck: original.sections.where_i_got_stuck,
    connections: original.sections.connections,
    evidenceIds: ['quiz-1', 'session-1'],
  });

  const schema = await readFile(path.join(store.root, 'SCHEMA.md'), 'utf8');
  assert.match(schema, /^# Brain schema\n\nThis folder is your second brain/, 'the earlier SCHEMA.md prose survives');
  assert.match(schema, /sef:vault-conventions:begin/);

  const history = await readdir(path.join(store.root, '.history/concepts/newton-second-law'));
  assert.equal(history.includes(HISTORY_STAMP), true, 'the earlier history is carried across');
  const legacySnapshot = history.find((name) => name.startsWith('file-'));
  assert.ok(legacySnapshot, 'the earlier page file is kept before it is upgraded');
  assert.match(await readFile(path.join(store.root, '.history/concepts/newton-second-law', legacySnapshot), 'utf8'), /^---\nconcept: Concept newton-second-law/, 'the kept snapshot is the earlier format, byte for byte');
  assert.equal(await readFile(path.join(store.root, '.history/newton-second-law', HISTORY_STAMP), 'utf8'), '# older revision\n', 'the earlier history stays where it was');
  assert.match((await store.readIndex()) ?? '', /migrated from the earlier concept vault/);
  assert.equal((await store.readLog())[0]?.kind, 'migrate');
});

test('a migrated page converts back to exactly what the earlier vault held', async () => {
  const store = await legacyVault('legacy-roundtrip');
  const original = legacyPage('newton-second-law');
  await migrateLegacyVault(store);

  const page = await store.readPage('newton-second-law');
  assert.ok(page?.metadata);
  assert.deepEqual(conceptPageFromWikiPage(page.metadata, page.body), original);
  assert.match(page.raw, /^---\nid: newton-second-law\nkind: concept\nschemaVersion: 2\nrevision: rev-/, 'the file is typed now');
});

test('one page can be adopted on its own, leaving the rest in the earlier format', async () => {
  const store = await legacyVault('legacy-lazy');
  const legacy = await store.readPage('newton-second-law');
  const report = await store.applyProposal(
    proposal([{ op: 'upsert_page', page: conceptDraft('newton-second-law', { summary: 'Mine, rewritten.' }) }], { 'newton-second-law': legacy?.revision ?? '' }),
  );

  assert.equal(report.committed, true);
  const adopted = await store.readPage('newton-second-law');
  assert.equal(adopted?.format, 2);
  assert.equal(adopted?.metadata?.summary, 'Mine, rewritten.');
  assert.equal(adopted?.metadata?.provenance?.origin, 'legacy_concept_vault', 'the earlier provenance is carried across');
  assert.deepEqual(adopted?.metadata?.provenance?.misconceptions, legacy?.legacy?.misconceptions);

  const untouched = await store.readPage('damping');
  assert.equal(untouched?.format, 1, 'the other page is left as it was until it is adopted');
  assert.equal(untouched?.revision.startsWith('file-'), true);
});

test('a legacy revision that has moved on cannot be adopted over a newer page', async () => {
  const store = await legacyVault('legacy-conflict');
  await assert.rejects(
    () => store.applyProposal(proposal([{ op: 'upsert_page', page: conceptDraft('newton-second-law') }], { 'newton-second-law': 'file-stale' })),
    (error: unknown) => error instanceof VaultConflictError && (error as VaultConflictError).details[0]?.reason === 'revision_changed',
  );
});

test('a page the migration cannot read is reported and left alone', async () => {
  const store = await legacyVault('legacy-skip');
  const broken = path.join(store.root, 'concepts/broken.md');
  await writeFile(broken, '---\ntitle: not a page\n---\nbody\n', 'utf8');

  const report = await migrateLegacyVault(store);
  assert.deepEqual(report.skipped.map((item) => item.id), ['broken']);
  assert.match(report.skipped[0]?.reason ?? '', /later|newer|legacy|malformed|format/i);
  assert.equal(await readFile(broken, 'utf8'), '---\ntitle: not a page\n---\nbody\n');
  assert.equal(report.migrated.length, 2, 'the readable pages are still adopted');
  assert.equal((await stat(path.join(store.root, 'concepts/broken.md'))).isFile(), true);
});
