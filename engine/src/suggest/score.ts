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

/** Highest score first; the key breaks ties so the order is fully deterministic. */
export function rank(seeds: Seed[], now: Date, recentTurns: readonly string[]): Seed[] {
  return seeds
    .map((seed) => ({ seed, value: score(seed, now, recentTurns) }))
    .sort((a, b) => b.value - a.value || a.seed.key.localeCompare(b.seed.key))
    .map(({ seed }) => seed);
}
