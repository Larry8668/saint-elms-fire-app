import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { conceptDraft, proposal, vault } from './testing/fixtures';
import { readManifest } from './vault-manifest';
import { applyJournalSteps, beginJournal, completeJournal, pendingJournals } from './vault-journal';

process.env.ENGINE_DATA_DIR = await mkdtemp(path.join(tmpdir(), 'sef-wiki-journal-'));

const exists = async (file: string) => stat(file).then(() => true, () => false);
const isFile = async (file: string) => stat(file).then((info) => info.isFile(), () => false);

test('an interrupted multi-file commit is finished by recovery, leaving the vault consistent', async () => {
  const store = await vault('crash');
  await store.applyProposal(proposal([{ op: 'upsert_page', page: conceptDraft('page-a') }], { 'page-a': null }));
  const pageA = await store.readPage('page-a');
  const journalDirectory = path.join(store.root, '.meta/journal');

  // A crash mid-commit: the second page of the commit cannot be written yet.
  await mkdir(path.join(store.root, 'concepts/page-b.md'), { recursive: true });
  await assert.rejects(() =>
    store.applyProposal(
      proposal(
        [
          { op: 'upsert_page', page: conceptDraft('page-a', { summary: 'Edited before the crash.' }) },
          { op: 'upsert_page', page: conceptDraft('page-b') },
        ],
        { 'page-a': pageA?.revision ?? '', 'page-b': null },
      ),
    ),
  );

  assert.equal((await pendingJournals(store.root)).length, 1, 'the write-ahead journal is still on disk');
  assert.equal((await store.status()).pendingCommits, 1);
  assert.match(await readFile(path.join(store.root, 'concepts/page-a.md'), 'utf8'), /Edited before the crash\./, 'the first step of the commit landed');
  assert.equal(await isFile(path.join(store.root, 'concepts/page-b.md')), false, 'the second page never landed');
  assert.equal((await store.readPage('page-a'))?.state, 'out_of_band', 'the manifest has not caught up yet');
  assert.doesNotMatch((await store.readIndex()) ?? '', /page-b/);

  await rm(path.join(store.root, 'concepts/page-b.md'), { recursive: true });
  const report = await store.recover();

  assert.equal(report.recovered.length, 1);
  assert.equal(report.recovered[0]?.intent.startsWith('wiki.proposal'), true);
  assert.equal(report.invalid.length, 0);
  assert.deepEqual(await readdir(journalDirectory), [], 'the journal is cleared once replayed');
  assert.equal((await store.status()).pendingCommits, 0);

  const recoveredA = await store.readPage('page-a');
  const recoveredB = await store.readPage('page-b');
  assert.equal(recoveredA?.state, 'ok');
  assert.equal(recoveredA?.metadata?.summary, 'Edited before the crash.');
  assert.equal(recoveredB?.state, 'ok');
  assert.equal(recoveredB?.metadata?.title, 'Concept page-b');

  const manifest = (await readManifest(store.root)).manifest;
  assert.equal(manifest?.pages['page-a']?.revision, recoveredA?.metadata?.revision);
  assert.equal(manifest?.pages['page-b']?.revision, recoveredB?.metadata?.revision);
  assert.match((await store.readIndex()) ?? '', /page-b/);
  assert.match((await store.readLog())[0]?.detail ?? '', /page-a/);

  const recovered = await readdir(path.join(store.root, '.meta/recovery'));
  assert.equal(recovered.length, 1, 'a recovery record is kept');
  const record = JSON.parse(await readFile(path.join(store.root, '.meta/recovery', recovered[0] ?? ''), 'utf8')) as { state: string; journalId: string };
  assert.equal(record.state, 'recovered');
  assert.equal(record.journalId, report.recovered[0]?.id);

  const second = await store.recover();
  assert.deepEqual({ recovered: second.recovered.length, invalid: second.invalid.length }, { recovered: 0, invalid: 0 }, 'recovery is idempotent');
});

test('a journal is a set of whole-file instructions, so replaying it twice lands on the same bytes', async () => {
  const store = await vault('replay');
  const target = path.join(store.root, 'concepts/one.md');
  const journal = await beginJournal(store.root, 'unit test commit', [
    { kind: 'write', path: 'concepts/one.md', content: 'first version\n' },
    { kind: 'append', path: 'log.md', content: '## [x] unit | appended once\n' },
  ]);
  await applyJournalSteps(store.root, journal.steps);
  await applyJournalSteps(store.root, journal.steps);
  await completeJournal(store.root, journal.id);

  assert.equal(await readFile(target, 'utf8'), 'first version\n');
  const log = await readFile(path.join(store.root, 'log.md'), 'utf8');
  assert.equal(log.split('appended once').length - 1, 1, 'an append is not duplicated');
});

test('a journal whose step escapes the vault is refused and reported, never applied', async () => {
  const store = await vault('hostile');
  const escape = path.join(store.root, '..', `escaped-${path.basename(store.root)}.md`);
  await writeFile(
    path.join(store.root, '.meta/journal/evil.json'),
    JSON.stringify({
      schemaVersion: 2,
      id: 'evil',
      intent: 'escalate',
      createdAt: new Date().toISOString(),
      steps: [{ kind: 'write', path: `../${path.basename(escape)}`, content: 'should never land' }],
    }),
    'utf8',
  );

  const report = await store.recover();
  assert.equal(report.recovered.length, 0);
  assert.equal(report.invalid.length, 1);
  assert.match(report.invalid[0]?.reason ?? '', /parent segments|outside the vault/);
  assert.equal(await exists(escape), false, 'nothing outside the vault is written');
  assert.equal(await exists(path.join(store.root, '.meta/journal/evil.json')), true, 'an unrecoverable journal is kept for a human, not deleted');
});

test('a journal that is not a journal is reported and kept', async () => {
  const store = await vault('broken-journal');
  await writeFile(path.join(store.root, '.meta/journal/broken.json'), '{not json', 'utf8');
  const report = await store.recover();
  assert.deepEqual(report.recovered, []);
  assert.equal(report.invalid.length, 1);
  assert.match(report.invalid[0]?.reason ?? '', /valid JSON/);
});

test('a recovered commit does not resurrect a page the student removed', async () => {
  const store = await vault('removal-journal');
  await store.applyProposal(proposal([{ op: 'upsert_page', page: conceptDraft('damping') }], { damping: null }));
  const page = await store.readPage('damping');
  await store.removePage('damping', page?.revision ?? '');
  const report = await store.recover();
  assert.deepEqual(report.recovered, []);
  assert.equal(await exists(path.join(store.root, 'concepts/damping.md')), false);
  assert.equal((await store.readIndex())?.includes('damping'), false);
});
