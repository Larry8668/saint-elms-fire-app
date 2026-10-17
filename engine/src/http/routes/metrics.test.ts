import assert from 'node:assert/strict';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { MetricsReportSchema } from '@sef/shared';
import { MetricsLog } from '../../eval/log';
import { MetricsService } from '../../eval/service';
import { metricsRoutes } from './metrics';

const dir = await mkdtemp(path.join(tmpdir(), 'sef-metrics-route-'));
const profileA = { id: 'student-a', name: 'A', email: 'a@example.test', cohortId: 'c-1', offlineReady: true, admission: 'approved' };
const profileB = { ...profileA, id: 'student-b', email: 'b@example.test' };
const service = (id: string) =>
  new MetricsService({ log: new MetricsLog(path.join(dir, `${id}.jsonl`)), turns: async () => ({ total: 4, refused: 1 }), proposals: async () => ({ accepted: 1, rejected: 1 }) });
const workspaces = new Map([
  [profileA.id, { profile: profileA, metrics: service(profileA.id) }],
  [profileB.id, { profile: profileB, metrics: service(profileB.id) }],
]);
const deps = {
  auth: { resolve: async (token: string) => (workspaces.has(token) ? { profile: workspaces.get(token)!.profile, mode: 'offline' as const } : null) },
  workspaces: { get: async (profile: typeof profileA) => workspaces.get(profile.id) },
};
const app = metricsRoutes(deps as never);
const as = (id: string) => ({ authorization: `Bearer ${id}`, 'content-type': 'application/json' });
const post = (id: string, body: unknown) => app.request('/metrics/events', { method: 'POST', headers: as(id), body: JSON.stringify(body) });

test('metrics routes sit behind the profile session', async () => {
  assert.equal((await app.request('/metrics')).status, 401);
  assert.equal((await app.request('/metrics/events', { method: 'POST', body: '{}' })).status, 401);
});

test('the UI may only report what it alone observes, as short tags, and the engine stamps the time', async () => {
  assert.equal((await post('student-a', { events: [{ kind: 'nudge_dismissed', ref: 'x' }] })).status, 400, 'engine-side kinds are refused');
  assert.equal((await post('student-a', { events: [{ kind: 'plan_completed', ref: 'p' }] })).status, 400);
  assert.equal((await post('student-a', { events: [{ kind: 'nudge_shown', ref: 'x', tag: 'Free text!' }] })).status, 400);
  assert.equal((await post('student-a', { events: [{ kind: 'nudge_shown', ref: 'x', at: '2020-01-01T00:00:00.000Z' }] })).status, 400, 'no client clock');
  assert.equal((await post('student-a', { events: [] })).status, 400);

  const ok = await post('student-a', { events: [{ kind: 'suggestion_shown', ref: 'sq_1', tag: 'guide' }, { kind: 'suggestion_sent', ref: 'sq_1', tag: 'guide' }] });
  assert.equal(ok.status, 202);
  assert.deepEqual(await ok.json(), { recorded: 2 });
});

test('the report is profile-scoped and matches the contract', async () => {
  const a = MetricsReportSchema.parse(await (await app.request('/metrics', { headers: as('student-a') })).json());
  const b = MetricsReportSchema.parse(await (await app.request('/metrics', { headers: as('student-b') })).json());
  assert.deepEqual(a.suggestionAcceptance, { numerator: 1, denominator: 1, rate: 1 });
  assert.equal(b.events, 0);
  assert.equal(b.suggestionAcceptance.rate, null);
  assert.deepEqual(a.refusals, { numerator: 1, denominator: 4, rate: 0.25 });
});
