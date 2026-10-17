import type { SignalKind } from '@sef/shared';
import { RefreshCw } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Eyebrow, Panel } from '@/components/ui/primitives';
import { KIND_LABEL } from '@/features/attention/attention';
import { cn } from '@/lib/cn';
import { useMetrics } from '@/lib/queries';
import { metricRows, topSignals, type MetricRow } from './teacher-metrics';

/** Read-only, local-only counters: did the teachers' proactivity help, and did it stay honest? */
export function TeacherMetricsCard() {
  const metrics = useMetrics();
  const report = metrics.data;

  return (
    <section aria-label="How your teachers are doing">
      <div className="mb-3 flex items-center justify-between">
        <Eyebrow>How your teachers are doing</Eyebrow>
        <Button variant="ghost" size="sm" loading={metrics.isFetching} onClick={() => void metrics.refetch()} aria-label="Refresh teacher metrics">
          <RefreshCw className="h-3.5 w-3.5" />
        </Button>
      </div>
      <Panel className="space-y-4 p-5">
        <p className="text-[12.5px] text-night-400">Counted on this device from your own activity. Never exported, never sent anywhere.</p>
        {metrics.isError && <p className="text-[12.5px] text-rose-300">Couldn't load the counters. The engine may be offline.</p>}
        {metrics.isPending && <p className="text-[12.5px] text-night-400">Loading…</p>}
        {report && (
          <>
            <div className="grid gap-2 sm:grid-cols-2">
              {metricRows(report).map((row) => (
                <MetricTile key={row.id} row={row} />
              ))}
            </div>
            <Footer stepsDone={report.planStepsCompleted} since={report.since} signals={topSignals(report)} />
          </>
        )}
      </Panel>
    </section>
  );
}

function MetricTile({ row }: { row: MetricRow }) {
  const good = row.rate === null ? null : row.better === 'higher' ? row.rate >= 0.5 : row.rate <= 0.2;
  return (
    <div className="rounded-lg border border-white/[0.06] px-3 py-2" title={row.hint}>
      <div className="text-[12px] text-night-400">{row.label}</div>
      <div className={cn('text-sm font-medium', good === null ? 'text-night-200' : good ? 'text-emerald-300' : 'text-amber-300')}>{row.value}</div>
    </div>
  );
}

function Footer({ stepsDone, since, signals }: { stepsDone: number; since: string | null; signals: Array<{ kind: string; count: number }> }) {
  return (
    <div className="flex flex-wrap items-center gap-x-4 gap-y-1 text-[12px] text-night-400">
      <span>{stepsDone} plan steps completed</span>
      {signals.length > 0 && <span>Most nudges: {signals.map((s) => `${KIND_LABEL[s.kind as SignalKind] ?? s.kind} (${s.count})`).join(', ')}</span>}
      {since && <span>Since {new Date(since).toLocaleDateString()}</span>}
    </div>
  );
}
