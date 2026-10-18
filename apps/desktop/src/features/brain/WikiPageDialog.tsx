import type { WikiClaimView, WikiPageView } from '@sef/shared';
import { AlertTriangle, ArrowRight, BookOpen, Link2, ShieldAlert, ShieldCheck } from 'lucide-react';
import { Markdown } from '@/components/Markdown';
import { Dialog } from '@/components/ui/overlays';
import { Badge, Eyebrow, SkeletonText } from '@/components/ui/primitives';
import { SOURCE_KIND_ICON } from '@/features/brain/SourceDetail';
import { locatorLabel, originLabel, pageKindLabel, sourceKindLabel } from '@/features/contribute/review';
import { useWikiPage } from '@/lib/queries';
import { timeAgo } from '@/lib/time';
import { PageHistory } from './PageHistory';

const ORIGIN_TONE: Record<WikiClaimView['origin'], 'neutral' | 'beacon' | 'ember' | 'aurora' | 'gold' | 'rose'> = {
  course: 'beacon',
  external: 'neutral',
  student: 'aurora',
  peer: 'ember',
  model: 'gold',
};

function ClaimRow({ claim, view }: { claim: WikiClaimView; view: WikiPageView }) {
  const sourceTitle = (id: string) => view.sources.find((s) => s.id === id)?.title ?? id;
  return (
    <li className="rounded-xl border border-white/[0.06] bg-white/[0.02] p-3.5">
      <p className="text-[13px] leading-6 text-night-200">{claim.text}</p>
      <div className="mt-2 flex flex-wrap items-center gap-1.5">
        <Badge tone={claim.assertable ? 'aurora' : 'ember'}>
          {claim.assertable ? <ShieldCheck className="size-3" /> : <ShieldAlert className="size-3" />}
          {claim.assertable ? 'assertable' : `withheld${claim.reason ? ` — ${claim.reason.replace(/_/g, ' ')}` : ''}`}
        </Badge>
        <Badge tone={ORIGIN_TONE[claim.origin]}>{originLabel(claim.origin)}</Badge>
        <Badge>{claim.kind.replace(/_/g, ' ')}</Badge>
        {claim.status !== 'current' && <Badge tone="rose">{claim.status}</Badge>}
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

      <Markdown variant="chat" className="max-h-72 overflow-y-auto rounded-xl bg-black/25 p-3.5 text-[13px] whitespace-pre-wrap">
        {page.body}
      </Markdown>

      {page.claims.length > 0 && (
        <section>
          <Eyebrow className="mb-2">Claims · {page.claims.length}</Eyebrow>
          <ul className="space-y-2">
            {page.claims.map((claim) => (
              <ClaimRow key={claim.id} claim={claim} view={page} />
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

      {(page.sources.length > 0 || page.missingSourceIds.length > 0) && (
        <section>
          <Eyebrow className="mb-2">Rests on · {page.sources.length + page.missingSourceIds.length} source{(page.sources.length + page.missingSourceIds.length) === 1 ? '' : 's'}</Eyebrow>
          <div className="flex flex-wrap gap-1.5">
            {page.sources.map((source) => {
              const Icon = SOURCE_KIND_ICON[source.kind];
              return (
                <button
                  key={source.id}
                  type="button"
                  onClick={() => onOpenSource?.(source.id)}
                  className="inline-flex cursor-pointer items-center gap-1.5 rounded-full border border-white/[0.07] bg-white/[0.03] px-2.5 py-1 text-[11.5px] text-night-300 transition hover:border-white/[0.16] hover:text-night-100"
                  title={`${sourceKindLabel(source.kind)} · ${originLabel(source.origin)} · ${source.id}`}
                >
                  <Icon className="size-3 text-beacon-300" />
                  {source.title}
                </button>
              );
            })}
            {page.missingSourceIds.map((id) => (
              <Badge key={id} tone="ember">
                <AlertTriangle className="size-3" /> {id} — record gone
              </Badge>
            ))}
          </div>
        </section>
      )}

      <PageHistory pageKey={page.id} />
    </div>
  );
}
