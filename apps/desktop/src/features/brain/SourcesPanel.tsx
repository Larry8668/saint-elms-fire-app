import { motion } from 'motion/react';
import type { JobList, SourceSummary, WikiJob } from '@sef/shared';
import { Badge, Eyebrow, Panel, Skeleton } from '@/components/ui/primitives';
import { cn } from '@/lib/cn';
import { timeAgo } from '@/lib/time';
import { STAGE_INFO, isLiveJob, sourceKindLabel } from '@/features/contribute/review';
import { SOURCE_KIND_ICON } from './SourceDetail';

function SourceRow({ source, job, onOpen, index }: { source: SourceSummary; job: WikiJob | undefined; onOpen: () => void; index: number }) {
  const Icon = SOURCE_KIND_ICON[source.kind];
  const stage = job ? STAGE_INFO[job.stage] : null;
  return (
    <motion.button
      initial={{ opacity: 0, y: 6 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ delay: index * 0.03 }}
      onClick={onOpen}
      className="flex w-full items-center gap-3 rounded-xl border border-white/[0.06] bg-white/[0.02] px-3.5 py-3 text-left transition hover:border-white/[0.14]"
    >
      <span className="grid size-9 shrink-0 place-items-center rounded-lg bg-white/[0.05] text-beacon-300">
        <Icon className="size-4" />
      </span>
      <span className="min-w-0 flex-1">
        <span className="block truncate text-[13.5px] font-medium text-night-100">{source.title}</span>
        <span className="mt-0.5 flex flex-wrap items-center gap-1.5 text-[11px] text-night-500">
          <span>{sourceKindLabel(source.kind)}</span>
          <span>·</span>
          <span>{timeAgo(source.capturedAt)}</span>
          {source.partial && (
            <>
              <span>·</span>
              <span className="text-ember-300">partial read</span>
            </>
          )}
          {!source.extracted && (
            <>
              <span>·</span>
              <span className="text-ember-300">no text yet</span>
            </>
          )}
        </span>
      </span>
      {stage && isLiveJob(job!.stage) && <Badge tone={stage.tone}>{stage.label}</Badge>}
    </motion.button>
  );
}

/**
 * Everything kept under raw/ — immutable originals plus their reading state. A row opens
 * the source detail; a live job's stage rides along so the list is also the pipeline view.
 */
export function SourcesPanel({ board, loading, onOpen, className }: { board: JobList | undefined; loading: boolean; onOpen: (sourceId: string) => void; className?: string }) {
  if (loading) {
    return (
      <div className={cn('space-y-2', className)}>
        {[0, 1, 2].map((i) => (
          <Skeleton key={i} className="h-14 w-full rounded-xl" />
        ))}
      </div>
    );
  }
  const sources = board?.sources ?? [];
  if (!sources.length) {
    return (
      <Panel className={cn('p-5', className)}>
        <Eyebrow className="mb-3">Kept sources</Eyebrow>
        <p className="text-[13px] text-night-400">Nothing filed yet — every contribution is kept here, byte-for-byte, before anything reads it.</p>
      </Panel>
    );
  }
  const jobBySource = new Map<string, WikiJob>();
  for (const job of board?.jobs ?? []) for (const id of job.sourceIds) jobBySource.set(id, job);
  return (
    <div className={cn('space-y-2', className)}>
      {sources.map((source, i) => (
        <SourceRow key={source.id} source={source} job={jobBySource.get(source.id)} onOpen={() => onOpen(source.id)} index={i} />
      ))}
    </div>
  );
}
