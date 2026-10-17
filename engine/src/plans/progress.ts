import type { PlanStep, StudyPlan } from '@sef/shared';
import { resolveRef } from './validate';
import type { PlanWorld } from './world';

const after = (iso: string, since: string) => Date.parse(iso) > Date.parse(since);
const firstAfter = (times: string[], since: string) => times.filter((t) => after(t, since)).sort()[0] ?? null;
const primaryId = (step: PlanStep) => {
  const ref = step.entityRefs[0] ?? '';
  return ref.slice(ref.indexOf(':') + 1);
};

/** When the evidence says this step happened, or null. Pure reads — the student did the work. */
export function evidenceOfDone(step: PlanStep, since: string, world: PlanWorld): string | null {
  const id = primaryId(step);
  switch (step.kind) {
    case 'review_page':
      return firstAfter(world.events.filter((e) => e.pageId === id).map((e) => e.at), since);
    case 'answer_question': {
      const page = world.pages.get(id);
      const touched = [...world.events.filter((e) => e.pageId === id).map((e) => e.at), ...(page ? [page.updatedAt] : [])];
      return firstAfter(touched, since);
    }
    case 'quiz':
      return firstAfter(world.quizzes.filter((q) => q.pageId === id).map((q) => q.at), since);
    case 'read_lesson':
      return firstAfter(world.lessonActivity.filter((a) => a.lessonId === id).map((a) => a.at), since);
    case 'resolve_signal':
      // Ledgers keep no clearance time, so this is when the change was first observed. A
      // signal already gone at approval never reaches here: approval marks that step stale.
      return world.signals.has(id) ? null : world.now.toISOString();
  }
}

/**
 * Drops pending steps that stopped making sense between proposal and approval — their entity
 * is gone or their signal already cleared — and discloses each. Without this a cleared signal
 * would be credited as done work the moment tracking began.
 */
export function pruneAtApproval(plan: StudyPlan, world: PlanWorld): StudyPlan {
  const notes = [...plan.notes];
  const steps = plan.steps.filter((step) => {
    if (step.state !== 'pending') return true;
    const gone = step.kind === 'resolve_signal' ? !world.signals.has(primaryId(step)) : Boolean(staleReason(step, { ...plan, basis: undefined }, world));
    if (gone) notes.push(`Dropped “${step.title}”: what it referred to changed before the plan started.`.slice(0, 300));
    return !gone;
  });
  return { ...plan, steps, notes: notes.slice(-20) };
}

/** Why a pending step can no longer be done as written, or null. */
export function staleReason(step: PlanStep, plan: StudyPlan, world: PlanWorld): string | null {
  if (step.kind !== 'resolve_signal') {
    const gone = step.entityRefs.filter((ref) => !resolveRef(ref, world));
    if (gone.length) return `“${step.subject}” changed or was removed`;
  }
  if (step.kind === 'read_lesson' && plan.basis) {
    const lesson = world.lessons.get(primaryId(step));
    const then = lesson && plan.basis[lesson.courseId];
    if (lesson && then && world.courseVersions[lesson.courseId] !== then) return `a new release of “${step.subject}”'s course landed`;
  }
  return null;
}

/**
 * Recomputes an active plan from evidence. Done never reverts; pending becomes done or stale.
 * Returns the same object when nothing changed.
 */
export function recompute(plan: StudyPlan, world: PlanWorld): StudyPlan {
  if (plan.status !== 'active' || !plan.approvedAt) return plan;
  const since = plan.approvedAt;
  let changed = false;
  const notes = [...plan.notes];
  const steps = plan.steps.map((step): PlanStep => {
    if (step.state !== 'pending') return step;
    const doneAt = evidenceOfDone(step, since, world);
    if (doneAt) {
      changed = true;
      return { ...step, state: 'done', doneAt };
    }
    const stale = staleReason(step, plan, world);
    if (stale) {
      changed = true;
      notes.push(`Step “${step.title}” is stale: ${stale}.`.slice(0, 300));
      return { ...step, state: 'stale' };
    }
    return step;
  });
  if (!changed) return plan;
  const pending = steps.some((s) => s.state === 'pending');
  const stale = steps.some((s) => s.state === 'stale');
  const status = !pending && !stale ? 'completed' : plan.status;
  return { ...plan, steps, notes: notes.slice(-20), status, updatedAt: world.now.toISOString() };
}

/**
 * A revision of an active plan with stale steps: the stale ones removed, done ones kept as
 * history, pending ones carried. Null when nothing would be left to do — the student
 * re-approves a revision; the original is never rewritten in place.
 */
export function proposeRevision(plan: StudyPlan, id: string, now: Date): StudyPlan | null {
  if (plan.status !== 'active' || !plan.steps.some((s) => s.state === 'stale')) return null;
  const kept = plan.steps.filter((s) => s.state !== 'stale');
  if (!kept.some((s) => s.state === 'pending')) return null;
  const dropped = plan.steps.length - kept.length;
  const stamp = now.toISOString();
  return {
    ...plan,
    id,
    status: 'proposed',
    createdAt: stamp,
    updatedAt: stamp,
    approvedAt: undefined,
    basis: undefined,
    revisionOf: plan.id,
    // Step ids are kept, so a done step's id names the same step in the original and the revision.
    steps: kept,
    notes: [`Revised: ${dropped} step${dropped === 1 ? '' : 's'} removed because what they referred to changed. Approve to replace the current plan.`],
  };
}
