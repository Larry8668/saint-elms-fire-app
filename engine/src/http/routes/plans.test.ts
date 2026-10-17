import assert from 'node:assert/strict';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { PlansResponseSchema, StudyPlanSchema } from '@sef/shared';
import { PlanService } from '../../plans/service';
import { PlanStore } from '../../plans/store';
import { makeWorld } from '../../plans/testing/world';
import { planRoutes } from './plans';

const dir = await mkdtemp(path.join(tmpdir(), 'sef-plan-route-'));
const profileA = { id: 'student-a', name: 'A', email: 'a@example.test', cohortId: 'c-1', offlineReady: true, admission: 'approved' };
const profileB = { ...profileA, id: 'student-b', email: 'b@example.test' };
const profileC = { ...profileA, id: 'student-c', email: 'c@example.test' };
const draft = async () => ({ steps: [{ title: 'Review entropy', kind: 'review_page', entityRefs: ['page:entropy'] }] });
const service = (id: string, drafter = draft) => new PlanService({ store: new PlanStore(path.join(dir, id)), world: async () => makeWorld(), draft: drafter });
const workspaces = new Map([
  [profileA.id, { profile: profileA, plans: service(profileA.id) }],
  [profileB.id, { profile: profileB, plans: service(profileB.id) }],
  [profileC.id, { profile: profileC, plans: service(profileC.id, async () => Promise.reject(new Error('model offline'))) }],
]);
const deps = {
  auth: { resolve: async (token: string) => (workspaces.has(token) ? { profile: workspaces.get(token)!.profile, mode: 'offline' as const } : null) },
  workspaces: { get: async (profile: typeof profileA) => workspaces.get(profile.id) },
};
const app = planRoutes(deps as never);
const as = (id: string) => ({ authorization: `Bearer ${id}`, 'content-type': 'application/json' });
const post = (url: string, id: string, body?: unknown) => app.request(url, { method: 'POST', headers: as(id), body: body === undefined ? undefined : JSON.stringify(body) });

test('plan routes sit behind the profile session', async () => {
  assert.equal((await app.request('/plans')).status, 401);
  assert.equal((await app.request('/plans', { method: 'POST', body: '{}' })).status, 401);
});

test('propose → approve → abandon, scoped to the caller', async () => {
  assert.equal((await post('/plans', 'student-a', { goal: 'x' })).status, 400);
  assert.equal((await post('/plans', 'student-a', { goal: 'Revise', state: 'done' })).status, 400, 'strict request schema');

  const created = await post('/plans', 'student-a', { goal: 'Revise thermodynamics' });
  assert.equal(created.status, 201);
  const plan = StudyPlanSchema.parse(await created.json());

  assert.deepEqual(PlansResponseSchema.parse(await (await app.request('/plans', { headers: as('student-b') })).json()).plans, []);
  assert.equal((await app.request(`/plans/${plan.id}`, { headers: as('student-b') })).status, 404);
  assert.equal((await post(`/plans/${plan.id}/approve`, 'student-b')).status, 404);

  const approved = await post(`/plans/${plan.id}/approve`, 'student-a');
  assert.equal(approved.status, 200);
  assert.equal(StudyPlanSchema.parse(await approved.json()).status, 'active');
  assert.equal((await post(`/plans/${plan.id}/approve`, 'student-a')).status, 409);
  assert.equal(StudyPlanSchema.parse(await (await app.request(`/plans/${plan.id}`, { headers: as('student-a') })).json()).status, 'active');
  assert.equal((await post(`/plans/${plan.id}/abandon`, 'student-a')).status, 200);
  assert.equal((await post(`/plans/${plan.id}/abandon`, 'student-a')).status, 409);
});

test('an unreachable planner is a 503 with a stable code', async () => {
  const res = await post('/plans', 'student-c', { goal: 'Revise thermodynamics' });
  assert.equal(res.status, 503);
  assert.equal(((await res.json()) as { code: string }).code, 'planner_unavailable');
});
