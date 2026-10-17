import type { PlanStep, StudyPlan } from '@sef/shared';
import { resolveRef } from './validate';
import type { PlanWorld } from './world';

const after = (iso: string, since: string) => Date.parse(iso) > Date.parse(since);
const firstAfter = (times: string[], since: string) => times.filter((t) => after(t, since)).sort()[0] ?? null;
const primaryId = (step: PlanStep) => step.entityRefs[0]!.slice(step.entityRefs[0]!.indexOf(':') + 1);

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
      // A signal that is no longer live has been dealt with (or no longer applies).
      return world.signals.has(id) ? null : world.now.toISOString();
  }
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
    steps: kept.map((s, i) => ({ ...s, id: `st_${i + 1}` })),
    notes: [`Revised: ${dropped} step${dropped === 1 ? '' : 's'} removed because what they referred to changed. Approve to replace the current plan.`],
  };
}
