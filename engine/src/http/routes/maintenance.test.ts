import assert from 'node:assert/strict';
import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import type { EngineSettings, MaintenanceProposalResult, MaintenanceReport, ProposalList } from '@sef/shared';
import { MaintenanceService } from '../../brain/maintenance/service';
import type { SemanticReviewDraft } from '../../brain/maintenance/semantic';
import { WikiCompiler } from '../../brain/compiler/compile';
import { conceptDraft, PROFILE, proposal, vault } from '../../brain/testing/fixtures';
import type { ContentStore } from '../../content/store';
import type { SettingsReader } from '../../settings/store';
import type { WikiStore } from '../../brain/wiki-store';
import { studentRoutes } from './student';
import { sourceRoutes } from './sources';

process.env.ENGINE_DATA_DIR = await mkdtemp(path.join(tmpdir(), 'sef-maintenance-routes-'));

/**
 * Route-level coverage over a real vault: the workspace stub is the same shape the
 * workspace manager hands out, so the guard and the proposal round-trip are exercised
 * for real — including the refusal once the vault has moved.
 */
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
const content = { academicLessons: async () => [] } as unknown as ContentStore;

const AUTH = { authorization: 'Bearer valid', 'content-type': 'application/json' };

async function routeHarness(prefix: string, opts: { propose?: (prompt: string) => Promise<SemanticReviewDraft> } = {}) {
  const store = await vault(prefix);
  const identity = async () => PROFILE;
  const maintenance = new MaintenanceService({ wiki: store, content, settings, identity, ...(opts.propose ? { propose: opts.propose } : {}) });
  const compiler = new WikiCompiler(store, { settings, content, profile: identity });
  const profile = { id: PROFILE.studentId, name: 'Student', email: 's@example.test', cohortId: 'cohort-a' };
  const ws = { profile, maintenance, compiler, wiki: store, brain: { pageDiffs: async () => [] }, sessions: { get: async () => null } };
  const deps = {
    settings: {},
    auth: { resolve: async (token: string) => (token === 'valid' ? { profile, mode: 'offline' as const } : null) },
    workspaces: { get: async () => ws },
  } as never;
  return { app: studentRoutes(deps), proposalsApp: sourceRoutes(deps), store };
}

test('maintenance findings, dismissal and a filed repair all travel over HTTP', async () => {
  const { app, proposalsApp, store } = await routeHarness('maint-flow', {
    propose: async () => ({ contradictions: [], staleClaims: [], connections: [], questions: [] }),
  });
  await store.applyProposal(
    proposal([{ op: 'upsert_page', page: conceptDraft('lone', { courseRefs: [], links: [{ toPageId: 'ghost', type: 'related_to', origin: 'suggested', why: 'test', citations: [] }] }) }], { lone: null }),
  );

  const reportRes = await app.request('/brain/maintenance', { headers: AUTH });
  assert.equal(reportRes.status, 200);
  const report = (await reportRes.json()) as MaintenanceReport;
  assert.ok(report.findings.some((finding) => finding.kind === 'dead_link'));
  assert.ok(report.findings.some((finding) => finding.kind === 'orphan'));

  const reviewRes = await app.request('/brain/maintenance/review', { method: 'POST', headers: AUTH });
  assert.equal(reviewRes.status, 200);

  const dead = report.findings.find((finding) => finding.kind === 'dead_link')!;
  const filedRes = await app.request('/brain/maintenance/proposals', { method: 'POST', headers: AUTH, body: JSON.stringify({ findingIds: [dead.id] }) });
  assert.equal(filedRes.status, 200);
  const filed = (await filedRes.json()) as MaintenanceProposalResult;
  assert.ok(filed.proposalId);

  // The filed repair is an ordinary proposal on the existing queue.
  const list = (await (await proposalsApp.request('/proposals', { headers: AUTH })).json()) as ProposalList;
  assert.ok(list.proposals.some((record) => record.proposal.id === filed.proposalId && record.jobId === null));

  const accepted = await proposalsApp.request(`/proposals/${filed.proposalId}/accept`, { method: 'POST', headers: AUTH, body: '{}' });
  assert.equal(accepted.status, 200);
  assert.equal((await store.readPage('lone'))?.metadata?.links.length, 0);

  // A dismissed suggestion stops showing up but touches nothing.
  const orphan = report.findings.find((finding) => finding.kind === 'orphan')!;
  const dismissed = await app.request(`/brain/maintenance/findings/${orphan.id}/dismiss`, { method: 'POST', headers: AUTH, body: '{}' });
  assert.equal(dismissed.status, 200);
  assert.equal(((await dismissed.json()) as MaintenanceReport).dismissed, 1);

  const catalogue = await app.request('/brain/maintenance/catalogue', { method: 'POST', headers: AUTH });
  assert.equal(catalogue.status, 200);
});

test('a maintenance proposal filed before a manual edit is refused, not applied', async () => {
  const { app, proposalsApp, store } = await routeHarness('maint-stale');
  await store.applyProposal(
    proposal([{ op: 'upsert_page', page: conceptDraft('lone', { courseRefs: [], links: [{ toPageId: 'ghost', type: 'related_to', origin: 'suggested', why: 'test', citations: [] }] }) }], { lone: null }),
  );
  const report = (await (await app.request('/brain/maintenance', { headers: AUTH })).json()) as MaintenanceReport;
  const dead = report.findings.find((finding) => finding.kind === 'dead_link')!;
  const filed = (await (await app.request('/brain/maintenance/proposals', { method: 'POST', headers: AUTH, body: JSON.stringify({ findingIds: [dead.id] }) })).json()) as MaintenanceProposalResult;
  assert.ok(filed.proposalId);

  const pageFile = path.join(store.root, 'concepts', 'lone.md');
  await writeFile(pageFile, `${await readFile(pageFile, 'utf8')}\nEdited by hand.\n`);

  const accepted = await proposalsApp.request(`/proposals/${filed.proposalId}/accept`, { method: 'POST', headers: AUTH, body: '{}' });
  assert.equal(accepted.status, 409, 'the stale maintenance proposal conflicts like any other');
  assert.equal((await store.readPage('lone'))?.metadata?.links.length, 1, 'the dead link is still there — nothing was written');
});

test('maintenance routes reject bad envelopes instead of guessing', async () => {
  const { app } = await routeHarness('maint-invalid');
  assert.equal((await app.request('/brain/maintenance/proposals', { method: 'POST', headers: AUTH, body: '{}' })).status, 400);
  assert.equal((await app.request('/brain/maintenance/proposals', { method: 'POST', headers: AUTH, body: JSON.stringify({ findingIds: [] }) })).status, 400);
  assert.equal((await app.request('/brain/maintenance/findings/not a finding/dismiss', { method: 'POST', headers: AUTH })).status, 404);
  assert.equal((await app.request('/brain/maintenance', { headers: { authorization: 'Bearer forged' } })).status, 401);
});
