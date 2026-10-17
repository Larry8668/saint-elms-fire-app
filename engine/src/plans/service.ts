import { randomUUID } from 'node:crypto';
import { CONTRACT_VERSION, MAX_ACTIVE_PLANS, MAX_PROPOSED_PLANS, type CreatePlanRequest, type PlanStep, type StudyPlan } from '@sef/shared';
import { log } from '../config';
import { PLANNER_INSTRUCTIONS, plannerPrompt, type PlanDrafter } from './planner';
import { proposeRevision, pruneAtApproval, recompute } from './progress';
import type { PlanStore } from './store';
import { validateDraft } from './validate';
import type { PlanWorld } from './world';

/** Finished and abandoned plans kept for reference; older ones are pruned. */
const MAX_CLOSED_PLANS = 20;
const STATUS_ORDER: Record<StudyPlan['status'], number> = { active: 0, proposed: 1, completed: 2, abandoned: 3 };

type Failure<C extends string> = { ok: false; code: C; message: string; notes?: string[] };
export type ProposeResult = { ok: true; plan: StudyPlan } | Failure<'planner_unavailable' | 'no_valid_steps' | 'too_many_proposals'>;
export type PlanActionResult = { ok: true; plan: StudyPlan } | Failure<'not_found' | 'not_proposed' | 'not_open' | 'too_many_active' | 'nothing_left'>;

export interface PendingPlanStep {
  planId: string;
  goal: string;
  deadlineAt: string | null;
  step: PlanStep;
}

export interface PlanServiceDeps {
  store: PlanStore;
  world: () => Promise<PlanWorld>;
  draft: PlanDrafter;
  now?: () => Date;
  newId?: () => string;
}

/**
 * Plan lifecycle. A model may propose steps; code validates them, the student approves,
 * and from then on only evidence moves a step. Nothing here ever runs a step.
 */
export class PlanService {
  private queue: Promise<unknown> = Promise.resolve();

  constructor(private readonly deps: PlanServiceDeps) {}

  private now() {
    return this.deps.now?.() ?? new Date();
  }

  private newId() {
    return this.deps.newId?.() ?? `plan_${randomUUID().replace(/-/g, '').slice(0, 16)}`;
  }

  /** Serialises every read-modify-write so caps and revisions cannot race. */
  private exclusive<T>(fn: () => Promise<T>): Promise<T> {
    const run = this.queue.then(fn, fn);
    this.queue = run.catch(() => undefined);
    return run;
  }

  async propose(request: CreatePlanRequest): Promise<ProposeResult> {
    return this.exclusive(async () => {
      const plans = await this.refresh();
      if (plans.filter((p) => p.status === 'proposed').length >= MAX_PROPOSED_PLANS) {
        return { ok: false, code: 'too_many_proposals', message: `You already have ${MAX_PROPOSED_PLANS} plans waiting for a decision. Approve or drop one first.` };
      }
      const world = await this.deps.world();
      const deadlineAt = request.deadlineAt ?? null;
      let draft;
      try {
        draft = await this.deps.draft(PLANNER_INSTRUCTIONS, plannerPrompt(request.goal, deadlineAt, world));
      } catch (error) {
        log.warn('planner_unavailable', { message: (error as Error).message });
        return { ok: false, code: 'planner_unavailable', message: 'The planning model is not reachable right now. Check Models in Settings and try again.' };
      }
      const { steps, notes } = validateDraft(draft, world);
      if (!steps.length) {
        log.info('plan_rejected', { proposed: draft.steps.length });
        return { ok: false, code: 'no_valid_steps', message: 'None of the proposed steps pointed at something in your workspace, so there is no plan to show.', notes };
      }
      const stamp = this.now().toISOString();
      const plan: StudyPlan = { schemaVersion: CONTRACT_VERSION, id: this.newId(), goal: request.goal, createdAt: stamp, updatedAt: stamp, deadlineAt, status: 'proposed', steps, notes };
      await this.deps.store.put(plan);
      log.info('plan_proposed', { id: plan.id, steps: steps.length, dropped: draft.steps.length - steps.length });
      return { ok: true, plan };
    });
  }

  async list(): Promise<StudyPlan[]> {
    return this.exclusive(() => this.refresh());
  }

  async get(id: string): Promise<StudyPlan | null> {
    return (await this.list()).find((p) => p.id === id) ?? null;
  }

  async approve(id: string): Promise<PlanActionResult> {
    return this.exclusive(async () => {
      const plans = await this.refresh();
      const plan = plans.find((p) => p.id === id);
      if (!plan) return { ok: false, code: 'not_found', message: 'No such plan.' };
      if (plan.status !== 'proposed') return { ok: false, code: 'not_proposed', message: 'Only a proposed plan can be approved.' };
      const replaced = plan.revisionOf ? plans.find((p) => p.id === plan.revisionOf && p.status === 'active') : undefined;
      const active = plans.filter((p) => p.status === 'active' && p.id !== replaced?.id).length;
      if (active >= MAX_ACTIVE_PLANS) {
        return { ok: false, code: 'too_many_active', message: `You can follow up to ${MAX_ACTIVE_PLANS} plans at once. Finish or abandon one first.` };
      }
      const world = await this.deps.world();
      const stamp = this.now().toISOString();
      const checked = pruneAtApproval(plan, world);
      if (!checked.steps.some((s) => s.state === 'pending')) {
        return { ok: false, code: 'nothing_left', message: 'Everything this plan pointed at has changed since it was proposed. Ask for a new plan.' };
      }
      const approved: StudyPlan = { ...checked, status: 'active', approvedAt: stamp, updatedAt: stamp, basis: world.courseVersions };
      if (replaced) {
        await this.deps.store.put({ ...replaced, status: 'abandoned', updatedAt: stamp, notes: [...replaced.notes, 'Replaced by an approved revision.'].slice(-20) });
      }
      await this.deps.store.put(approved);
      log.info('plan_approved', { id, steps: approved.steps.length, replaced: replaced?.id });
      return { ok: true, plan: approved };
    });
  }

  async abandon(id: string): Promise<PlanActionResult> {
    return this.exclusive(async () => {
      const plan = await this.deps.store.get(id);
      if (!plan) return { ok: false, code: 'not_found', message: 'No such plan.' };
      if (plan.status !== 'proposed' && plan.status !== 'active') return { ok: false, code: 'not_open', message: 'This plan is already closed.' };
      const closed: StudyPlan = { ...plan, status: 'abandoned', updatedAt: this.now().toISOString() };
      await this.deps.store.put(closed);
      log.info('plan_abandoned', { id, was: plan.status });
      return { ok: true, plan: closed };
    });
  }

  /** Pending steps of active plans — what suggestion chips offer as one-click next actions. */
  async pendingSteps(): Promise<PendingPlanStep[]> {
    const plans = await this.list();
    return plans
      .filter((p) => p.status === 'active')
      .flatMap((p) => p.steps.filter((s) => s.state === 'pending').map((step) => ({ planId: p.id, goal: p.goal, deadlineAt: p.deadlineAt, step })));
  }

  /**
   * Brings every active plan up to date with the evidence, proposes revisions for plans that
   * went stale, and prunes old closed plans. Caller holds the queue.
   */
  private async refresh(): Promise<StudyPlan[]> {
    const plans = await this.deps.store.list();
    if (plans.some((p) => p.status === 'active')) {
      const world = await this.deps.world();
      for (const [i, plan] of plans.entries()) {
        let next = recompute(plan, world);
        if (next.status === 'active' && !next.steps.some((s) => s.state === 'pending')) {
          // Nothing left to do and nothing a revision could carry: the plan has run its course.
          const stale = next.steps.filter((s) => s.state === 'stale').length;
          next = { ...next, status: 'completed', updatedAt: world.now.toISOString(), notes: [...next.notes, `Finished with ${stale} step${stale === 1 ? '' : 's'} gone stale.`].slice(-20) };
        }
        if (next === plan) continue;
        plans[i] = next;
        await this.deps.store.put(next);
        log.info('plan_progress', { id: next.id, status: next.status, done: next.steps.filter((s) => s.state === 'done').length, stale: next.steps.filter((s) => s.state === 'stale').length });
        const hasRevision = plans.some((p) => p.revisionOf === next.id && p.status === 'proposed');
        const revision = hasRevision ? null : proposeRevision(next, this.newId(), world.now);
        if (revision) {
          plans.push(revision);
          await this.deps.store.put(revision);
          log.info('plan_revision_proposed', { id: revision.id, revisionOf: next.id, steps: revision.steps.length });
        }
      }
    }
    const closed = plans.filter((p) => p.status === 'completed' || p.status === 'abandoned').sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
    for (const old of closed.slice(MAX_CLOSED_PLANS)) await this.deps.store.remove(old.id);
    const pruned = new Set(closed.slice(MAX_CLOSED_PLANS).map((p) => p.id));
    return plans.filter((p) => !pruned.has(p.id)).sort((a, b) => STATUS_ORDER[a.status] - STATUS_ORDER[b.status] || b.updatedAt.localeCompare(a.updatedAt));
  }
}
