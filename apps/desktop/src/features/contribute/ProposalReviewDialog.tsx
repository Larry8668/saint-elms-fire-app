import { useMutation } from '@tanstack/react-query';
import { Check, Link2, Quote, ShieldCheck, X } from 'lucide-react';
import { useMemo, useState } from 'react';
import { toast } from 'sonner';
import type { ProposalAcceptance, ProposalPreview, SourceCitation, WikiClaim, WikiLink } from '@sef/shared';
import { Button } from '@/components/ui/button';
import { WorkingLabel } from '@/components/ui/loading';
import { Dialog } from '@/components/ui/overlays';
import { Badge, SkeletonText, Textarea } from '@/components/ui/primitives';
import { BrainDiff } from '@/features/brain/BrainDiff';
import { api } from '@/lib/api';
import { cn } from '@/lib/cn';
import { useInvalidateBrain, useProposalPreview, useSourceDetail } from '@/lib/queries';
import { citationExcerpt, locatorLabel, pageKindLabel, previewSummary } from './review';

const CHANGE_BADGE = { created: 'aurora', updated: 'beacon', unchanged: 'neutral' } as const;

/** The evidence a claim or link rests on — a passage cut from the retained source text. */
function CitationLine({ citation }: { citation: SourceCitation }) {
  const detail = useSourceDetail(citation.sourceId);
  const excerpt = citationExcerpt(citation, detail.data?.extraction?.text);
  const title = detail.data?.record.title ?? citation.sourceId;
  return (
    <div className="mt-1.5 border-l-2 border-beacon-400/40 pl-2.5 text-[12px] leading-5 text-night-400">
      <span className="text-night-500">
        {title} · {locatorLabel(citation.locator)}
      </span>
      {excerpt && <p className="mt-0.5 text-night-300 italic">“{excerpt.length > 220 ? `${excerpt.slice(0, 220)}…` : excerpt}”</p>}
    </div>
  );
}

function ClaimRow({ claim }: { claim: WikiClaim }) {
  return (
    <li className="rounded-lg bg-black/20 px-3 py-2">
      <div className="flex flex-wrap items-center gap-1.5">
        <Badge tone={claim.kind === 'student_belief' ? 'aurora' : claim.kind === 'question' ? 'gold' : 'neutral'}>{claim.kind.replace('_', ' ')}</Badge>
        <Badge>{claim.origin}</Badge>
        {claim.status !== 'current' && <Badge tone="ember">{claim.status}</Badge>}
      </div>
      <p className="mt-1 text-[13px] leading-6 text-night-200">{claim.text}</p>
      {claim.citations.map((citation, i) => (
        <CitationLine key={i} citation={citation} />
      ))}
      {!claim.citations.length && <p className="mt-1 text-[11.5px] text-night-500">No citation — a deduction or open question, not a fact.</p>}
    </li>
  );
}

function LinkRow({ page, link }: { page: ProposalPreview['pages'][number]; link: WikiLink }) {
  return (
    <li className="flex items-center gap-2 rounded-lg bg-black/20 px-3 py-2 text-[13px]">
      <Link2 className="size-3.5 shrink-0 text-aurora-400" />
      <span className="min-w-0 flex-1 text-night-300">
        {page.title} <span className="text-night-500">{link.type.replace('_', ' ')}</span> <span className="text-night-100">{link.toPageId}</span>
      </span>
      <Badge tone={link.origin === 'student' ? 'aurora' : 'neutral'}>{link.origin}</Badge>
    </li>
  );
}

/** The decision screen: every change the proposal would make, and which of them land. */
export function ProposalReviewDialog({ proposalId, onClose }: { proposalId: string | null; onClose: () => void }) {
  const preview = useProposalPreview(proposalId);
  const invalidateBrain = useInvalidateBrain();
  const [note, setNote] = useState('');
  const [accepted, setAccepted] = useState<ProposalAcceptance | null>(null);

  const pages = preview.data?.pages ?? [];
  const [deselected, setDeselected] = useState<Set<string>>(new Set());
  const selectedIds = useMemo(() => (preview.data?.pages ?? []).filter((p) => !deselected.has(p.id)).map((p) => p.id), [preview.data, deselected]);
  const partial = deselected.size > 0 && selectedIds.length > 0;

  const close = () => {
    setAccepted(null);
    setDeselected(new Set());
    setNote('');
    onClose();
  };

  const accept = useMutation({
    mutationFn: () => api.acceptProposal(proposalId!, partial ? { pageIds: selectedIds } : undefined),
    onSuccess: (result) => {
      invalidateBrain();
      setAccepted(result);
      toast.success(result.report.committed ? 'Written into your wiki' : 'Accepted — the pages already said that');
    },
    onError: (e) => toast.error((e as Error).message),
  });
  const reject = useMutation({
    mutationFn: () => api.rejectProposal(proposalId!, note.trim() || undefined),
    onSuccess: () => {
      invalidateBrain();
      close();
      toast('Rejected — nothing was written');
    },
    onError: (e) => toast.error((e as Error).message),
  });

  const summary = preview.data ? previewSummary(preview.data) : null;

  return (
    <Dialog
      open={Boolean(proposalId)}
      onOpenChange={(open) => !open && close()}
      title={accepted ? 'In your wiki' : 'Review the proposal'}
      description={
        accepted
          ? 'Accepted through the journaled write — your markdown files now carry these changes.'
          : 'The keeper drafted these changes; the validator already checked them. Untick a page to keep it out — only what you accept is written.'
      }
      className="w-[min(760px,calc(100vw-2rem))]"
    >
      {preview.isLoading && <SkeletonText lines={7} />}
      {preview.isError && <p className="text-sm text-night-400">{(preview.error as Error).message}</p>}

      {accepted && (
        <div className="space-y-4">
          <BrainDiff diff={accepted.diff} applied={[]} rejected={[]} />
          <div className="flex justify-end">
            <Button variant="primary" onClick={close}>
              <Check /> Done
            </Button>
          </div>
        </div>
      )}

      {!accepted && preview.data && (
        <div className="space-y-5">
          {summary && (
            <div className="flex flex-wrap gap-2">
              <Badge tone="aurora">{summary.created} new page{summary.created === 1 ? '' : 's'}</Badge>
              <Badge tone="beacon">{summary.updated} updated</Badge>
              {summary.unchanged > 0 && <Badge>{summary.unchanged} unchanged</Badge>}
              <Badge tone="gold">
                <Quote className="size-3" /> {summary.claims} claim{summary.claims === 1 ? '' : 's'}
              </Badge>
              <Badge tone="aurora">
                <Link2 className="size-3" /> {summary.links} link{summary.links === 1 ? '' : 's'}
              </Badge>
            </div>
          )}

          {preview.data.conflicts.length > 0 && (
            <div className="rounded-xl border border-ember-400/30 bg-ember-500/[0.08] p-3.5 text-[13px] leading-6 text-ember-200">
              <p className="font-semibold">This proposal no longer matches your pages</p>
              <ul className="mt-1 list-disc pl-4 text-ember-300/90">
                {preview.data.conflicts.map((conflict) => (
                  <li key={conflict}>{conflict}</li>
                ))}
              </ul>
              <p className="mt-2 text-night-400">Reject it and run the job again — a fresh draft is prepared against the current pages.</p>
            </div>
          )}

          <ul className="space-y-2.5">
            {pages.map((page) => {
              const checked = !deselected.has(page.id);
              return (
                <li key={page.id} className={cn('rounded-xl border p-3.5 transition', checked ? 'border-white/[0.08] bg-white/[0.03]' : 'border-white/[0.04] opacity-50')}>
                  <label className="flex cursor-pointer items-start gap-3">
                    <input
                      type="checkbox"
                      checked={checked}
                      onChange={() =>
                        setDeselected((prev) => {
                          const next = new Set(prev);
                          if (next.has(page.id)) next.delete(page.id);
                          else next.add(page.id);
                          return next;
                        })
                      }
                      className="mt-0.5 size-4 shrink-0 accent-beacon-500"
                      aria-label={`Apply changes to ${page.title}`}
                    />
                    <span className="min-w-0 flex-1">
                      <span className="flex flex-wrap items-center gap-2">
                        <Badge tone={CHANGE_BADGE[page.change]}>{page.change}</Badge>
                        <Badge>{pageKindLabel(page.kind)}</Badge>
                        <span className="truncate text-sm font-medium text-night-100">{page.title}</span>
                      </span>
                      <span className="mt-1.5 block text-[12.5px] leading-5 text-night-400">
                        {page.summaryBefore && (
                          <>
                            <span className="text-night-500">Was:</span> {page.summaryBefore}
                            <br />
                          </>
                        )}
                        <span className="text-night-500">{page.change === 'created' ? 'Reads:' : 'Becomes:'}</span> {page.summaryAfter}
                      </span>
                      {(page.addedClaims.length > 0 || page.addedLinks.length > 0 || page.removedLinks.length > 0) && (
                        <ul className="mt-2 space-y-1.5">
                          {page.addedClaims.map((claim) => (
                            <ClaimRow key={claim.id} claim={claim} />
                          ))}
                          {page.addedLinks.map((link, i) => (
                            <LinkRow key={`${link.toPageId}-${link.type}-${i}`} page={page} link={link} />
                          ))}
                          {page.removedLinks.map((link, i) => (
                            <li key={`removed-${link.toPageId}-${link.type}-${i}`} className="flex items-center gap-2 rounded-lg bg-ember-500/[0.08] px-3 py-2 text-[13px]">
                              <Link2 className="size-3.5 shrink-0 text-ember-400" />
                              <span className="min-w-0 flex-1 text-night-400 line-through">
                                {page.title} <span className="text-night-500">{link.type.replace('_', ' ')}</span> {link.toPageId}
                              </span>
                              <Badge tone="ember">removed</Badge>
                            </li>
                          ))}
                        </ul>
                      )}
                    </span>
                  </label>
                </li>
              );
            })}
          </ul>

          {(preview.data.record.dropped?.length ?? 0) > 0 && (
            <details className="rounded-xl border border-white/[0.06] bg-black/20 p-3 text-sm">
              <summary className="cursor-pointer text-night-300">
                <ShieldCheck className="mr-1 inline size-3.5 text-gold-300" /> What the checks dropped ({preview.data.record.dropped!.length})
              </summary>
              <ul className="mt-2 space-y-1 text-xs text-night-400">
                {preview.data.record.dropped!.map((drop, i) => (
                  <li key={i}>
                    • <span className="text-night-300">{drop.what}</span> — {drop.reason}
                  </li>
                ))}
              </ul>
            </details>
          )}

          <Textarea value={note} onChange={(e) => setNote(e.target.value)} rows={2} placeholder="Optional: a note for the record if you reject (e.g. what was wrong)" aria-label="Rejection note" />

          <div className="flex flex-wrap items-center justify-between gap-2">
            <Button variant="danger" loading={reject.isPending} onClick={() => reject.mutate()}>
              <X /> Reject all
            </Button>
            <Button
              variant="primary"
              loading={accept.isPending}
              disabled={preview.data.conflicts.length > 0 || selectedIds.length === 0}
              onClick={() => accept.mutate()}
            >
              <Check /> {partial ? `Accept ${selectedIds.length} of ${pages.length} pages` : 'Accept all'}
            </Button>
          </div>
          {accept.isPending && <WorkingLabel label="Writing through the journal" className="text-beacon-300" />}
        </div>
      )}
    </Dialog>
  );
}
