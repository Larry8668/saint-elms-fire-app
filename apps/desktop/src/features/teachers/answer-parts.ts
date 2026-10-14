import type { SourceRef, TeacherId } from '@sef/shared';

const TRAILHEAD_LINE = /^\s*\**trailhead:?\**\s*/i;

/** Separates the Philosopher's closing "Trailhead:" question so it can be shown as a follow-up, not a paragraph. */
export function splitTrailhead(content: string): { body: string; trailhead?: string } {
  const lines = content.trimEnd().split('\n');
  const last = lines.at(-1) ?? '';
  if (!TRAILHEAD_LINE.test(last)) return { body: content };
  const trailhead = last.replace(TRAILHEAD_LINE, '').replace(/\*+$/, '').trim();
  return trailhead ? { body: lines.slice(0, -1).join('\n').trimEnd(), trailhead } : { body: content };
}

/** Same source can be cited by several tool calls; show it once. */
export function uniqueSources(sources: SourceRef[]): SourceRef[] {
  const seen = new Set<string>();
  return sources.filter((s) => {
    const key = `${s.kind}:${s.id}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

/** One-tap replies that keep a Socratic exchange moving without typing. */
export const QUICK_REPLIES: Record<TeacherId, string[]> = {
  friend: [],
  guide: ['Give me a hint', 'Explain it another way', 'Quiz me on this'],
  philosopher: ['Go deeper', 'Where does this break down?'],
};
