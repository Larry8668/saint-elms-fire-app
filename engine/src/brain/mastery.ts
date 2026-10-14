import type { ConceptPage, ConceptStatus } from '@sef/shared';

export const PASS_RATIO = 0.7;

/**
 * Status is computed from evidence only — the model never sets it.
 *  - shaky: any unresolved misconception, or the latest quiz below 70%
 *  - solid: no unresolved misconceptions and the last two quizzes at 70%+
 *  - met:   a page exists, nothing above applies
 */
export function computeStatus(page: Pick<ConceptPage, 'evidence' | 'misconceptions'> | null): ConceptStatus {
  if (!page) return 'unseen';
  if (page.misconceptions.some((m) => !m.resolved)) return 'shaky';
  const quizzes = page.evidence
    .filter((e) => e.kind === 'quiz' && e.score != null && e.outOf)
    .sort((a, b) => a.at.localeCompare(b.at));
  const ratios = quizzes.map((q) => (q.score ?? 0) / (q.outOf ?? 1));
  const latest = ratios.at(-1);
  if (latest != null && latest < PASS_RATIO) return 'shaky';
  if (ratios.length >= 2 && ratios.slice(-2).every((r) => r >= PASS_RATIO)) return 'solid';
  return 'met';
}
