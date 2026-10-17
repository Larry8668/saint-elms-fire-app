/** Flavour copy for "connecting" waits. It never claims a step happened; real progress is shown beside it. */
export const CONNECTING_LINES = [
  'Establishing a connection with your data…',
  'Waking your workspace…',
  'Restoring your notes…',
  'Warming up your teachers…',
  'Almost there…',
] as const;

export const COPY_CYCLE_MS = 2_500;

export interface CopyCyclerOptions {
  count: number;
  onChange: (index: number) => void;
  intervalMs?: number;
  /** Reduced motion holds the first line: no cycling at all. */
  reducedMotion?: boolean;
}

/**
 * Steps through `count` lines in order, wrapping at the end, on a fixed interval (no jitter).
 * Timers are read from the global scope at call time so tests can swap them.
 */
export function startCopyCycle({ count, onChange, intervalMs = COPY_CYCLE_MS, reducedMotion = false }: CopyCyclerOptions): () => void {
  if (reducedMotion || count < 2) return () => {};
  let index = 0;
  const id = setInterval(() => {
    index = (index + 1) % count;
    onChange(index);
  }, intervalMs);
  return () => clearInterval(id);
}
