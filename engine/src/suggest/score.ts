import type { Seed } from './seeds';

const RECENCY_HALF_LIFE_MS = 7 * 86_400_000;
const NOVELTY_PENALTY = 2;

/** True when a recent student turn already names one of the seed's entities. */
export function recentlyAsked(seed: Seed, recentTurns: readonly string[]): boolean {
  const names = Object.values(seed.slots)
    .filter((value) => value.length >= 3 && !/^(monday|tuesday|wednesday|thursday|friday|saturday|sunday)$/i.test(value))
    .map((value) => value.toLowerCase());
  return recentTurns.some((turn) => {
    const text = turn.toLowerCase();
    return names.some((name) => text.includes(name));
  });
}

/** Urgency dominates, recency decays over a week, and a recently asked topic is pushed down. */
export function score(seed: Seed, now: Date, recentTurns: readonly string[]): number {
  const age = Math.max(0, now.getTime() - seed.at);
  const recency = Math.pow(0.5, age / RECENCY_HALF_LIFE_MS);
  return seed.urgency * 3 + recency - (recentlyAsked(seed, recentTurns) ? NOVELTY_PENALTY : 0);
}

/**
 * Takes `limit` seeds in rank order with at most `perKind` of any one kind, so five weak
 * concepts cannot crowd out everything else; skipped seeds backfill only if the bank is short.
 */
export function diversify(ranked: Seed[], limit: number, perKind = 2): Seed[] {
  const counts = new Map<string, number>();
  const picked: Seed[] = [];
  const skipped: Seed[] = [];
  for (const seed of ranked) {
    const n = counts.get(seed.kind) ?? 0;
    if (n < perKind) {
      counts.set(seed.kind, n + 1);
      picked.push(seed);
    } else skipped.push(seed);
  }
  const order = new Map(ranked.map((seed, i) => [seed.key, i]));
  return [...picked.slice(0, limit), ...skipped.slice(0, Math.max(0, limit - picked.length))].sort((a, b) => order.get(a.key)! - order.get(b.key)!);
}

/** Highest score first; the key breaks ties so the order is fully deterministic. */
export function rank(seeds: Seed[], now: Date, recentTurns: readonly string[]): Seed[] {
  return seeds
    .map((seed) => ({ seed, value: score(seed, now, recentTurns) }))
    .sort((a, b) => b.value - a.value || a.seed.key.localeCompare(b.seed.key))
    .map(({ seed }) => seed);
}
