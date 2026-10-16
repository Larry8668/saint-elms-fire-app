import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import type { LogisticsRecord } from '@sef/shared';
import { LogisticsStore } from '../../logistics/store';
import { logisticsRoutes } from './logistics';

const dir = await mkdtemp(path.join(tmpdir(), 'sef-logistics-route-'));

const profileA = { id: 'student-a', name: 'A', email: 'a@example.test', cohortId: 'c-1', offlineReady: true };
const profileB = { id: 'student-b', name: 'B', email: 'b@example.test', cohortId: 'c-1', offlineReady: true };

/** Each profile gets its own store file — the route may only ever see the caller's. */
const workspaces = new Map<string, { profile: typeof profileA; logistics: LogisticsStore; settings: { get: () => Promise<unknown> } }>();
for (const profile of [profileA, profileB]) {
  workspaces.set(profile.id, {
    profile,
    logistics: new LogisticsStore(path.join(dir, `${profile.id}.json`)),
    settings: {
      // A real settings shape whose provider cannot be reached — extraction answers honestly.
      get: async () => ({
        uniServerUrl: 'http://127.0.0.1:1',
        searxngUrl: 'http://127.0.0.1:1',
        thinking: false,
        providers: [{ id: 'dead', kind: 'ollama', label: 'Unreachable', baseUrl: 'http://127.0.0.1:9' }],
        roles: { tutor: { provider: 'dead', model: 'x' }, brain: { provider: 'dead', model: 'x' }, vision: { provider: 'dead', model: 'x' } },
      }),
    },
  });
}

const deps = {
  settings: {},
  auth: {
    resolve: async (token: string) => (workspaces.has(token) ? { profile: workspaces.get(token)!.profile, mode: 'offline' as const } : null),
  },
  workspaces: { get: async (profile: typeof profileA) => workspaces.get(profile.id) },
};

const app = logisticsRoutes(deps as never);
const as = (profileId: string, extra: Record<string, string> = {}) => ({ authorization: `Bearer ${profileId}`, 'content-type': 'application/json', ...extra });

const write = { title: 'Fees — instalment 2', kind: 'deadline', dueAt: '2026-03-14T17:00', allDay: false, timeZone: 'Asia/Kolkata', details: '' };

test('logistics routes sit behind the profile session', async () => {
  const anon = await app.request('/logistics');
  assert.equal(anon.status, 401);
});

test('create, edit, confirm-state and delete flow through one student’s store', async () => {
  const bad = await app.request('/logistics', { method: 'POST', headers: as('student-a'), body: JSON.stringify({ title: 'x' }) });
  assert.equal(bad.status, 400, 'a partial write is refused by the contract, not patched over');

  const created = (await (
    await app.request('/logistics', { method: 'POST', headers: as('student-a'), body: JSON.stringify(write) })
  ).json()) as { record: LogisticsRecord };
  assert.equal(created.record.state, 'confirmed');
  assert.equal(created.record.provenance.kind, 'manual');

  const edited = (await (
    await app.request(`/logistics/${created.record.id}`, { method: 'PUT', headers: as('student-a'), body: JSON.stringify({ title: 'Fees — final' }) })
  ).json()) as { record: LogisticsRecord };
  assert.equal(edited.record.title, 'Fees — final');

  const reconfirm = await app.request(`/logistics/${created.record.id}/confirm`, { method: 'POST', headers: as('student-a'), body: '{}' });
  assert.equal(reconfirm.status, 409, 'confirming a confirmed record is not a transition');

  const list = (await (await app.request('/logistics', { headers: as('student-a') })).json()) as { items: LogisticsRecord[] };
  assert.deepEqual(list.items.map((r) => r.id), [created.record.id]);

  const gone = await app.request(`/logistics/${created.record.id}`, { method: 'DELETE', headers: as('student-a') });
  assert.equal(gone.status, 204);
  const again = await app.request(`/logistics/${created.record.id}`, { method: 'DELETE', headers: as('student-a') });
  assert.equal(again.status, 404);
});

test('another profile’s records are unreachable — the workspace owns the store', async () => {
  const created = (await (
    await app.request('/logistics', { method: 'POST', headers: as('student-a'), body: JSON.stringify(write) })
  ).json()) as { record: LogisticsRecord };

  const foreignList = (await (await app.request('/logistics', { headers: as('student-b') })).json()) as { items: LogisticsRecord[] };
  assert.equal(foreignList.items.length, 0, 'student-b’s store is a different file entirely');

  const foreignEdit = await app.request(`/logistics/${created.record.id}`, { method: 'PUT', headers: as('student-b'), body: JSON.stringify({ title: 'hijacked' }) });
  assert.equal(foreignEdit.status, 404, 'a foreign id is absent, not editable');
  const foreignDelete = await app.request(`/logistics/${created.record.id}`, { method: 'DELETE', headers: as('student-b') });
  assert.equal(foreignDelete.status, 404);
  assert.equal((await workspaces.get('student-a')!.logistics.get(created.record.id))?.title, 'Fees — instalment 2', 'the record itself was untouched');
});

test('extraction answers honestly when the vision model cannot run', async () => {
  const res = await app.request('/logistics/extract', {
    method: 'POST',
    headers: as('student-a'),
    body: JSON.stringify({ image: { mimeType: 'image/png', data: 'iVBORw0KGgo=' } }),
  });
  assert.equal(res.status, 503, 'unavailable is said, never faked');
  const body = (await res.json()) as { error: string };
  assert.match(body.error, /nothing was filed/i);

  const bad = await app.request('/logistics/extract', { method: 'POST', headers: as('student-a'), body: JSON.stringify({ image: { mimeType: 'image/gif', data: 'R0lG' } }) });
  assert.equal(bad.status, 400, 'only the permitted image types are read');
});

test.after(async () => rm(dir, { recursive: true, force: true }));
