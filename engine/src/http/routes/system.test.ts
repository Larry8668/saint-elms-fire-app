import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { DeviceCapability } from '@sef/shared';
import { systemRoutes } from './system';

const approved = { id: 'student-a', name: 'A', email: 'a@example.test', cohortId: 'c-1', offlineReady: true, admission: 'approved' };
const pending = { ...approved, id: 'student-p', admission: 'pending' };
const profiles = new Map([
  [approved.id, approved],
  [pending.id, pending],
]);

const deps = {
  auth: { resolve: async (token: string) => (profiles.has(token) ? { profile: profiles.get(token)!, mode: 'offline' as const } : null) },
  workspaces: { get: async () => ({}) },
};

const capability: DeviceCapability = { ramGb: 32, gpu: 'Apple M2 Max', suggested: { tutor: 'gemma4:e4b', brain: 'gemma4:26b', vision: 'gemma4:e4b', safety: 'shieldgemma:9b' } };
let detections = 0;
const app = systemRoutes(deps as never, async () => {
  detections += 1;
  return capability;
});
const as = (id: string) => ({ authorization: `Bearer ${id}` });

test('capability sits behind an approved profile session', async () => {
  assert.equal((await app.request('/system/capability')).status, 401);
  assert.equal((await app.request('/system/capability', { headers: as(pending.id) })).status, 403);
});

test('capability is detected once per process and returned as-is', async () => {
  const first = await app.request('/system/capability', { headers: as(approved.id) });
  assert.equal(first.status, 200);
  assert.deepEqual(await first.json(), capability);
  await app.request('/system/capability', { headers: as(approved.id) });
  assert.equal(detections, 1);
});
