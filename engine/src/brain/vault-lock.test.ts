import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdir, mkdtemp, rm, stat, writeFile } from 'node:fs/promises';
import os from 'node:os';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { clock, conceptDraft, proposal, tempRoot, vault } from './testing/fixtures';
import { VaultConflictError, VaultLockError } from './vault-errors';
import { VaultLock } from './vault-lock';
import { WikiStore } from './wiki-store';

process.env.ENGINE_DATA_DIR = await mkdtemp(path.join(tmpdir(), 'sef-vault-lock-'));

const exists = async (file: string) => stat(file).then(() => true, () => false);

test('two proposals on one vault queue instead of interleaving their commits', async () => {
  const store = await vault('queue', { lockTimeoutMs: 2_000 });
  const [first, second] = await Promise.all([
    store.applyProposal(proposal([{ op: 'upsert_page', page: conceptDraft('page-a') }], { 'page-a': null })),
    store.applyProposal(proposal([{ op: 'upsert_page', page: conceptDraft('page-b') }], { 'page-b': null })),
  ]);

  assert.deepEqual([first.committed, second.committed], [true, true]);
  assert.equal((await store.listPages()).length, 2);
  assert.equal((await store.status()).pendingCommits, 0);
  const index = (await store.readIndex()) ?? '';
  assert.match(index, /page-a/, 'the second commit rebuilt the catalogue from what the first one left');
  assert.match(index, /page-b/);
});

test('a second writer on the same vault is refused rather than let in', async () => {
  const root = await tempRoot('cross-process');
  const store = new WikiStore(root, { now: clock(), lockTimeoutMs: 500 });
  await store.init();
  const holder = new VaultLock(root, { lockTimeoutMs: 500, lockPollMs: 10 });
  const intruder = new VaultLock(root, { lockTimeoutMs: 150, lockPollMs: 10 });

  let signal!: () => void;
  const acquired = new Promise<void>((resolve) => {
    signal = resolve;
  });
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const held = holder.run(async () => {
    signal();
    await gate;
  });
  await acquired;

  await assert.rejects(
    () => intruder.run(async () => assert.fail('the intruder must never run')),
    VaultLockError,
  );

  release();
  await held;
  assert.equal(await exists(holder.lockFile), false, 'the lock is released when the writer finishes');
  const after = await store.applyProposal(proposal([{ op: 'upsert_page', page: conceptDraft('page-a') }], { 'page-a': null }));
  assert.equal(after.committed, true);
});

test('a lock left by a dead process is broken; a lock from another machine is never broken', async () => {
  const root = await tempRoot('stale-lock');
  await mkdir(path.join(root, '.meta'), { recursive: true });
  const lock = new VaultLock(root, { lockTimeoutMs: 200, lockPollMs: 10, lockStaleMs: 1_000 });
  const longAgo = new Date(Date.now() - 60_000).toISOString();

  const dead = spawnSync('true');
  await writeFile(lock.lockFile, JSON.stringify({ pid: dead.pid, host: os.hostname(), token: 'dead', at: longAgo }), 'utf8');
  let ran = false;
  await lock.run(async () => {
    ran = true;
  });
  assert.equal(ran, true, 'a stale lock does not block a writer forever');
  assert.equal(await exists(lock.lockFile), false);

  await writeFile(lock.lockFile, JSON.stringify({ pid: 1, host: 'somewhere-else', token: 'foreign', at: longAgo }), 'utf8');
  await assert.rejects(
    () => lock.run(async () => assert.fail('a lock from another machine must not be broken')),
    VaultLockError,
  );
  await rm(lock.lockFile, { force: true });
});

test('the vault is released even when the operation inside the lock fails', async () => {
  const store = await vault('release', { lockTimeoutMs: 300 });
  await assert.rejects(() => store.applyProposal(proposal([{ op: 'upsert_page', page: conceptDraft('page-a') }], { 'page-a': 'rev-missing' })), VaultConflictError);
  assert.equal(await exists(new VaultLock(store.root).lockFile), false, 'a failed commit still releases the vault');
  const kept = await store.applyProposal(proposal([{ op: 'upsert_page', page: conceptDraft('page-a') }], { 'page-a': null }));
  assert.equal(kept.committed, true);
});
