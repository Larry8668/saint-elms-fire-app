import { useMutation, useQuery } from '@tanstack/react-query';
import { AudioLines, FileText, Film, Image as ImageIcon, MessagesSquare, NotebookPen, Pencil, ScanText, Share2, ShieldQuestion, Trash2, type LucideIcon } from 'lucide-react';
import { useEffect, useMemo, useState } from 'react';
import { toast } from 'sonner';
import type { SourceRecord } from '@sef/shared';
import { Markdown } from '@/components/Markdown';
import { Button } from '@/components/ui/button';
import { WorkingLabel } from '@/components/ui/loading';
import { Dialog } from '@/components/ui/overlays';
import { Badge, Eyebrow, SkeletonText, Textarea } from '@/components/ui/primitives';
import { api } from '@/lib/api';
import { useInvalidateSource, useSourceBytes, useSourceDetail } from '@/lib/queries';
import { useStudent } from '@/lib/session';
import { timeAgo } from '@/lib/time';
import { STAGE_INFO, canCorrect, formatBytes, originLabel, sourceKindLabel } from '@/features/contribute/review';

export const SOURCE_KIND_ICON: Record<SourceRecord['kind'], LucideIcon> = {
  note: NotebookPen,
  document: FileText,
  image: ImageIcon,
  audio: AudioLines,
  video: Film,
  session: MessagesSquare,
  answer: ShieldQuestion,
  peer: Share2,
};

/** The retained original, rendered for the student's eyes while they check the reading. */
function SourceImage({ sourceId, title }: { sourceId: string; title: string }) {
  const blob = useSourceBytes(sourceId);
  const url = useMemo(() => (blob.data ? URL.createObjectURL(blob.data) : null), [blob.data]);
  useEffect(() => () => {
    if (url) URL.revokeObjectURL(url);
  }, [url]);
  if (!url) return null;
  return <img src={url} alt={title} className="max-h-56 w-full rounded-xl border border-white/[0.06] object-contain bg-black/30" />;
}

/** The kept recording or video, playable while the student checks its transcript. */
function SourceMedia({ sourceId, title, video }: { sourceId: string; title: string; video: boolean }) {
  const blob = useSourceBytes(sourceId);
  const url = useMemo(() => (blob.data ? URL.createObjectURL(blob.data) : null), [blob.data]);
  useEffect(() => () => {
    if (url) URL.revokeObjectURL(url);
  }, [url]);
  if (!url) return null;
  if (video) return <video src={url} aria-label={title} controls preload="metadata" className="max-h-64 w-full rounded-xl border border-white/[0.06] bg-black/40" />;
  return <audio src={url} aria-label={title} controls className="w-full" />;
}

function Meta({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div>
      <div className="text-[10.5px] font-semibold tracking-[0.14em] text-night-500 uppercase">{label}</div>
      <div className="mt-0.5 text-[12.5px] text-night-300">{children}</div>
    </div>
  );
}

/**
 * One kept source in full: its record, every extraction pass, and the job covering it.
 * The raw bytes never change — the student edits the reading, and each correction is a
 * new ledger entry the compiler then reads.
 */
export function SourceDetailView({ sourceId, onReviewProposal, onErased }: { sourceId: string; onReviewProposal?: (proposalId: string) => void; onErased?: () => void }) {
  const detail = useSourceDetail(sourceId);
  const invalidate = useInvalidateSource(sourceId);
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState('');
  const [confirmingErase, setConfirmingErase] = useState(false);

  const corrected = (label: string) => {
    invalidate();
    setEditing(false);
    toast.success(label);
  };

  const correct = useMutation({
    mutationFn: (text: string) => api.correctExtraction(sourceId, text),
    onSuccess: () => corrected('Your correction is kept — a compile reads your version now'),
    onError: (e) => toast.error((e as Error).message),
  });
  const readImage = useMutation({
    mutationFn: () => api.readSource(sourceId),
    onSuccess: (result) => {
      invalidate();
      toast.success(`Read: “${result.reading.topic}”`);
    },
    onError: (e) => toast.error((e as Error).message),
  });
  const compiled = (result: { job: { stage: string }; proposalId: string | null }) => {
    invalidate();
    if (result.job.stage === 'awaiting_review' && result.proposalId) onReviewProposal?.(result.proposalId);
    else if (result.job.stage === 'no_changes') toast.info('The keeper proposed no changes for this source.');
  };
  const compile = useMutation({
    mutationFn: (jobId: string) => api.compileJob(jobId),
    onSuccess: compiled,
    onError: (e) => toast.error((e as Error).message),
  });
  const retry = useMutation({
    mutationFn: async (jobId: string) => {
      await api.retryJob(jobId);
      return api.compileJob(jobId);
    },
    onSuccess: compiled,
    onError: (e) => toast.error((e as Error).message),
  });
  const cancel = useMutation({
    mutationFn: (jobId: string) => api.cancelJob(jobId),
    onSuccess: () => {
      invalidate();
      toast('Contribution withdrawn — nothing was written');
    },
    onError: (e) => toast.error((e as Error).message),
  });
  const pid = useStudent().profile.id;
  const dependents = useQuery({
    queryKey: ['profile', pid, 'source-dependents', sourceId],
    queryFn: () => api.sourceDependents(sourceId),
    enabled: confirmingErase,
    retry: false,
  });
  const erase = useMutation({
    mutationFn: (revision: string) => api.eraseSource(sourceId, revision),
    onSuccess: (result) => {
      invalidate();
      setConfirmingErase(false);
      toast.success(
        result.dependents.length
          ? `Source erased — ${result.dependents.length} page${result.dependents.length === 1 ? '' : 's'} still cite it`
          : 'Source erased',
      );
      onErased?.();
    },
    onError: (e) => toast.error((e as Error).message),
  });

  if (detail.isLoading) return <SkeletonText lines={6} />;
  const source = detail.data;
  if (!source) return <p className="text-sm text-night-400">That source is gone, or it is not yours.</p>;

  const { record, extraction, job } = source;
  const Icon = SOURCE_KIND_ICON[record.kind];
  const stage = job ? STAGE_INFO[job.stage] : null;
  const jobBusy = compile.isPending || retry.isPending;

  return (
    <div className="space-y-5">
      <div className="flex flex-wrap items-center gap-2">
        <Badge tone="beacon">
          <Icon className="size-3" /> {sourceKindLabel(record.kind)}
        </Badge>
        <Badge tone={record.origin === 'student' ? 'aurora' : 'neutral'}>{originLabel(record.origin)}</Badge>
        {stage && <Badge tone={stage.tone}>{stage.label}</Badge>}
        {extraction?.partial && <Badge tone="ember">partial reading</Badge>}
      </div>

      <div className="grid grid-cols-2 gap-x-4 gap-y-3 md:grid-cols-3">
        <Meta label="Kept">{timeAgo(record.createdAt)}</Meta>
        <Meta label="File">{record.mediaType} · {formatBytes(record.bytes)}</Meta>
        <Meta label="Sha-256">{record.sha256.slice(0, 12)}…</Meta>
        {record.attribution.creator && <Meta label="By">{record.attribution.creator}</Meta>}
        {record.attribution.url && (
          <Meta label="From">
            <a href={record.attribution.url} target="_blank" rel="noreferrer" className="text-beacon-300 underline decoration-beacon-400/40 hover:text-beacon-200">
              {record.attribution.url.replace(/^https?:\/\//, '').slice(0, 48)}
            </a>
          </Meta>
        )}
        {record.kind === 'session' && (
          <Meta label="Covers">
            turns {record.session.firstTurn + 1}–{record.session.lastTurn + 1} of a {record.session.teacher} conversation
          </Meta>
        )}
      </div>

      {record.kind === 'image' && <SourceImage sourceId={record.id} title={record.title} />}
      {/* A fetched video's kept original is its audio track; an uploaded one keeps the video itself. */}
      {(record.kind === 'audio' || record.kind === 'video') && <SourceMedia sourceId={record.id} title={record.title} video={record.mediaType.startsWith('video/')} />}

      <section>
        <div className="mb-2 flex items-center justify-between">
          <Eyebrow>The reading{extraction ? ` · ${extraction.method.replace('_', ' ')}` : ''}</Eyebrow>
          {extraction && canCorrect(job) && !editing && (
            <Button size="sm" variant="ghost" onClick={() => { setDraft(extraction.text); setEditing(true); }}>
              <Pencil /> Fix this reading
            </Button>
          )}
        </div>
        {extraction?.note && <p className="mb-2 text-[12.5px] text-ember-300">{extraction.note}</p>}
        {editing ? (
          <div className="space-y-2">
            <Textarea value={draft} onChange={(e) => setDraft(e.target.value)} rows={9} aria-label="Corrected text" className="font-mono text-[12.5px]" autoFocus />
            <div className="flex items-center gap-2">
              <Button size="sm" variant="primary" loading={correct.isPending} disabled={!draft.trim()} onClick={() => correct.mutate(draft)}>
                Keep my correction
              </Button>
              <Button size="sm" variant="ghost" onClick={() => setEditing(false)}>
                Discard
              </Button>
              <span className="text-[11.5px] text-night-500">The original file is never touched — this becomes a new pass.</span>
            </div>
          </div>
        ) : extraction?.text ? (
          <Markdown variant="chat" className="max-h-64 overflow-y-auto rounded-xl bg-black/25 p-3.5 text-[13px] whitespace-pre-wrap">
            {extraction.text}
          </Markdown>
        ) : (
          <p className="rounded-xl border border-dashed border-white/[0.1] p-3.5 text-[13px] text-night-400">
            Nothing has been read from this source yet.
            {record.kind === 'image' ? ' Have Gemma read it, or type the text yourself.' : ' Type or paste the text yourself below.'}
          </p>
        )}
        {!editing && !extraction?.text && canCorrect(job) && record.kind !== 'image' && (
          <Button size="sm" variant="outline" className="mt-2" onClick={() => { setDraft(''); setEditing(true); }}>
            <Pencil /> Write it yourself
          </Button>
        )}
      </section>

      {record.extractions.length > 0 && (
        <section>
          <Eyebrow className="mb-2">Passes over it</Eyebrow>
          <div className="flex flex-wrap gap-1.5">
            {record.extractions.map((pass, i) => (
              <Badge key={`${pass.createdAt}-${i}`} tone={i === record.extractions.length - 1 ? 'beacon' : 'neutral'}>
                {pass.method.replace('_', ' ')} · {timeAgo(pass.createdAt)}
                {pass.chars !== undefined ? ` · ${pass.chars.toLocaleString()} chars` : ''}
              </Badge>
            ))}
          </div>
        </section>
      )}

      {job && (
        <section className="rounded-xl border border-white/[0.06] bg-white/[0.02] p-4">
          <div className="flex flex-wrap items-center justify-between gap-3">
            <div>
              <div className="flex items-center gap-2">
                <Badge tone={stage!.tone}>{stage!.label}</Badge>
                <span className="text-[11.5px] text-night-500">{timeAgo(job.updatedAt)}</span>
              </div>
              <p className="mt-1.5 text-[12.5px] text-night-400">{job.error ?? stage!.hint}</p>
            </div>
            <div className="flex items-center gap-2">
              {(job.stage === 'queued' || job.stage === 'extracting' || job.stage === 'compiling') && <WorkingLabel label={stage!.label} className="text-beacon-300" />}
              {job.stage === 'awaiting_source_review' && (
                <Button size="sm" variant="primary" loading={jobBusy} onClick={() => compile.mutate(job.id)}>
                  <ScanText /> Propose changes
                </Button>
              )}
              {job.stage === 'awaiting_review' && job.proposalId && (
                <Button size="sm" variant="primary" onClick={() => onReviewProposal?.(job.proposalId!)}>
                  Review proposal
                </Button>
              )}
              {job.stage === 'failed' && (
                <Button size="sm" variant="outline" loading={jobBusy} onClick={() => retry.mutate(job.id)}>
                  Retry
                </Button>
              )}
              {(job.stage === 'queued' || job.stage === 'extracting' || job.stage === 'awaiting_source_review') && (
                <Button size="sm" variant="ghost" loading={cancel.isPending} onClick={() => cancel.mutate(job.id)}>
                  Withdraw
                </Button>
              )}
            </div>
          </div>
        </section>
      )}

      {record.kind === 'image' && !editing && canCorrect(job) && (
        <Button size="sm" variant="outline" loading={readImage.isPending} onClick={() => readImage.mutate()}>
          <ImageIcon className="size-3.5" /> {extraction?.text ? 'Read it again' : 'Have Gemma read it'}
        </Button>
      )}

      <section className="border-t border-white/[0.06] pt-4">
        <Button size="sm" variant="danger" onClick={() => setConfirmingErase(true)}>
          <Trash2 /> Erase this source
        </Button>
        <p className="mt-1.5 text-[11.5px] text-night-500">
          Erasure removes the original, the record and the readings; pages that cited it are listed first. An erasure marker remains so a future
          restore does not quietly bring it back.
        </p>
      </section>

      <Dialog
        open={confirmingErase}
        onOpenChange={(open) => !open && setConfirmingErase(false)}
        title={`Erase “${record.title}”?`}
        description="The original file, its record and its readings are removed and a tombstone records the delete. Pages keep their citations — they will show as withdrawn evidence."
      >
        {dependents.isLoading ? (
          <SkeletonText lines={3} />
        ) : dependents.isError ? (
          <p className="text-[13px] text-rose-400">{(dependents.error as Error).message}</p>
        ) : dependents.data?.pages.length ? (
          <div className="space-y-2">
            <Eyebrow>{dependents.data.pages.length} page{dependents.data.pages.length === 1 ? '' : 's'} still lean on it</Eyebrow>
            <ul className="space-y-1.5">
              {dependents.data.pages.map((page) => (
                <li key={page.id} className="rounded-lg bg-white/[0.04] px-3 py-2 text-[12.5px] text-night-300">
                  <span className="font-medium text-night-100">{page.title}</span> <span className="text-night-500">({page.id})</span>
                  <span className="text-night-400"> — {page.references.join(', ')}</span>
                </li>
              ))}
            </ul>
          </div>
        ) : (
          <p className="text-[13px] text-night-400">Nothing in your vault cites this source.</p>
        )}
        <div className="mt-4 flex items-center gap-2">
          <Button variant="danger" size="sm" loading={erase.isPending} disabled={dependents.isLoading || dependents.isError} onClick={() => erase.mutate(record.revision)}>
            Erase permanently
          </Button>
          <Button variant="ghost" size="sm" onClick={() => setConfirmingErase(false)}>
            Keep it
          </Button>
        </div>
      </Dialog>
    </div>
  );
}

export function SourceDetailDialog({ sourceId, onClose, onReviewProposal }: { sourceId: string | null; onClose: () => void; onReviewProposal?: (proposalId: string) => void }) {
  const detail = useSourceDetail(sourceId);
  return (
    <Dialog open={Boolean(sourceId)} onOpenChange={(open) => !open && onClose()} title={detail.data?.record.title ?? 'Kept source'} description="The original is kept byte-for-byte; you are looking at what the engine read from it.">
      {sourceId && <SourceDetailView sourceId={sourceId} onReviewProposal={onReviewProposal} onErased={onClose} />}
    </Dialog>
  );
}
