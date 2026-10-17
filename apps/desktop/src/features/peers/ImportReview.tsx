import type { ShareImportResult } from '@sef/shared';
import { AlertTriangle, Check, ShieldCheck, X } from 'lucide-react';
import { useState } from 'react';
import { Button } from '@/components/ui/button';
import { Badge, Panel } from '@/components/ui/primitives';
import { Dialog } from '@/components/ui/overlays';
import { SkeletonText } from '@/components/ui/primitives';
import { cn } from '@/lib/cn';
import { useProposalPreview } from '@/lib/queries';
import { useDecideProposal } from './peer-queries';
import { screeningBadge } from './screening';

const CHANGE_TONE = { created: 'aurora', updated: 'beacon', unchanged: 'neutral' } as const;

/**
 * After an import lands as a pending proposal this dialog shows exactly what the
 * peer's material would write to the student's brain. Nothing is applied until the
 * student accepts — this is the same review affordance every source goes through.
 */
export function ImportReview({ result, onClose }: { result: ShareImportResult; onClose: () => void }) {
  const proposal = useProposalPreview(result.proposalId);
  const decide = useDecideProposal();
  const [note, setNote] = useState('');
  const [deselected, setDeselected] = useState<Set<string>>(new Set());

  const pages = proposal.data?.pages ?? [];
  const selectedIds = pages.filter((p) => !deselected.has(p.id)).map((p) => p.id);
  const partial = deselected.size > 0 && selectedIds.length > 0;

  const done = () => {
    onClose();
  };

  return (
    <Dialog open onOpenChange={(open) => !open && onClose()} title="Review import" description="This is what would change in your brain. Nothing is applied until you accept — untick a page to keep it out.">
      {result.screening && (
        <Panel className="mb-4 flex items-start gap-2.5 p-3">
          <ShieldCheck className={cn('mt-0.5 size-4 shrink-0', result.screening.status === 'flagged' ? 'text-ember-300' : 'text-night-400')} />
          <span className="text-[13px] text-night-300">
            <Badge tone={screeningBadge(result.screening).tone}>{screeningBadge(result.screening).label}</Badge>
            {result.screening.status === 'flagged' && (
              <span className="mt-1 block text-[12px] text-night-500">
                Advisory only — the share was imported and its source carries this flag. Accept pages only if you want them in your brain.
              </span>
            )}
          </span>
        </Panel>
      )}
      {result.proposalId === null && (
        <Panel className="p-4 text-sm text-night-300">
          {result.reused
            ? 'You already imported this exact revision — nothing new was queued.'
            : result.stage === 'no_changes'
              ? 'The compiler found nothing it could turn into brain pages. The imported source stays in your library.'
              : result.stage === 'awaiting_source_review'
                ? 'The source needs a quick review before it can be compiled — it is waiting in your library.'
                : 'The import was saved as a source but its compile job could not produce a proposal. Try again later.'}
        </Panel>
      )}

      {result.proposalId && proposal.isPending && <SkeletonText lines={4} />}
      {result.proposalId && proposal.isError && (
        <Panel className="p-4 text-sm text-night-300">The proposal could not be loaded: {(proposal.error as Error).message}</Panel>
      )}

      {proposal.data && (
        <div className="space-y-4">
          {proposal.data.conflicts.length > 0 && (
            <Panel className="border-ember-400/30 p-4">
              <div className="flex items-center gap-2 text-[13px] font-medium text-ember-300">
                <AlertTriangle className="size-4" /> Conflicts
              </div>
              <ul className="mt-2 list-disc space-y-1 pl-5 text-[13px] text-night-300">
                {proposal.data.conflicts.map((conflict, i) => (
                  <li key={i}>{conflict}</li>
                ))}
              </ul>
            </Panel>
          )}

          <div className="space-y-2">
            {pages.map((page) => {
              const checked = !deselected.has(page.id);
              return (
                <Panel key={page.id} className={cn('p-4 transition', !checked && 'opacity-50')}>
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
                      <span className="flex items-center justify-between gap-3">
                        <span className="min-w-0">
                          <span className="block truncate text-[14px] font-medium text-night-100">{page.title}</span>
                          <span className="text-[12px] text-night-500">
                            {page.id} · {page.kind}
                          </span>
                        </span>
                        <Badge tone={CHANGE_TONE[page.change]}>{page.change}</Badge>
                      </span>
                      <span className="mt-2 block text-[13px] text-night-400">{page.summaryAfter}</span>
                      {page.summaryBefore && page.summaryBefore !== page.summaryAfter && (
                        <span className="mt-1 block text-[12px] text-night-600 line-through">{page.summaryBefore}</span>
                      )}
                    </span>
                  </label>
                </Panel>
              );
            })}
          </div>

          {(proposal.data.record.dropped?.length ?? 0) > 0 && (
            <details className="rounded-xl border border-white/[0.06] bg-black/20 p-3 text-sm">
              <summary className="cursor-pointer text-night-300">
                <ShieldCheck className="mr-1 inline size-3.5 text-gold-300" /> What the checks dropped ({proposal.data.record.dropped!.length})
              </summary>
              <ul className="mt-2 space-y-1 text-xs text-night-400">
                {proposal.data.record.dropped!.map((drop, i) => (
                  <li key={i}>
                    • <span className="text-night-300">{drop.what}</span> — {drop.reason}
                  </li>
                ))}
              </ul>
            </details>
          )}

          <div className="flex items-center justify-between gap-3 border-t border-white/[0.06] pt-4">
            <input
              value={note}
              onChange={(e) => setNote(e.target.value)}
              placeholder="Optional note (kept with the decision)"
              aria-label="Optional note, kept with the decision"
              className="h-9 flex-1 rounded-lg border border-white/10 bg-black/20 px-3 text-[13px] text-night-200 outline-none placeholder:text-night-600 focus:border-beacon-400/50"
            />
            <div className="flex gap-2">
              <Button
                variant="danger"
                size="sm"
                loading={decide.isPending}
                onClick={() => decide.mutate({ id: result.proposalId!, decision: 'reject', note: note || undefined }, { onSuccess: done })}
              >
                <X /> Reject
              </Button>
              <Button
                variant="primary"
                size="sm"
                loading={decide.isPending}
                disabled={selectedIds.length === 0 || proposal.data.conflicts.length > 0}
                onClick={() => decide.mutate({ id: result.proposalId!, decision: 'accept', ...(partial ? { pageIds: selectedIds } : {}) }, { onSuccess: done })}
              >
                <Check /> {partial ? `Accept ${selectedIds.length} of ${pages.length} pages` : 'Accept into brain'}
              </Button>
            </div>
          </div>
        </div>
      )}

      {!result.proposalId && (
        <div className="mt-4 flex justify-end">
          <Button variant="secondary" size="sm" onClick={onClose}>
            Close
          </Button>
        </div>
      )}
    </Dialog>
  );
}
