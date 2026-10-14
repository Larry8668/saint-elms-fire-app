import { useMemo } from 'react';
import { WorkingLabel } from '@/components/ui/loading';

const STAR_COUNT = 70;

/** Deterministic pseudo-random so the placeholder sky doesn't jump between renders. */
function seeded(n: number) {
  const x = Math.sin(n * 12.9898) * 43758.5453;
  return x - Math.floor(x);
}

/** Placeholder sky: faint twinkling stars and a working label while the graph is computed. */
export function SkyLoading() {
  const startedAt = useMemo(() => Date.now(), []);
  const stars = useMemo(
    () => Array.from({ length: STAR_COUNT }, (_, i) => ({ x: seeded(i + 1) * 100, y: seeded(i + 101) * 100, size: 1 + seeded(i + 201) * 2, delay: seeded(i + 301) * 3 })),
    [],
  );

  return (
    <div className="sky-backdrop relative m-3 h-[calc(100%-1.5rem)] overflow-hidden rounded-3xl border border-white/[0.06]" aria-busy role="status">
      {stars.map((s, i) => (
        <span
          key={i}
          className="absolute animate-twinkle rounded-full bg-night-300/40"
          style={{ left: `${s.x}%`, top: `${s.y}%`, width: s.size, height: s.size, animationDelay: `${s.delay}s` }}
        />
      ))}
      <div className="absolute inset-0 grid place-items-center">
        <div className="glass flex flex-col items-center gap-2 rounded-2xl px-5 py-4">
          <WorkingLabel label="Charting your sky" startedAt={startedAt} className="text-beacon-300" />
          <p className="text-[12px] text-night-500">Placing every released concept and reading your brain</p>
        </div>
      </div>
    </div>
  );
}
