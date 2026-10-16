import { PAGE_SECTIONS, SECTION_TITLES, type PageRecordView } from '@sef/shared';
import { AlertTriangle, MessageCircleQuestion, X } from 'lucide-react';
import { Markdown } from '@/components/Markdown';
import { Button } from '@/components/ui/button';
import { Sheet, SheetClose } from '@/components/ui/overlays';
import { Badge, Eyebrow } from '@/components/ui/primitives';
import { SectionsSkeleton } from '@/components/ui/skeletons';
import { KIND_STYLE, STATUS_STYLE } from '@/lib/brain-style';
import { useNav } from '@/lib/nav';
import { useEvents, usePageRecord } from '@/lib/queries';
import { timeAgo } from '@/lib/time';
import { GrowthTrail } from './GrowthTrail';

const KIND_TITLE: Record<PageRecordView['kind'], string> = {
  concept: 'Concept',
  source_summary: 'Kept source',
  synthesis: KIND_STYLE.synthesis.label,
  question: KIND_STYLE.question.label,
};

const ORIGIN_LABEL: Record<PageRecordView['origin'], string> = {
  student: 'Your page',
  peer: 'Built from a peer share',
  legacy: 'From the earlier vault',
};

/**
 * The detail sheet for any vault page that is not drawn as a star — source summaries, and
 * anything the sky does not carry. Same provenance honesty as the sky sheet: the origin badge
 * says whose material the page holds.
 */
export function RecordSheet({ pageId, onClose }: { pageId: string | null; onClose: () => void }) {
  const { go } = useNav();
  const record = usePageRecord(pageId);
  const events = useEvents(pageId);
  const data = record.data ?? null;

  return (
    <Sheet open={Boolean(pageId)} onOpenChange={(open) => !open && onClose()}>
      <div className="flex items-start justify-between gap-3 border-b border-white/[0.07] p-5">
        <div className="min-w-0">
          <Eyebrow>{data ? KIND_TITLE[data.kind] : 'Page'}</Eyebrow>
          <h2 className="mt-1.5 font-display text-[30px] leading-tight text-night-100">{data?.title ?? '…'}</h2>
          {data && (
            <div className="mt-2.5 flex flex-wrap gap-1.5">
              <Badge>{KIND_TITLE[data.kind]}</Badge>
              <Badge>{ORIGIN_LABEL[data.origin]}</Badge>
              {data.status && <Badge tone={STATUS_STYLE[data.status].tone}>{STATUS_STYLE[data.status].label}</Badge>}
              {(data.openMisconceptions ?? 0) > 0 && (
                <Badge tone="ember">
                  <AlertTriangle className="size-3" /> {data.openMisconceptions} open
                </Badge>
              )}
              <Badge>{timeAgo(data.updatedAt)}</Badge>
            </div>
          )}
        </div>
        <SheetClose className="rounded-lg p-1.5 text-night-400 hover:bg-white/10 hover:text-night-100" aria-label="Close">
          <X className="size-4" />
        </SheetClose>
      </div>

      <div className="flex-1 space-y-6 overflow-y-auto p-5">
        {record.isLoading && <SectionsSkeleton />}
        {data && (
          <>
            {data.summary && <p className="text-[13.5px] leading-6 text-night-400">{data.summary}</p>}
            {data.markdown ? <Markdown variant="chat">{data.markdown}</Markdown> : null}
            {data.learner && (
              <div className="space-y-5">
                {PAGE_SECTIONS.map((section) => {
                  const field = { in_my_words: data.learner!.inMyWords, where_i_got_stuck: data.learner!.stuck, connections: data.learner!.connections }[section];
                  return field ? (
                    <section key={section}>
                      <Eyebrow className="mb-1.5">{SECTION_TITLES[section]}</Eyebrow>
                      <Markdown variant="chat">{field}</Markdown>
                    </section>
                  ) : null;
                })}
              </div>
            )}
            {data.claims.length > 0 && (
              <section>
                <Eyebrow className="mb-2">Claims on this page</Eyebrow>
                <div className="space-y-2">
                  {data.claims.map((claim) => (
                    <div key={claim.id} className="rounded-xl border border-white/[0.06] p-3 text-sm">
                      <p className="text-night-200">{claim.text}</p>
                      <p className="mt-1.5 flex flex-wrap gap-1.5 text-[11px] text-night-500">
                        <Badge>{claim.kind.replace('_', ' ')}</Badge>
                        <Badge>{claim.origin === 'student' ? 'yours' : `from ${claim.origin}`}</Badge>
                        {claim.status !== 'current' && <Badge tone={claim.status === 'disputed' ? 'ember' : 'neutral'}>{claim.status}</Badge>}
                      </p>
                    </div>
                  ))}
                </div>
              </section>
            )}
            {data.links.length > 0 && (
              <section>
                <Eyebrow className="mb-2">Links out</Eyebrow>
                <ul className="space-y-1 text-sm">
                  {data.links.map((link, i) => (
                    <li key={i} className="flex items-center justify-between gap-3 rounded-lg px-2.5 py-1.5">
                      <span className="min-w-0 truncate text-night-200">{link.toPageId}</span>
                      <span className="shrink-0 text-[11px] text-night-500">
                        {link.type.replace('_', ' ')} · {link.origin}
                      </span>
                    </li>
                  ))}
                </ul>
              </section>
            )}
            {events.data && <GrowthTrail events={events.data} />}
          </>
        )}
        {record.isError && <p className="text-sm text-night-400">This page could not be read — it may still be syncing or was written by a newer schema.</p>}
      </div>

      <div className="grid grid-cols-2 gap-2 border-t border-white/[0.07] p-4">
        <Button variant="primary" className="col-span-2" onClick={() => go('teachers', { teacher: 'guide', draft: `Help me think through my page "${data?.title ?? ''}".` })}>
          <MessageCircleQuestion /> Ask the Guide
        </Button>
      </div>
    </Sheet>
  );
}
