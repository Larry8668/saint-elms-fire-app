import type { ConceptPage, ConceptStatus } from '@sef/shared';

export const PASS_RATIO = 0.7;

/**
 * Status is computed from evidence only — the model never sets it.
 *  - shaky: any unresolved misconception, or the latest quiz below 70%
 *  - solid: no unresolved misconceptions and the last two quizzes at 70%+
 *  - met:   a page exists, nothing above applies
 *
 * Quiz evidence is deduplicated by attempt: the same quiz (`ref`) submitted again — a retry,
 * a replay, a re-imported seed — counts once, keeping its newest attempt. 'Solid' therefore
 * always means two *different* checks passed, and generated checks only ever signal, never
 * certify, mastery. Only the student's own attempts reach a page's evidenceIds, so collected
 * or peer material cannot feed this computation.
 */
export function computeStatus(page: Pick<ConceptPage, 'evidence' | 'misconceptions'> | null): ConceptStatus {
  if (!page) return 'unseen';
  if (page.misconceptions.some((m) => !m.resolved)) return 'shaky';
  const attempts = new Map<string, { score: number; outOf: number; at: string }>();
  for (const e of page.evidence) {
    if (e.kind !== 'quiz' || e.score == null || !e.outOf) continue;
    const kept = attempts.get(e.ref);
    if (!kept || kept.at <= e.at) attempts.set(e.ref, { score: e.score, outOf: e.outOf, at: e.at });
  }
  const ratios = [...attempts.values()].sort((a, b) => a.at.localeCompare(b.at)).map((q) => q.score / q.outOf);
  const latest = ratios.at(-1);
  if (latest != null && latest < PASS_RATIO) return 'shaky';
  if (ratios.length >= 2 && ratios.slice(-2).every((r) => r >= PASS_RATIO)) return 'solid';
  return 'met';
}
