import type { Verification } from '@sef/shared';

export const SEGMENT_LABEL = { fact: 'facts', belief: 'student beliefs', deduction: 'deductions', uncertainty: 'uncertainty', question: 'questions', other: 'other' } as const;

/** What the served answer was made of, and what was kept back. */
export function segmentSummary(verification: Verification): string | null {
  if (!verification.segments?.length && !verification.withheld) return null;
  const counts = new Map<string, number>();
  for (const s of verification.segments ?? []) counts.set(s.kind, (counts.get(s.kind) ?? 0) + 1);
  const parts = [...counts.entries()].map(([kind, n]) => `${n} ${SEGMENT_LABEL[kind as keyof typeof SEGMENT_LABEL] ?? kind}`);
  if (verification.withheld) parts.push(`${verification.withheld} withheld`);
  return parts.join(' · ');
}

/** Whether the answer was computed on this device or by a hosted provider — plain disclosure, never silent. */
export function providerDisclosure(verification: Verification): string | null {
  if (!verification.providerKind) return null;
  return verification.providerKind === 'ollama' ? 'on this device' : 'hosted — your messages left this device';
}
