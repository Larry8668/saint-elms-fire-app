import assert from 'node:assert/strict';
import { mkdtemp, readdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { MAX_ACTIVE_PLANS, MAX_PROPOSED_PLANS, PlansResponseSchema, CONTRACT_VERSION, type PlannerDraft } from '@sef/shared';
import { PlanService } from './service';
import { PlanStore } from './store';
import { makeWorld, NOW } from './testing/world';
import type { PlanWorld } from './world';

const DRAFT: PlannerDraft = {
  steps: [
    { title: 'Review the first law', detail: 'Start with energy balance', kind: 'review_page', entityRefs: ['page:thermo-first-law'] },
    { title: 'Read about heat engines', kind: 'read_lesson', entityRefs: ['lesson:l-heat-engines'] },
    { title: 'Quiz on entropy', kind: 'quiz', entityRefs: ['page:entropy'] },
    { title: 'Read the hidden admin page', kind: 'review_page', entityRefs: ['page:does-not-exist'] },
  ],
};

async function harness(draft: () => Promise<PlannerDraft> = async () => DRAFT) {
  const dir = await mkdtemp(path.join(tmpdir(), 'sef-plans-'));
  const world: PlanWorld = makeWorld();
  let clock = NOW.getTime();
  let n = 0;
  const service = new PlanService({
    store: new PlanStore(dir),
    world: async () => ({ ...world, now: new Date(clock) }),
    draft,
    now: () => new Date(clock),
    newId: () => `plan_${String(++n).padStart(12, '0')}`,
  });
  return { dir, world, service, tick: (ms: number) => (clock += ms) };
}

test('"revise thermodynamics before Thursday": every kept step references a real entity; the phantom is disclosed', async () => {
  const { service } = await harness();
  const result = await service.propose({ goal: 'Revise thermodynamics before Thursday', deadlineAt: '2026-10-16T17:00:00.000Z' });
  assert.ok(result.ok);
  assert.equal(result.plan.status, 'proposed');
  assert.equal(result.plan.steps.length, 3);
  assert.deepEqual(result.plan.steps.map((s) => s.subject), ['First law of thermodynamics', 'Heat engines', 'Entropy']);
  assert.match(result.plan.notes[0]!, /hidden admin page/);
  PlansResponseSchema.parse({ schemaVersion: CONTRACT_VERSION, plans: await service.list() });
});

test('approve → growth event → step done; all done → completed', async () => {
  const { service, world, tick } = await harness();
  const proposed = await service.propose({ goal: 'Revise thermodynamics' });
  assert.ok(proposed.ok);
  const approved = await service.approve(proposed.plan.id);
  assert.ok(approved.ok && approved.plan.status === 'active');
  assert.deepEqual(approved.plan.basis, { phys201: '1.2.0' });

  tick(60_000);
  world.events.push({ pageId: 'thermo-first-law', at: new Date(NOW.getTime() + 30_000).toISOString() });
  let plan = (await service.get(proposed.plan.id))!;
  assert.deepEqual(plan.steps.map((s) => s.state), ['done', 'pending', 'pending']);
  assert.deepEqual((await service.pendingSteps()).map((p) => p.step.kind), ['read_lesson', 'quiz']);

  world.lessonActivity.push({ lessonId: 'l-heat-engines', at: new Date(NOW.getTime() + 40_000).toISOString() });
  world.quizzes.push({ pageId: 'entropy', at: new Date(NOW.getTime() + 50_000).toISOString() });
  plan = (await service.get(proposed.plan.id))!;
  assert.equal(plan.status, 'completed');
  assert.deepEqual(await service.pendingSteps(), []);
});

test('deleting a referenced page marks the step stale and proposes a revision; approving it retires the original', async () => {
  const { service, world } = await harness();
  const proposed = await service.propose({ goal: 'Revise thermodynamics' });
  assert.ok(proposed.ok);
  await service.approve(proposed.plan.id);
  world.pages.delete('entropy');

  const plans = await service.list();
  const original = plans.find((p) => p.id === proposed.plan.id)!;
  assert.equal(original.status, 'active');
  assert.equal(original.steps[2]!.state, 'stale');
  const revision = plans.find((p) => p.revisionOf === original.id)!;
  assert.equal(revision.status, 'proposed');
  assert.equal(revision.steps.length, 2);
  assert.equal((await service.list()).filter((p) => p.revisionOf === original.id).length, 1, 'one revision, not one per refresh');

  const approved = await service.approve(revision.id);
  assert.ok(approved.ok);
  const after = await service.list();
  assert.equal(after.find((p) => p.id === original.id)!.status, 'abandoned');
  assert.equal(after.filter((p) => p.status === 'active').length, 1);
});

test('caps: at most 3 active and 5 proposed plans', async () => {
  const { service } = await harness();
  const ids: string[] = [];
  for (let i = 0; i < MAX_PROPOSED_PLANS; i++) {
    const r = await service.propose({ goal: `Goal ${i}` });
    assert.ok(r.ok);
    ids.push(r.plan.id);
  }
  const over = await service.propose({ goal: 'One too many' });
  assert.ok(!over.ok && over.code === 'too_many_proposals');

  for (const id of ids.slice(0, MAX_ACTIVE_PLANS)) assert.ok((await service.approve(id)).ok);
  const blocked = await service.approve(ids[MAX_ACTIVE_PLANS]!);
  assert.ok(!blocked.ok && blocked.code === 'too_many_active');

  assert.ok((await service.abandon(ids[0]!)).ok);
  assert.ok((await service.approve(ids[MAX_ACTIVE_PLANS]!)).ok, 'abandoning frees a slot');
});

test('model unavailable → honest planner_unavailable; all-phantom draft → no_valid_steps; nothing stored', async () => {
  const down = await harness(async () => {
    throw new Error('connect ECONNREFUSED 127.0.0.1:11434');
  });
  const r1 = await down.service.propose({ goal: 'Revise thermodynamics' });
  assert.ok(!r1.ok && r1.code === 'planner_unavailable');
  assert.doesNotMatch(r1.message, /ECONNREFUSED/);

  const phantom = await harness(async () => ({ steps: [{ title: 'x', kind: 'review_page', entityRefs: ['page:nope'] }] }));
  const r2 = await phantom.service.propose({ goal: 'Revise thermodynamics' });
  assert.ok(!r2.ok && r2.code === 'no_valid_steps');
  assert.equal(r2.notes?.length, 1);
  assert.deepEqual(await readdir(down.dir), []);
  assert.deepEqual(await readdir(phantom.dir), []);
});

test('lifecycle guards: unknown ids, double approve, abandon twice', async () => {
  const { service } = await harness();
  assert.ok(!(await service.approve('plan_nope00000000')).ok);
  assert.equal(((await service.approve('../../etc/passwd')) as { code: string }).code, 'not_found');
  const r = await service.propose({ goal: 'Revise thermodynamics' });
  assert.ok(r.ok);
  await service.approve(r.plan.id);
  assert.equal(((await service.approve(r.plan.id)) as { code: string }).code, 'not_proposed');
  assert.ok((await service.abandon(r.plan.id)).ok);
  assert.equal(((await service.abandon(r.plan.id)) as { code: string }).code, 'not_open');
});

test('a corrupt or tampered plan file is skipped, not trusted', async () => {
  const { service, dir } = await harness();
  await writeFile(path.join(dir, 'plan_000000000099.json'), '{not json');
  await writeFile(path.join(dir, 'plan_000000000098.json'), JSON.stringify({ id: 'plan_000000000098', status: 'active', steps: [{ state: 'done' }] }));
  assert.deepEqual(await service.list(), []);
});

test('a signal that clears between proposal and approval is dropped, not counted as done', async () => {
  const draft = async (): Promise<PlannerDraft> => ({
    steps: [
      { title: 'Sort the problem set', kind: 'resolve_signal', entityRefs: ['signal:deadline:log-1:48h'] },
      { title: 'Review entropy', kind: 'review_page', entityRefs: ['page:entropy'] },
    ],
  });
  const { service, world } = await harness(draft);
  const r = await service.propose({ goal: 'Revise thermodynamics' });
  assert.ok(r.ok && r.plan.steps.length === 2);
  world.signals.clear();
  const approved = await service.approve(r.plan.id);
  assert.ok(approved.ok);
  assert.deepEqual(approved.plan.steps.map((s) => s.kind), ['review_page']);
  assert.match(approved.plan.notes.at(-1)!, /Sort the problem set/);
  assert.equal((await service.get(r.plan.id))!.steps.filter((s) => s.state === 'done').length, 0);
  assert.equal((await service.list()).filter((p) => p.revisionOf).length, 0, 'no revision churn on approval');
});

test('when everything a proposal pointed at is gone, approval refuses with nothing_left', async () => {
  const { service, world } = await harness();
  const r = await service.propose({ goal: 'Revise thermodynamics' });
  assert.ok(r.ok);
  world.pages.clear();
  world.lessons.clear();
  const result = await service.approve(r.plan.id);
  assert.ok(!result.ok && result.code === 'nothing_left');
  assert.equal((await service.get(r.plan.id))!.status, 'proposed');
});
