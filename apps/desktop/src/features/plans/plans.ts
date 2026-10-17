import type { PlanStep, StudyPlan } from '@sef/shared';
import type { NavState, View } from '@/lib/nav';

/** Where a step's one click takes the student. The student still does the step; nothing runs. */
export type StepAction = { label: string; view: View; params: Omit<NavState, 'view'> } | { label: string; hint: string };

const idOf = (ref: string) => ref.slice(ref.indexOf(':') + 1);

export function stepAction(step: PlanStep): StepAction {
  const id = idOf(step.entityRefs[0]!);
  switch (step.kind) {
    case 'review_page':
      return { label: 'Open in sky', view: 'sky', params: { page: id } };
    case 'read_lesson':
      return { label: 'Read lesson', view: 'library', params: { lessonId: id } };
    case 'quiz':
      return { label: 'Ask the Guide', view: 'teachers', params: { teacher: 'guide', draft: `Quiz me on ${step.subject}.` } };
    case 'answer_question':
      return { label: 'Work on it', view: 'teachers', params: { teacher: 'guide', draft: `Help me work through my open question: ${step.subject}` } };
    case 'resolve_signal':
      return { label: 'In Attention', hint: 'Handle this from the Attention panel (bell in the sidebar).' };
  }
}

/** What each resolved reference is, in words — shown in the proposal preview before approval. */
export function refLabel(ref: string): string {
  const prefix = ref.slice(0, ref.indexOf(':'));
  return { page: 'Page', lesson: 'Lesson', signal: 'Signal' }[prefix] ?? 'Item';
}

const DAY = 86_400_000;

/** "due in 3 days", "due today", "2 days overdue" — or null with no deadline. */
export function countdown(deadlineAt: string | null, now = Date.now()): { text: string; urgent: boolean } | null {
  if (!deadlineAt) return null;
  const due = Date.parse(deadlineAt);
  if (Number.isNaN(due)) return null;
  const days = Math.floor((due - now) / DAY);
  if (due < now) {
    const late = Math.max(1, Math.ceil((now - due) / DAY));
    return { text: `${late} day${late === 1 ? '' : 's'} overdue`, urgent: true };
  }
  if (days === 0) return { text: 'due today', urgent: true };
  return { text: `due in ${days} day${days === 1 ? '' : 's'}`, urgent: days <= 2 };
}

export function progressOf(plan: StudyPlan): { done: number; stale: number; total: number } {
  return {
    done: plan.steps.filter((s) => s.state === 'done').length,
    stale: plan.steps.filter((s) => s.state === 'stale').length,
    total: plan.steps.length,
  };
}

/** Active and waiting plans, plus the most recently finished one so a completion is seen once. */
export function visiblePlans(plans: StudyPlan[]): StudyPlan[] {
  const open = plans.filter((p) => p.status === 'active' || p.status === 'proposed');
  const finished = plans.filter((p) => p.status === 'completed').sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))[0];
  return finished ? [...open, finished] : open;
}

/** A date input's YYYY-MM-DD as the end of that local day, which is what "by Thursday" means. */
export function deadlineFromDate(value: string): string | undefined {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return undefined;
  const [y, m, d] = value.split('-').map(Number) as [number, number, number];
  const end = new Date(y, m - 1, d, 23, 59, 0, 0);
  return Number.isNaN(end.getTime()) ? undefined : end.toISOString();
}
