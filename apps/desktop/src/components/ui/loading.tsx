import { useEffect, useState, type ReactNode } from 'react';
import { cn } from '@/lib/cn';

/** Order in which the 3×3 grid lights up: a spiral, so the motion reads as "turning over" rather than blinking. */
const SPIRAL = [0, 1, 2, 5, 8, 7, 6, 3, 4];
const STEP_MS = 110;

/** Pixel-grid working indicator. Colour comes from `currentColor`, so callers tint it with a text class. */
export function PixelLoader({ className }: { className?: string }) {
  return (
    <span role="presentation" className={cn('inline-grid size-3.5 shrink-0 grid-cols-3 gap-[1.5px]', className)}>
      {Array.from({ length: 9 }, (_, cell) => (
        <span
          key={cell}
          className="rounded-[1px] bg-current"
          style={{ animation: `pixel ${SPIRAL.length * STEP_MS}ms ease-in-out infinite`, animationDelay: `${SPIRAL.indexOf(cell) * STEP_MS}ms` }}
        />
      ))}
    </span>
  );
}

export function ShimmerText({ children, className }: { children: ReactNode; className?: string }) {
  return <span className={cn('text-shimmer', className)}>{children}</span>;
}

/** Seconds since `startedAt`, ticking while `running`; frozen at `endedAt` once finished. */
export function useElapsed(startedAt: number | undefined, endedAt?: number, running = !endedAt): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!running || !startedAt) return;
    const id = window.setInterval(() => setNow(Date.now()), 100);
    return () => window.clearInterval(id);
  }, [running, startedAt]);
  if (!startedAt) return 0;
  return Math.max(0, ((endedAt ?? now) - startedAt) / 1000);
}

export const formatSeconds = (s: number) => (s < 60 ? `${s.toFixed(1)}s` : `${Math.floor(s / 60)}m ${Math.round(s % 60)}s`);

/** "Thinking 3.2s" — the label shimmers so a long local-model wait still looks alive. */
export function WorkingLabel({ label, startedAt, className }: { label: string; startedAt?: number; className?: string }) {
  const seconds = useElapsed(startedAt);
  return (
    <span className={cn('inline-flex items-center gap-2 text-[13px]', className)} aria-live="polite">
      <PixelLoader />
      <ShimmerText className="font-medium">{label}</ShimmerText>
      {startedAt && <span className="font-mono text-[11.5px] text-night-500 tabular-nums">{formatSeconds(seconds)}</span>}
    </span>
  );
}
