import assert from 'node:assert/strict';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import type { SourceDependents, SourceEraseResult, VaultExport, VaultImportPreview, VaultImportResult } from '@sef/shared';
import { VaultPortabilityService } from '../../brain/portable/service';
import { conceptDraft, PROFILE, proposal, sourceFixture, vault } from '../../brain/testing/fixtures';
import type { WikiStore } from '../../brain/wiki-store';
import { vaultRoutes } from './vault';

process.env.ENGINE_DATA_DIR = await mkdtemp(path.join(tmpdir(), 'sef-vault-routes-'));

const AUTH = { authorization: 'Bearer valid', 'content-type': 'application/json' };

async function harness(prefix: string, opts: { admission?: 'approved' | 'pending' | 'suspended'; store?: WikiStore } = {}) {
  const store = opts.store ?? (await vault(prefix));
  const portable = new VaultPortabilityService(store, { identity: async () => PROFILE });
  const profile = { id: PROFILE.studentId, name: 'Student', email: 's@example.test', cohortId: 'cohort-a', ...(opts.admission ? { admission: opts.admission } : {}) };
  const ws = { profile, wiki: store, portable };
  const deps = {
    settings: {},
    auth: { resolve: async (token: string) => (token === 'valid' ? { profile, mode: 'offline' as const } : null) },
    workspaces: { get: async () => ws },
  } as never;
  return { store, app: vaultRoutes(deps) };
}

const post = (app: { request: (path: string, init?: RequestInit) => Promise<Response> | Response }, path: string, body?: unknown) =>
  app.request(path, { method: 'POST', headers: AUTH, body: body === undefined ? undefined : JSON.stringify(body) });

test('export → preview → restore over HTTP, and the whole file verifies', async () => {
  const { app: from, store: source } = await harness('http-src');
  await source.applyProposal(proposal([{ op: 'upsert_page', page: conceptDraft('damping') }], { damping: null }));
  const note = sourceFixture('note-http', 'HTTP notes.');
  await source.putSource(note.record, note.bytes);

  const exported = await post(from, '/vault/export', {});
  assert.equal(exported.status, 200);
  const archive = (await exported.json()) as VaultExport;
  assert.ok(archive.counts.pages >= 1 && archive.counts.sources >= 1);

  const { app: into, store: destination } = await harness('http-dst');
  const previewed = await post(into, '/vault/import/preview', { archive });
  assert.equal(previewed.status, 200);
  const preview = (await previewed.json()) as VaultImportPreview;
  assert.equal(preview.state, 'ready');

  const restored = await post(into, '/vault/import', { archive, overwritePageIds: [] });
  assert.equal(restored.status, 200);
  const result = (await restored.json()) as VaultImportResult;
  assert.equal(result.committed, true);
  assert.equal((await destination.readPage('damping'))?.state, 'ok');
  assert.equal((await destination.readSource('note-http'))?.title, 'Source note-http');
});

test('a malformed or dangerous archive answers refused, never a write', async () => {
  const { app } = await harness('http-refused');
  const malformed = await post(app, '/vault/import/preview', { archive: { nope: true } });
  assert.equal(malformed.status, 200);
  assert.equal(((await malformed.json()) as VaultImportPreview).state, 'refused');

  assert.equal((await post(app, '/vault/import', { archive: { nope: true } })).status, 400, 'a malformed archive is refused on commit too');
  assert.equal((await post(app, '/vault/import/preview', {})).status, 400, 'no archive field at all is a bad request');
});

test('portability belongs to the student: unapproved and suspended profiles still export, and no import grants admission', async () => {
  const { store: source } = await harness('admit-src');
  await source.applyProposal(proposal([{ op: 'upsert_page', page: conceptDraft('damping') }], { damping: null }));
  const { app: suspended } = await harness('admit-susp', { admission: 'suspended', store: source });

  // Export and preview read only what the student owns — the local unlock boundary already
  // covered admission; an expired or suspended enrolment cannot hold the vault hostage.
  const exported = await post(suspended, '/vault/export', {});
  assert.equal(exported.status, 200, 'suspended enrolment still exports its own vault');
  const archive = (await exported.json()) as VaultExport;

  const previewed = await post(suspended, '/vault/import/preview', { archive });
  assert.equal(previewed.status, 200, 'previewing what you own is also read-only');

  // Writes keep the approved guard — portability never smuggles admission in.
  const restored = await post(suspended, '/vault/import', { archive });
  assert.equal(restored.status, 403);
  assert.equal(((await restored.json()) as { code: string }).code, 'unapproved');

  const unauthenticated = vaultRoutes({ settings: {}, auth: { resolve: async () => null }, workspaces: {} } as never);
  assert.equal((await post(unauthenticated, '/vault/export', {})).status, 401);
});

test('dependents are listed over HTTP and erase answers with what it orphaned', async () => {
  const { app, store } = await harness('http-dep');
  const note = sourceFixture('dep-source', 'Cited over HTTP.');
  await store.putSource(note.record, note.bytes);

  const empty = await app.request('/sources/dep-source/dependents', { headers: AUTH });
  assert.equal(empty.status, 200);
  assert.equal(((await empty.json()) as SourceDependents).pages.length, 0);

  const erased = await post(app, '/sources/dep-source/erase', { expectedRevision: note.record.revision });
  assert.equal(erased.status, 200);
  const body = (await erased.json()) as SourceEraseResult;
  assert.equal(body.erased, true);
  assert.equal(body.dependents.length, 0);
  assert.equal(await store.readSource('dep-source'), null);

  const again = await post(app, '/sources/dep-source/erase', {});
  assert.equal(again.status, 404, 'the record is gone — the second erase says so');
});
