import { useEffect, useState } from 'react';
import { cn } from '@/lib/cn';
import { useMediaQuery } from '@/lib/use-media-query';
import { CONNECTING_LINES, startCopyCycle } from './copy-cycle';
import { formatSeconds, PixelLoader, ShimmerText, useElapsed } from './loading';

/** Outer stars, in a 200×100 box, that link toward the centre node (the student's data). */
const STARS = [
  { x: 18, y: 32, r: 1.4 },
  { x: 46, y: 84, r: 1.1 },
  { x: 66, y: 14, r: 1.6 },
  { x: 136, y: 88, r: 1.3 },
  { x: 158, y: 16, r: 1.1 },
  { x: 184, y: 60, r: 1.5 },
] as const;
const CENTRE = { x: 100, y: 50 };
/** Faint links between neighbouring stars, so the outer ring reads as a constellation. */
const RING: Array<[number, number]> = [
  [0, 2],
  [2, 4],
  [4, 5],
  [5, 3],
  [3, 1],
];

export function useCyclingLine(lines: readonly string[]): number {
  const reducedMotion = useMediaQuery('(prefers-reduced-motion: reduce)');
  const [index, setIndex] = useState(0);
  useEffect(() => {
    return startCopyCycle({ count: lines.length, onChange: setIndex, reducedMotion });
  }, [lines, reducedMotion]);
  return index;
}

function ConnectingMotif({ className }: { className?: string }) {
  return (
    <svg viewBox="0 0 200 100" role="presentation" aria-hidden className={cn('connecting-scene w-full overflow-visible', className)}>
      <g className="text-night-400" stroke="currentColor" strokeWidth={0.5} opacity={0.18}>
        {RING.map(([a, b]) => (
          <line key={`${a}-${b}`} x1={STARS[a].x} y1={STARS[a].y} x2={STARS[b].x} y2={STARS[b].y} />
        ))}
      </g>
      <g className="text-night-400" stroke="currentColor" strokeWidth={0.6} opacity={0.3}>
        {STARS.map((s) => (
          <line key={`${s.x}-${s.y}`} x1={s.x} y1={s.y} x2={CENTRE.x} y2={CENTRE.y} />
        ))}
      </g>
      <g className="text-beacon-200" stroke="currentColor" strokeWidth={1.1} strokeLinecap="round" fill="none">
        {STARS.map((s, i) => (
          <path
            key={`${s.x}-${s.y}`}
            d={`M${s.x} ${s.y} L${CENTRE.x} ${CENTRE.y}`}
            pathLength={1}
            className="connecting-pulse"
            style={{ animationDelay: `${i * 0.45}s` }}
          />
        ))}
      </g>
      <g className="text-night-200" fill="currentColor">
        {STARS.map((s, i) => (
          <circle key={`${s.x}-${s.y}`} cx={s.x} cy={s.y} r={s.r} className="animate-twinkle" style={{ animationDelay: `${i * 0.45}s` }} />
        ))}
      </g>
      <circle cx={CENTRE.x} cy={CENTRE.y} r={8} className="connecting-halo text-beacon-300" fill="none" stroke="currentColor" strokeWidth={0.6} />
      <circle cx={CENTRE.x} cy={CENTRE.y} r={3.2} className="text-beacon-200" fill="currentColor" />
    </svg>
  );
}

/**
 * "Linking your device to your data": a small constellation drawing toward a centre node, a real
 * `step` (when the caller has one) as the primary line, and cycling flavour copy under it. Without
 * a step the flavour copy is the primary line. The elapsed time shows either way.
 */
export function ConnectingScene({ step, startedAt, size = 'md', className }: { step?: string; startedAt?: number; size?: 'sm' | 'md'; className?: string }) {
  const index = useCyclingLine(CONNECTING_LINES);
  const seconds = useElapsed(startedAt);
  const line = CONNECTING_LINES[index];

  return (
    <div className={cn('flex min-w-0 flex-col items-center text-center', className)}>
      <ConnectingMotif className={size === 'sm' ? 'max-w-[168px]' : 'max-w-[232px]'} />
      {step ? (
        // Inline, not flex: a long step wraps as one centred sentence with the loader and timer beside its words.
        <p className={cn('mt-3 max-w-full text-balance text-beacon-200', size === 'sm' ? 'text-[13px]' : 'text-[14px]')} aria-live="polite">
          <PixelLoader className="relative -top-px mr-2 align-middle" />
          <ShimmerText className="font-medium">{step}</ShimmerText>
          {startedAt && <span className="ml-2 font-mono text-[11.5px] whitespace-nowrap text-night-500 tabular-nums">{formatSeconds(seconds)}</span>}
        </p>
      ) : (
        <span className="sr-only" role="status">
          {CONNECTING_LINES[0]}
        </span>
      )}
      <div aria-hidden className={cn('mt-1.5 flex h-6 max-w-full items-center justify-center gap-2 overflow-hidden', step ? 'text-[12.5px] text-night-400' : 'text-[14px] text-beacon-200')}>
        {!step && <PixelLoader />}
        <span key={index} className="connecting-copy truncate">
          {step ? line : <ShimmerText className="font-medium">{line}</ShimmerText>}
        </span>
        {!step && startedAt && <span className="font-mono text-[11.5px] text-night-500 tabular-nums">{formatSeconds(seconds)}</span>}
      </div>
    </div>
  );
}
