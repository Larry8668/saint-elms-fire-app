import type { MaintenanceFinding, MaintenanceProposalResult } from '@sef/shared';
import { AlertTriangle, Check, ListChecks, MessageCircleQuestion, ShieldCheck, Sparkles, Wrench, X } from 'lucide-react';
import { useMemo, useState } from 'react';
import { Button } from '@/components/ui/button';
import { WorkingLabel } from '@/components/ui/loading';
import { Badge, EmptyState, Panel } from '@/components/ui/primitives';
import { useNav } from '@/lib/nav';
import { useDismissFinding, useMaintenanceReview, useProposeMaintenance, useRepairCatalogue } from '@/lib/queries';
import { actionLabel, FINDING_LABEL, findingTone, isActionable, needsCatalogueRepair, semanticStatusLine, sortFindings } from './maintenance';

/**
 * The maintenance tab: deterministic findings plus whatever the bounded semantic review
 * suggested. Nothing here writes a page — actionable findings are filed as one proposal and
 * the ordinary review dialog does the deciding.
 */
export function MaintenancePanel({ findings, semantic, dismissed, onProposal }: {
  findings: MaintenanceFinding[];
  semantic: { state: 'never_run' | 'ran' | 'failed'; lastRunAt: string | null; model: string | null; note?: string };
  dismissed: number;
  onProposal: (proposalId: string) => void;
}) {
  const { go } = useNav();
  const review = useMaintenanceReview();
  const propose = useProposeMaintenance();
  const dismiss = useDismissFinding();
  const catalogue = useRepairCatalogue();
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [filed, setFiled] = useState<MaintenanceProposalResult | null>(null);

  const ordered = useMemo(() => sortFindings(findings), [findings]);
  const cataloguePending = ordered.some(needsCatalogueRepair);
  const actionable = ordered.filter(isActionable);
  const actionableSelected = actionable.filter((finding) => selected.has(finding.id));

  const toggle = (id: string) =>
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });

  const fileRepairs = () =>
    propose.mutate(
      actionableSelected.map((finding) => finding.id),
      {
        onSuccess: (result) => {
          setFiled(result);
          setSelected(new Set());
          if (result.proposalId) onProposal(result.proposalId);
        },
      },
    );

  return (
    <div className="max-w-3xl space-y-3">
      <Panel className="flex flex-col gap-3 p-5 md:flex-row md:items-center md:justify-between">
        <div className="min-w-0">
          <div className="flex items-center gap-2">
            <ShieldCheck className="size-4 text-aurora-300" />
            <span className="text-sm font-semibold text-night-100">Vault health</span>
            {dismissed > 0 && <Badge>{dismissed} dismissed</Badge>}
          </div>
          <p className="mt-1 text-[12.5px] leading-5 text-night-400">{semanticStatusLine(semantic)}</p>
        </div>
        <div className="flex shrink-0 flex-wrap gap-2">
          <Button size="sm" disabled={!cataloguePending} loading={catalogue.isPending} onClick={() => catalogue.mutate()} title="Rewrite index.md and the manifest from the pages on disk">
            <ListChecks /> Rebuild index
          </Button>
          <Button size="sm" variant="primary" loading={review.isPending} onClick={() => review.mutate()} title="Read your pages with the brain model and suggest what needs attention">
            <Sparkles /> {semantic.state === 'never_run' ? 'Run the deep review' : 'Run the review again'}
          </Button>
        </div>
      </Panel>
      {review.isPending && <WorkingLabel label="The review is reading your pages" className="text-beacon-300" />}

      {ordered.length === 0 && (
        <EmptyState icon={<ShieldCheck />} title="Nothing needs attention" body="Every page is linked, indexed and citing sources that still exist." />
      )}

      {ordered.map((finding) => {
        const repair = actionLabel(finding);
        const canFile = isActionable(finding);
        return (
          <Panel key={finding.id} className="p-5">
            <div className="flex items-start gap-3">
              {canFile ? (
                <input
                  type="checkbox"
                  checked={selected.has(finding.id)}
                  onChange={() => toggle(finding.id)}
                  className="mt-1 size-4 shrink-0 accent-beacon-500"
                  aria-label={`Select repair: ${finding.title}`}
                />
              ) : (
                <AlertTriangle className="mt-1 size-4 shrink-0 text-night-500" />
              )}
              <div className="min-w-0 flex-1">
                <div className="flex flex-wrap items-center gap-2">
                  <Badge tone={findingTone(finding)}>{FINDING_LABEL[finding.kind]}</Badge>
                  {finding.origin === 'semantic' && <Badge tone="gold">review suggestion</Badge>}
                  {repair && <span className="text-[11.5px] text-night-500">can {repair}</span>}
                </div>
                <p className="mt-1.5 text-sm font-medium text-night-100">{finding.title}</p>
                <p className="mt-1 text-[13px] leading-6 text-night-400">{finding.detail}</p>
                {finding.evidence.length > 0 && (
                  <ul className="mt-2 space-y-1">
                    {finding.evidence.map((ev, i) => (
                      <li key={i} className="text-[12px] leading-5 text-night-500">
                        <span className="text-night-300">{ev.pageId}{ev.claimId ? ` · ${ev.claimId}` : ''}</span> — {ev.note}
                      </li>
                    ))}
                  </ul>
                )}
                <div className="mt-3 flex flex-wrap gap-2">
                  {finding.prompt && (
                    <Button size="sm" variant="outline" onClick={() => go('teachers', { teacher: 'guide', draft: finding.prompt! })}>
                      <MessageCircleQuestion /> Talk it through
                    </Button>
                  )}
                  <Button size="sm" variant="ghost" onClick={() => dismiss.mutate({ id: finding.id })} disabled={dismiss.isPending}>
                    <X /> Dismiss
                  </Button>
                </div>
              </div>
            </div>
          </Panel>
        );
      })}

      {actionable.length > 0 && (
        <Panel className="flex flex-col gap-3 p-5 md:flex-row md:items-center md:justify-between">
          <p className="text-[13px] leading-6 text-night-400">
            {actionableSelected.length
              ? `${actionableSelected.length} repair${actionableSelected.length === 1 ? '' : 's'} selected — filed as one proposal, applied only if you accept it.`
              : 'Tick the repairs you want — they are filed as one proposal you can still refuse.'}
          </p>
          <Button variant="primary" size="sm" disabled={!actionableSelected.length} loading={propose.isPending} onClick={fileRepairs}>
            <Wrench /> Propose repairs
          </Button>
        </Panel>
      )}

      {filed && filed.skipped.length > 0 && (
        <Panel className="border-ember-400/20 p-4 text-[12.5px] leading-6 text-night-400">
          <p className="mb-1 flex items-center gap-2 font-medium text-ember-300">
            <AlertTriangle className="size-3.5" /> Some findings could not be filed
          </p>
          <ul className="space-y-1">
            {filed.skipped.map((skip) => (
              <li key={skip.findingId}>• {skip.reason}</li>
            ))}
          </ul>
          <Button size="sm" variant="ghost" className="mt-2" onClick={() => setFiled(null)}>
            <Check /> Got it
          </Button>
        </Panel>
      )}
    </div>
  );
}
