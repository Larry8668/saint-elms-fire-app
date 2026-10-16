import { useQuery } from '@tanstack/react-query';
import type { ShareImportResult } from '@sef/shared';
import { AlertTriangle, Check, X } from 'lucide-react';
import { useState } from 'react';
import { Button } from '@/components/ui/button';
import { Badge, Panel } from '@/components/ui/primitives';
import { Dialog } from '@/components/ui/overlays';
import { SkeletonText } from '@/components/ui/primitives';
import { api } from '@/lib/api';
import { useStudent } from '@/lib/session';
import { useDecideProposal } from './peer-queries';

const CHANGE_TONE = { created: 'aurora', updated: 'beacon', unchanged: 'neutral' } as const;

/**
 * After an import lands as a pending proposal this dialog shows exactly what the
 * peer's material would write to the student's brain. Nothing is applied until the
 * student accepts — this is the same review affordance every source goes through.
 */
export function ImportReview({ result, onClose }: { result: ShareImportResult; onClose: () => void }) {
  const { profile } = useStudent();
  const proposal = useQuery({
    queryKey: ['profile', profile.id, 'proposal', result.proposalId],
    queryFn: () => api.proposal(result.proposalId!),
    enabled: Boolean(result.proposalId),
  });
  const decide = useDecideProposal();
  const [note, setNote] = useState('');

  const done = () => {
    onClose();
  };

  return (
    <Dialog open onOpenChange={(open) => !open && onClose()} title="Review import" description="This is what would change in your brain. Nothing is applied until you accept.">
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
            {proposal.data.pages.map((page) => (
              <Panel key={page.id} className="p-4">
                <div className="flex items-center justify-between gap-3">
                  <div className="min-w-0">
                    <div className="truncate text-[14px] font-medium text-night-100">{page.title}</div>
                    <div className="text-[12px] text-night-500">
                      {page.id} · {page.kind}
                    </div>
                  </div>
                  <Badge tone={CHANGE_TONE[page.change]}>{page.change}</Badge>
                </div>
                <p className="mt-2 text-[13px] text-night-400">{page.summaryAfter}</p>
                {page.summaryBefore && page.summaryBefore !== page.summaryAfter && (
                  <p className="mt-1 text-[12px] text-night-600 line-through">{page.summaryBefore}</p>
                )}
              </Panel>
            ))}
          </div>

          <div className="flex items-center justify-between gap-3 border-t border-white/[0.06] pt-4">
            <input
              value={note}
              onChange={(e) => setNote(e.target.value)}
              placeholder="Optional note (kept with the decision)"
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
                onClick={() => decide.mutate({ id: result.proposalId!, decision: 'accept' }, { onSuccess: done })}
              >
                <Check /> Accept into brain
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
