import { useEffect, useState } from 'react';
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

/**
 * "Saving…" label for work in flight. Announced, so a screen reader hears the wait too. The
 * shaped skeletons around it do the visual work; nothing here is a bare spinner.
 */
export function WorkingLabel({ label, className }: { label: string; className?: string }) {
  const [visible, setVisible] = useState(false);

  // Held briefly so a fast request does not flash a label that is gone before it is read.
  useEffect(() => {
    setVisible(false);
    const id = window.setTimeout(() => setVisible(true), 150);
    return () => window.clearTimeout(id);
  }, [label]);

  return (
    <span className={cn('inline-flex items-center gap-2 text-beacon-200', className)} aria-live="polite" aria-busy>
      {visible && <PixelLoader />}
      <span className="text-shimmer text-[13px] font-medium">{label}</span>
    </span>
  );
}