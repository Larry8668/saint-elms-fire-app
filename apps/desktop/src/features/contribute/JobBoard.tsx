import { useMutation } from '@tanstack/react-query';
import { ArrowRight, Inbox } from 'lucide-react';
import { motion } from 'motion/react';
import { useEffect, useRef, useState } from 'react';
import { toast } from 'sonner';
import type { JobList, SourceSummary, WikiJob } from '@sef/shared';
import { Button } from '@/components/ui/button';
import { ConfirmButton } from '@/components/ui/confirm-button';
import { WorkingLabel } from '@/components/ui/loading';
import { Badge, EmptyState, Eyebrow, Panel } from '@/components/ui/primitives';
import { SOURCE_KIND_ICON } from '@/features/brain/SourceDetail';
import { api } from '@/lib/api';
import { cn } from '@/lib/cn';
import { useInvalidateBrain } from '@/lib/queries';
import { timeAgo } from '@/lib/time';
import { FLOW_STEPS, STAGE_INFO, canWithdraw, flowStep, isLiveJob, isWorking, readingLabel, sourceKindLabel } from './review';

/** Kept → read → proposed → decided → in your wiki; drawn from the journal, not a timer. */
function FlowRail({ stage }: { stage: WikiJob['stage'] }) {
  const at = flowStep(stage);
  const done = stage === 'committed' || stage === 'no_changes';
  const dead = stage === 'failed' || stage === 'cancelled';
  return (
    <div className="flex items-center gap-1" aria-label={`Progress: ${FLOW_STEPS[at]}${done ? ' — done' : ''}`}>
      {FLOW_STEPS.map((step, i) => (
        <span
          key={step}
          title={step}
          className={cn('h-1.5 rounded-full transition-all', i < at || (done && i <= at) ? 'w-5 bg-aurora-400' : i === at && !dead ? 'w-5 bg-beacon-400' : 'w-3 bg-white/10', dead && i === at && 'bg-rose-400')}
        />
      ))}
    </div>
  );
}

function jobSources(job: WikiJob, sources: SourceSummary[]): SourceSummary[] {
  return job.sourceIds.map((id) => sources.find((s) => s.id === id)).filter((s): s is SourceSummary => Boolean(s));
}

function JobRow({ job, sources, onInspect, onReviewProposal, busy, onCompile, onRetry, onCancel }: {
  job: WikiJob;
  sources: SourceSummary[];
  onInspect: (sourceId: string) => void;
  onReviewProposal: (proposalId: string) => void;
  busy: boolean;
  onCompile: (job: WikiJob) => void;
  onRetry: (job: WikiJob) => void;
  onCancel: (job: WikiJob) => void;
}) {
  const info = STAGE_INFO[job.stage];
  const covered = jobSources(job, sources);
  const Icon = covered[0] ? SOURCE_KIND_ICON[covered[0].kind] : Inbox;
  return (
    <motion.div initial={{ opacity: 0, y: 6 }} animate={{ opacity: 1, y: 0 }} className="flex items-center gap-3 rounded-xl border border-white/[0.06] bg-white/[0.02] px-3.5 py-3">
      <span className="grid size-9 shrink-0 place-items-center rounded-lg bg-white/[0.05] text-beacon-300">
        <Icon className="size-4" />
      </span>
      <div className="min-w-0 flex-1">
        <div className="flex flex-wrap items-center gap-2">
          <button type="button" onClick={() => covered[0] && onInspect(covered[0].id)} className="truncate text-[13.5px] font-medium text-night-100 hover:underline">
            {covered.map((s) => s.title).join(' · ') || 'Contribution'}
          </button>
          {covered[0] && <Badge>{sourceKindLabel(covered[0].kind)}</Badge>}
          <Badge tone={info.tone}>{info.label}</Badge>
        </div>
        <div className="mt-1.5 flex items-center gap-3">
          <FlowRail stage={job.stage} />
          <span className="text-[11px] text-night-500">{job.error ?? info.hint} · {timeAgo(job.updatedAt)}</span>
        </div>
      </div>
      <div className="flex shrink-0 items-center gap-1.5">
        {isWorking(job.stage) && <WorkingLabel label={job.stage === 'reading' && covered[0] ? readingLabel(covered[0]) : info.label} className="text-beacon-300" />}
        {job.stage === 'awaiting_source_review' && covered[0] && (
          <>
            <Button size="sm" variant="outline" onClick={() => onInspect(covered[0].id)}>
              Check reading
            </Button>
            <Button size="sm" variant="primary" loading={busy} onClick={() => onCompile(job)}>
              Propose changes
            </Button>
          </>
        )}
        {job.stage === 'awaiting_review' && job.proposalId && (
          <Button size="sm" variant="primary" onClick={() => onReviewProposal(job.proposalId!)}>
            Review <ArrowRight />
          </Button>
        )}
        {job.stage === 'failed' && (
          <Button size="sm" variant="outline" loading={busy} onClick={() => onRetry(job)}>
            Retry
          </Button>
        )}
        {canWithdraw(job.stage) && (
          <ConfirmButton size="sm" variant="ghost" confirmLabel="Withdraw?" onConfirm={() => onCancel(job)}>
            Withdraw
          </ConfirmButton>
        )}
      </div>
    </motion.div>
  );
}

/**
 * The queue: proposals awaiting a decision, jobs still moving, and the recent history —
 * all read straight from the durable journal under .meta/jobs.
 */
export function JobBoard({ board, onInspect, onReviewProposal }: { board: JobList | undefined; onInspect: (sourceId: string) => void; onReviewProposal: (proposalId: string) => void }) {
  const invalidateBrain = useInvalidateBrain();

  const invalidate = () => invalidateBrain();
  const compiled = (result: { job: WikiJob; proposalId: string | null } | null) => {
    invalidate();
    // null: the retry restarted a background read — the board polls it from here.
    if (!result) return;
    if (result.job.stage === 'awaiting_review' && result.proposalId) onReviewProposal(result.proposalId);
    else if (result.job.stage === 'no_changes') toast.info('The keeper proposed no changes for this source.');
  };
  // Drafting outlives a hosted workspace's request window (~21 s): when the request drops, the engine
  // keeps going. Watch the job on the polled board instead of reporting a failure, and open the review
  // the moment the proposal is filed.
  const [watching, setWatching] = useState<{ jobId: string; message: string } | null>(null);
  const compile = useMutation({
    mutationFn: (job: WikiJob) => api.compileJob(job.id),
    onSuccess: compiled,
    onError: (e, job) => {
      setWatching({ jobId: job.id, message: (e as Error).message });
      toast.info('Gemma is drafting your pages. This takes about a minute; the review opens here when it is ready.');
      invalidate();
    },
  });
  const watchedStage = watching ? board?.jobs.find((j) => j.id === watching.jobId) : undefined;
  useEffect(() => {
    if (!watching || !watchedStage) return;
    if (watchedStage.stage === 'awaiting_review' && watchedStage.proposalId) {
      setWatching(null);
      onReviewProposal(watchedStage.proposalId);
    } else if (watchedStage.stage === 'no_changes') {
      setWatching(null);
      toast.info('The keeper proposed no changes for this source.');
    } else if (watchedStage.stage === 'failed') {
      setWatching(null);
      toast.error(watchedStage.error ?? watching.message);
    }
  }, [watching, watchedStage, onReviewProposal]);
  // A request that failed before drafting began leaves the job where it was: report the real error then.
  const boardRef = useRef(board);
  boardRef.current = board;
  useEffect(() => {
    if (!watching) return;
    const timer = setTimeout(() => {
      const job = boardRef.current?.jobs.find((j) => j.id === watching.jobId);
      if (job && job.stage === 'awaiting_source_review') {
        setWatching(null);
        toast.error(watching.message);
      }
    }, 15_000);
    return () => clearTimeout(timer);
  }, [watching]);
  const retry = useMutation({
    mutationFn: async (job: WikiJob) => {
      const retried = await api.retryJob(job.id);
      if (retried?.stage === 'reading') return null;
      return api.compileJob(job.id);
    },
    onSuccess: compiled,
    onError: (e) => toast.error((e as Error).message),
  });
  const cancel = useMutation({ mutationFn: (job: WikiJob) => api.cancelJob(job.id), onSuccess: invalidate, onError: (e) => toast.error((e as Error).message) });

  const jobs = board?.jobs ?? [];
  // A proposal waiting for the student stays on the board with its Review button, so nothing seems to vanish.
  const live = jobs.filter((job) => isLiveJob(job.stage));
  const recent = jobs.filter((job) => !isLiveJob(job.stage)).slice(0, 6);
  const busy = compile.isPending || retry.isPending || cancel.isPending;

  return (
    <div className="space-y-4">
      {live.length > 0 && (
        <Panel className="p-5">
          <Eyebrow className="mb-3">Working through</Eyebrow>
          <div className="space-y-2">
            {live.map((job) => (
              <JobRow
                key={job.id}
                job={job}
                sources={board!.sources}
                busy={busy}
                onInspect={onInspect}
                onReviewProposal={onReviewProposal}
                onCompile={(j) => compile.mutate(j)}
                onRetry={(j) => retry.mutate(j)}
                onCancel={(j) => cancel.mutate(j)}
              />
            ))}
          </div>
        </Panel>
      )}

      {recent.length > 0 && (
        <Panel className="p-5">
          <Eyebrow className="mb-3">Lately</Eyebrow>
          <div className="space-y-1.5">
            {recent.map((job) => {
              const info = STAGE_INFO[job.stage];
              const covered = jobSources(job, board!.sources);
              return (
                <div key={job.id} className="flex items-center gap-3 px-1.5 py-1.5">
                  <Badge tone={info.tone}>{info.label}</Badge>
                  <button type="button" onClick={() => covered[0] && onInspect(covered[0].id)} className="min-w-0 flex-1 truncate text-left text-[13px] text-night-300 hover:underline">
                    {covered.map((s) => s.title).join(' · ') || 'Contribution'}
                  </button>
                  {job.stage === 'failed' && (
                    <Button size="sm" variant="ghost" loading={busy} onClick={() => retry.mutate(job)}>
                      Retry
                    </Button>
                  )}
                  <span className="shrink-0 text-[11px] text-night-500">{timeAgo(job.updatedAt)}</span>
                </div>
              );
            })}
          </div>
        </Panel>
      )}

      {!jobs.length && (
        <Panel className="p-5">
          <EmptyState icon={<Inbox />} title="Nothing in the pipeline" body="What you file is kept as a source, read, drafted into a proposal, and only written when you accept it." />
        </Panel>
      )}
    </div>
  );
}
