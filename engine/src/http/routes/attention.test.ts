import assert from 'node:assert/strict';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { defaultProactivity, type AttentionResponse } from '@sef/shared';
import type { Detector } from '../../signals/detectors';
import { SignalService } from '../../signals/service';
import { SignalStore } from '../../signals/store';
import { attentionRoutes } from './attention';

const dir = await mkdtemp(path.join(tmpdir(), 'sef-attention-route-'));
const profileA = { id: 'student-a', name: 'A', email: 'a@example.test', cohortId: 'c-1', offlineReady: true, admission: 'approved' };
const profileB = { ...profileA, id: 'student-b', email: 'b@example.test' };

const notice: Detector = {
  kind: 'notice',
  detect: () => [{ key: 'notice:log-1', kind: 'notice', title: 'Library closes early', detail: '', why: 'test', urgency: 'info', entityRefs: [] }],
};
const silent: Detector = { kind: 'notice', detect: () => [] };

const workspaces = new Map(
  [
    [profileA, notice],
    [profileB, silent],
  ].map(([profile, detector]) => [
    (profile as typeof profileA).id,
    {
      profile,
      signals: new SignalService({
        store: new SignalStore(path.join(dir, `${(profile as typeof profileA).id}.json`)),
        inputs: async () => ({}),
        proactivity: async () => defaultProactivity(),
        detectors: [detector as Detector],
      }),
    },
  ]),
);

const deps = {
  auth: { resolve: async (token: string) => (workspaces.has(token) ? { profile: workspaces.get(token)!.profile, mode: 'offline' as const } : null) },
  workspaces: { get: async (profile: typeof profileA) => workspaces.get(profile.id) },
};
const app = attentionRoutes(deps as never);
const as = (id: string) => ({ authorization: `Bearer ${id}`, 'content-type': 'application/json' });
const key = encodeURIComponent('notice:log-1');

test('attention routes sit behind the profile session', async () => {
  assert.equal((await app.request('/attention')).status, 401);
  assert.equal((await app.request(`/attention/${key}/dismiss`, { method: 'POST' })).status, 401);
});

test('list, snooze, seen and dismiss act on the caller’s own ledger only', async () => {
  const listed = (await (await app.request('/attention', { headers: as('student-a') })).json()) as AttentionResponse;
  assert.deepEqual(listed.items.map((i) => i.key), ['notice:log-1']);
  const other = (await (await app.request('/attention', { headers: as('student-b') })).json()) as AttentionResponse;
  assert.deepEqual(other.items, [], 'B never sees A’s items');
  assert.equal((await app.request(`/attention/${key}/dismiss`, { method: 'POST', headers: as('student-b') })).status, 404);

  assert.equal((await app.request(`/attention/${key}/snooze`, { method: 'POST', headers: as('student-a'), body: JSON.stringify({ hours: 200 }) })).status, 400, 'snooze is bounded to 7 days');
  assert.equal((await app.request(`/attention/${key}/snooze`, { method: 'POST', headers: as('student-a'), body: JSON.stringify({ hours: 2 }) })).status, 200);

  const seen = await app.request('/attention/seen', { method: 'POST', headers: as('student-a'), body: JSON.stringify({ keys: ['notice:log-1'] }) });
  assert.deepEqual(await seen.json(), { updated: 1 });
  assert.equal((await app.request('/attention/seen', { method: 'POST', headers: as('student-a'), body: '{}' })).status, 400);

  assert.equal((await app.request(`/attention/${key}/dismiss`, { method: 'POST', headers: as('student-a') })).status, 200);
  const after = (await (await app.request('/attention/evaluate', { method: 'POST', headers: as('student-a') })).json()) as AttentionResponse;
  assert.deepEqual(after.items, [], 'a dismissal survives re-evaluation');
});
