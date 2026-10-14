import type { VerificationCheck } from '@sef/shared';

/**
 * The Philosopher's contract: every substantive line starts with [course] or [web],
 * and the answer ends with exactly one "Trailhead:" question.
 */
export function checkPhilosopherFormat(text: string): VerificationCheck[] {
  const lines = text.split('\n').map((l) => l.trim()).filter(Boolean);
  const trailheads = lines.filter((l) => /^\**trailhead:?\**/i.test(l));
  const body = lines.filter((l) => !/^\**trailhead:?\**/i.test(l) && !/^#+\s/.test(l) && l.length > 25);
  const untagged = body.filter((l) => !/^[-*\d.\s]*\[(course|web)\]/i.test(l));
  const lastIsTrailhead = lines.length > 0 && /^\**trailhead:?\**/i.test(lines.at(-1)!);
  return [
    {
      id: 'tagged-lines',
      label: 'Every claim is tagged [course] or [web]',
      passed: untagged.length === 0 && body.length > 0,
      detail: untagged.length ? `${untagged.length} untagged line${untagged.length > 1 ? 's' : ''}` : undefined,
    },
    {
      id: 'one-trailhead',
      label: 'Ends with exactly one Trailhead question',
      passed: trailheads.length === 1 && lastIsTrailhead,
      detail: trailheads.length !== 1 ? `${trailheads.length} trailheads found` : undefined,
    },
  ];
}

/** Rewrites untagged lines rather than re-asking a slow model: deterministic repair. */
export function repairPhilosopherFormat(text: string, webAvailable: boolean): string {
  const lines = text.split('\n');
  const isTrail = (l: string) => /^\**trailhead:?\**/i.test(l.trim());
  const trail = lines.filter(isTrail);
  const repaired = lines
    .filter((l) => !isTrail(l))
    .map((line) => {
      const trimmed = line.trim();
      if (!trimmed || trimmed.length <= 25 || /^#+\s/.test(trimmed) || /\[(course|web)\]/i.test(trimmed)) return line;
      const tag = webAvailable && /https?:\/\/|according to|reported|recent|today|\b(19|20)\d{2}\b/i.test(trimmed) ? '[web]' : '[course]';
      const bullet = trimmed.match(/^([-*]|\d+\.)\s+/);
      return bullet ? `${bullet[0]}${tag} ${trimmed.slice(bullet[0].length)}` : `${tag} ${trimmed}`;
    });
  const question = trail[0]?.trim() ?? 'Trailhead: Where else might this idea show up in your own life?';
  return `${repaired.join('\n').trimEnd()}\n\n${question.replace(/^\**trailhead:?\**\s*/i, 'Trailhead: ')}`;
}

export function checkGrounding(sourceCount: number, text: string): VerificationCheck {
  const admitsGap = /not (in|covered|part of) (your|the) (released )?(lessons|courseware|syllabus)|isn't covered|outside (your|the) (released )?(lessons|syllabus)/i.test(text);
  return {
    id: 'grounded',
    label: 'Answer grounded in released lessons',
    passed: sourceCount > 0 || admitsGap,
    detail: sourceCount > 0 ? `${sourceCount} lesson source${sourceCount > 1 ? 's' : ''}` : admitsGap ? 'Said it is not covered' : 'No lesson matched',
  };
}
