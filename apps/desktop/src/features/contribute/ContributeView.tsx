import { ArrowRight, FileCheck } from 'lucide-react';
import { useState } from 'react';
import type { WikiProposalRecord } from '@sef/shared';
import { Button } from '@/components/ui/button';
import { Badge, Eyebrow, PageHeader, Panel } from '@/components/ui/primitives';
import { SourceDetailDialog } from '@/features/brain/SourceDetail';
import { SourcesPanel } from '@/features/brain/SourcesPanel';
import { useJobBoard, useProposals } from '@/lib/queries';
import { timeAgo } from '@/lib/time';
import { ContributionComposer } from './ContributionComposer';
import { JobBoard } from './JobBoard';
import { ProposalReviewDialog } from './ProposalReviewDialog';

function proposalTitle(record: WikiProposalRecord, sourceTitles: Map<string, string>): string {
  const upserts = record.proposal.operations.flatMap((op) => (op.op === 'upsert_page' ? [op.page.title] : []));
  if (upserts.length) return upserts.slice(0, 2).join(' · ') + (upserts.length > 2 ? ` +${upserts.length - 2}` : '');
  const source = record.proposal.sourceIds.map((id) => sourceTitles.get(id)).find(Boolean);
  return source ? `Links from “${source}”` : 'Link suggestions';
}

/**
 * The contribution desk: file a note, a paste, a photo, a PDF or a conversation — the
 * engine keeps the original, reads it into the open, and only your accept writes the wiki.
 */
export function ContributeView() {
  const board = useJobBoard();
  const proposals = useProposals();
  const [sourceId, setSourceId] = useState<string | null>(null);
  const [proposalId, setProposalId] = useState<string | null>(null);

  const sourceTitles = new Map((board.data?.sources ?? []).map((s) => [s.id, s.title]));
  const pending = proposals.data?.proposals.filter((record) => record.state === 'pending') ?? [];

  return (
    <div className="h-full overflow-y-auto">
      <div className="mx-auto max-w-6xl px-8 py-8">
        <PageHeader
          eyebrow="Contribute"
          title="Add to my wiki"
          description="Notes, pastes, photos, PDFs and conversations — filed first, read in the open, and written into your wiki only when you accept the proposal. Nothing reaches your brain without review."
        />

        <div className="grid items-start gap-6 lg:grid-cols-[1.05fr_1fr]">
          <ContributionComposer onFiled={(receipt) => setSourceId(receipt.source.id)} />

          <div className="space-y-4">
            {pending.length > 0 && (
              <Panel className="border-gold-400/25 p-5">
                <Eyebrow className="mb-3 text-gold-300">Waiting for your review · {pending.length}</Eyebrow>
                <div className="space-y-2">
                  {pending.map((record) => (
                    <div key={record.proposal.id} className="flex items-center justify-between gap-3 rounded-xl border border-white/[0.06] bg-white/[0.02] px-3.5 py-3">
                      <div className="min-w-0">
                        <div className="flex items-center gap-2">
                          <FileCheck className="size-3.5 shrink-0 text-gold-300" />
                          <span className="truncate text-[13.5px] font-medium text-night-100">{proposalTitle(record, sourceTitles)}</span>
                        </div>
                        <div className="mt-1 flex items-center gap-2 text-[11px] text-night-500">
                          <Badge>{record.proposal.operations.length} change{record.proposal.operations.length === 1 ? '' : 's'}</Badge>
                          <span>{timeAgo(record.proposal.createdAt)}</span>
                        </div>
                      </div>
                      <Button size="sm" variant="primary" onClick={() => setProposalId(record.proposal.id)}>
                        Review <ArrowRight />
                      </Button>
                    </div>
                  ))}
                </div>
              </Panel>
            )}

            <JobBoard board={board.data} onInspect={setSourceId} onReviewProposal={setProposalId} />

            {(board.data?.sources.length ?? 0) > 0 && (
              <Panel className="p-5">
                <Eyebrow className="mb-3">Kept sources</Eyebrow>
                <SourcesPanel board={board.data} loading={board.isLoading} onOpen={setSourceId} />
              </Panel>
            )}
          </div>
        </div>
      </div>

      <SourceDetailDialog sourceId={sourceId} onClose={() => setSourceId(null)} onReviewProposal={setProposalId} />
      <ProposalReviewDialog proposalId={proposalId} onClose={() => setProposalId(null)} />
    </div>
  );
}
