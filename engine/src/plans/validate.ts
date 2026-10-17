import { EntityRefSchema, MAX_PLAN_STEPS, PLAN_STEP_KINDS, type PlannerDraft, type PlanStep, type PlanStepKind } from '@sef/shared';
import { log } from '../config';
import type { PlanWorld } from './world';

const clip = (text: string, max: number) => {
  const flat = text.replace(/\s+/g, ' ').trim();
  return flat.length > max ? `${flat.slice(0, max - 1)}…` : flat;
};

/** What a reference points at, if it exists right now. */
export function resolveRef(ref: string, world: PlanWorld): { prefix: string; id: string; title: string; pageKind?: string } | null {
  if (!EntityRefSchema.safeParse(ref).success) return null;
  const at = ref.indexOf(':');
  const prefix = ref.slice(0, at);
  const id = ref.slice(at + 1);
  if (prefix === 'page') {
    const page = world.pages.get(id);
    return page ? { prefix, id, title: page.title, pageKind: page.kind } : null;
  }
  if (prefix === 'lesson') {
    const lesson = world.lessons.get(id);
    return lesson ? { prefix, id, title: lesson.title } : null;
  }
  const signal = world.signals.get(id);
  return signal ? { prefix, id, title: signal.title } : null;
}

/** The reference each step kind is *about*; the step is meaningless without one. */
const PRIMARY: Record<PlanStepKind, (r: NonNullable<ReturnType<typeof resolveRef>>) => boolean> = {
  review_page: (r) => r.prefix === 'page',
  read_lesson: (r) => r.prefix === 'lesson',
  answer_question: (r) => r.prefix === 'page' && r.pageKind === 'question',
  quiz: (r) => r.prefix === 'page' && r.pageKind === 'concept',
  resolve_signal: (r) => r.prefix === 'signal',
};

const DEFAULT_TITLE: Record<PlanStepKind, (subject: string) => string> = {
  review_page: (s) => `Review ${s}`,
  read_lesson: (s) => `Read “${s}”`,
  answer_question: (s) => `Work on: ${s}`,
  quiz: (s) => `Quiz yourself on ${s}`,
  resolve_signal: (s) => `Deal with: ${s}`,
};

const isKind = (kind: string): kind is PlanStepKind => (PLAN_STEP_KINDS as readonly string[]).includes(kind);

/**
 * Code decides. Every proposed step's references must resolve against the workspace as it
 * is now, and one of them must be the kind of thing the step is about. Anything else is
 * dropped and disclosed — never guessed. State is always `pending`: the draft cannot carry one.
 */
export function validateDraft(draft: PlannerDraft, world: PlanWorld): { steps: PlanStep[]; notes: string[] } {
  const steps: PlanStep[] = [];
  const notes: string[] = [];
  const seen = new Set<string>();
  const drop = (title: string, reason: string, kind?: string) => {
    log.info('dropped_step', { kind, reason });
    notes.push(clip(`Dropped “${clip(title || 'untitled step', 80)}”: ${reason}`, 300));
  };

  for (const raw of draft.steps) {
    if (!isKind(raw.kind)) {
      drop(raw.title, `“${clip(raw.kind, 40)}” is not a kind of step this app can track`, raw.kind);
      continue;
    }
    const refs = [...new Set(raw.entityRefs)].slice(0, 5);
    const resolved = refs.map((ref) => ({ ref, hit: resolveRef(ref, world) }));
    const missing = resolved.filter((r) => !r.hit).map((r) => clip(r.ref, 60));
    if (!refs.length || missing.length) {
      drop(raw.title, refs.length ? `refers to something not in your workspace (${missing.join(', ')})` : 'it names nothing to work on', raw.kind);
      continue;
    }
    const primary = resolved.find((r) => PRIMARY[raw.kind as PlanStepKind](r.hit!));
    if (!primary) {
      drop(raw.title, `none of its references is the right kind of thing for a “${raw.kind}” step`, raw.kind);
      continue;
    }
    const dedupe = `${raw.kind}|${primary.ref}`;
    if (seen.has(dedupe)) continue;
    seen.add(dedupe);
    const subject = clip(primary.hit!.title, 200);
    steps.push({
      id: `st_${steps.length + 1}`,
      title: clip(raw.title, 160) || DEFAULT_TITLE[raw.kind](subject),
      detail: clip(raw.detail ?? '', 400),
      kind: raw.kind,
      // Primary first, so chips and deep links can rely on entityRefs[0].
      entityRefs: [primary.ref, ...refs.filter((r) => r !== primary.ref)],
      subject,
      state: 'pending',
    });
  }

  if (steps.length > MAX_PLAN_STEPS) {
    notes.push(`Kept the first ${MAX_PLAN_STEPS} of ${steps.length} steps — plans stay short on purpose.`);
    steps.length = MAX_PLAN_STEPS;
  }
  return { steps, notes };
}
