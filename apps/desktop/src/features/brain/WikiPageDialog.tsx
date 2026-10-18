import type { WikiClaimView, WikiPageView } from '@sef/shared';
import { BookOpen, Link2, ShieldAlert, ShieldCheck } from 'lucide-react';
import { useMemo, useState } from 'react';
import { Markdown } from '@/components/Markdown';
import { Dialog } from '@/components/ui/overlays';
import { Badge, Eyebrow, SkeletonText } from '@/components/ui/primitives';
import { locatorLabel, originLabel, pageKindLabel } from '@/features/contribute/review';
import { useWikiPage } from '@/lib/queries';
import { timeAgo } from '@/lib/time';
import { PageHistory } from './PageHistory';
import { CitationMarks, Provenance } from './story/Provenance';
import { sourceNumbers } from './story/story';

const ORIGIN_TONE: Record<WikiClaimView['origin'], 'neutral' | 'beacon' | 'ember' | 'aurora' | 'gold' | 'rose'> = {
  course: 'beacon',
  external: 'neutral',
  student: 'aurora',
  peer: 'ember',
  model: 'gold',
};

function ClaimRow({
  claim,
  view,
  numbers,
  activeSource,
  onSelectSource,
}: {
  claim: WikiClaimView;
  view: WikiPageView;
  numbers: Map<string, number>;
  activeSource: string | null;
  onSelectSource: (id: string) => void;
}) {
  const sourceTitle = (id: string) => view.sources.find((s) => s.id === id)?.title ?? id;
  const fromActive = Boolean(activeSource && claim.citations.some((c) => c.sourceId === activeSource));
  return (
    <li className={`rounded-xl border p-3.5 transition ${fromActive ? 'border-aurora-400/40 bg-aurora-500/[0.06]' : 'border-white/[0.06] bg-white/[0.02]'}`}>
      <p className="text-[13px] leading-6 text-night-200">{claim.text}</p>
      <div className="mt-2 flex flex-wrap items-center gap-1.5">
        <Badge tone={claim.assertable ? 'aurora' : 'ember'}>
          {claim.assertable ? <ShieldCheck className="size-3" /> : <ShieldAlert className="size-3" />}
          {claim.assertable ? 'assertable' : `withheld${claim.reason ? ` — ${claim.reason.replace(/_/g, ' ')}` : ''}`}
        </Badge>
        <Badge tone={ORIGIN_TONE[claim.origin]}>{originLabel(claim.origin)}</Badge>
        <Badge>{claim.kind.replace(/_/g, ' ')}</Badge>
        {claim.status !== 'current' && <Badge tone="rose">{claim.status}</Badge>}
        <CitationMarks claim={claim} numbers={numbers} active={activeSource} onSelect={(id) => onSelectSource(id === activeSource ? '' : id)} />
      </div>
      {claim.citations.length > 0 && (
        <ul className="mt-2 space-y-1">
          {claim.citations.map((citation, i) => (
            <li key={i} className="flex items-baseline gap-1.5 text-[11.5px] text-night-500">
              <BookOpen className="size-3 shrink-0 translate-y-0.5" />
              <span>
                {sourceTitle(citation.sourceId)} <span className="text-night-600">({citation.sourceId})</span> · {locatorLabel(citation.locator)} · rev {citation.sourceRevision.slice(0, 8)}
              </span>
            </li>
          ))}
        </ul>
      )}
    </li>
  );
}

/**
 * One compiled wiki page through the permitted view: the body, every claim with the
 * verdict the engine would give a teacher right now, its links, and the sources it
 * rests on. History and restore come from the shared PageHistory block.
 */
export function WikiPageDialog({
  pageId,
  onClose,
  onOpenSource,
  onOpenPage,
}: {
  pageId: string | null;
  onClose: () => void;
  onOpenSource?: (sourceId: string) => void;
  onOpenPage?: (pageId: string) => void;
}) {
  const view = useWikiPage(pageId);
  const page = view.data;

  return (
    <Dialog
      open={Boolean(pageId)}
      onOpenChange={(open) => !open && onClose()}
      title={page?.title ?? 'Wiki page'}
      description={page ? `${pageKindLabel(page.kind)} · ${page.revision.slice(0, 10)}${page.updatedAt ? ` · updated ${timeAgo(page.updatedAt)}` : ''}` : undefined}
    >
      {view.isLoading && <SkeletonText lines={8} />}
      {view.isError && <p className="text-sm text-rose-400">{(view.error as Error).message}</p>}
      {page && <PageBody page={page} onOpenSource={onOpenSource} onOpenPage={onOpenPage} />}
    </Dialog>
  );
}

function PageBody({ page, onOpenSource, onOpenPage }: { page: WikiPageView; onOpenSource?: (sourceId: string) => void; onOpenPage?: (pageId: string) => void }) {
  const [activeSource, setActiveSource] = useState<string | null>(null);
  const sourceIds = useMemo(() => page.sources.map((s) => s.id), [page.sources]);
  const numbers = useMemo(() => sourceNumbers(sourceIds), [sourceIds]);
  return (
    <div className="space-y-5">
      <div className="flex flex-wrap items-center gap-1.5">
        <Badge tone="beacon">{pageKindLabel(page.kind)}</Badge>
        {page.state !== 'ok' && <Badge tone="ember">{page.state === 'out_of_band' ? 'edited outside the keeper' : page.state}</Badge>}
        {page.kind !== 'concept' && (
          <Badge tone="gold">
            <ShieldAlert className="size-3" /> generated — never counts as your evidence
          </Badge>
        )}
      </div>
      {page.summary && (
        <Markdown variant="compact" className="text-[12.5px] leading-5 text-night-400">
          {page.summary}
        </Markdown>
      )}

      <Provenance
        sourceIds={sourceIds}
        missingSourceIds={page.missingSourceIds}
        claims={page.claims}
        active={activeSource}
        onActiveChange={setActiveSource}
        onOpenSource={onOpenSource}
      />

      <Markdown variant="chat" className="max-h-72 overflow-y-auto rounded-xl bg-black/25 p-3.5 text-[13px] whitespace-pre-wrap">
        {page.body}
      </Markdown>

      {page.claims.length > 0 && (
        <section>
          <Eyebrow className="mb-2">Claims · {page.claims.length}</Eyebrow>
          <ul className="space-y-2">
            {page.claims.map((claim) => (
              <ClaimRow key={claim.id} claim={claim} view={page} numbers={numbers} activeSource={activeSource} onSelectSource={(id) => setActiveSource(id || null)} />
            ))}
          </ul>
        </section>
      )}

      {page.links.length > 0 && (
        <section>
          <Eyebrow className="mb-2">Links · {page.links.length}</Eyebrow>
          <ul className="space-y-1.5">
            {page.links.map((link, i) => (
              <li key={i} className="flex flex-wrap items-center gap-2 text-[12.5px] text-night-300">
                <Link2 className="size-3.5 text-aurora-400" />
                {onOpenPage ? (
                  <button type="button" onClick={() => onOpenPage(link.toPageId)} className="cursor-pointer text-night-100 underline decoration-white/20 underline-offset-2 hover:text-beacon-200">
                    {link.toPageId}
                  </button>
                ) : (
                  <span className="text-night-100">{link.toPageId}</span>
                )}
                <Badge>{link.type.replace(/_/g, ' ')}</Badge>
                <Badge tone={link.origin === 'student' ? 'aurora' : 'neutral'}>{link.origin}</Badge>
                <span className="text-night-500">{link.why}</span>
              </li>
            ))}
          </ul>
        </section>
      )}

      <PageHistory pageKey={page.id} />
    </div>
  );
}
