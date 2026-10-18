import { ChevronDown, MessageCircleQuestion, Scale } from 'lucide-react';
import { motion, useReducedMotion } from 'motion/react';
import { useMemo, useState } from 'react';
import { Button } from '@/components/ui/button';
import { Badge, Eyebrow, Panel, Skeleton } from '@/components/ui/primitives';
import { useNav } from '@/lib/nav';
import { useMaintenance, useRecords, useWikiDisputes } from '@/lib/queries';
import { prettyId } from './LearnedTimeline';
import { ModalityMark } from './modality';
import { buildDisagreements, modalityOf, type Disagreement, type DisagreementSide } from './story';

const PAGE_SIZE = 3;

const STATE_BADGE: Record<Disagreement['state'], { label: string; tone: 'ember' | 'gold' | 'rose' }> = {
  disputed: { label: 'both kept · disputed', tone: 'ember' },
  flagged: { label: 'spotted by review', tone: 'gold' },
  misconception: { label: 'your words vs the course', tone: 'rose' },
};

/**
 * "Your brain disagrees with itself": when new material contradicts what a page already
 * held, the keeper keeps both versions and marks them disputed instead of overwriting.
 * This panel puts the two versions side by side with what each rests on, and hands the
 * disagreement to the Guide to think through — nothing here picks a winner.
 */
export function Contradictions({ onOpenPage, onOpenSource, className }: { onOpenPage: (pageId: string) => void; onOpenSource?: (sourceId: string) => void; className?: string }) {
  const disputes = useWikiDisputes();
  const maintenance = useMaintenance();
  const records = useRecords();
  const [visible, setVisible] = useState(PAGE_SIZE);
  const reduced = useReducedMotion();

  const list = useMemo(() => {
    const titles = new Map((records.data ?? []).map((r) => [r.id, r.title]));
    return buildDisagreements(disputes.data?.disputes ?? [], maintenance.data?.findings ?? [], (id) => titles.get(id) ?? prettyId(id));
  }, [disputes.data, maintenance.data, records.data]);

  return (
    <Panel className={`p-5 ${className ?? ''}`} aria-labelledby="disagrees-title">
      <div className="mb-4 flex items-baseline justify-between gap-3">
        <div>
          <Eyebrow className="tracking-[0.2em] text-aurora-300/80">Both versions kept, nothing overwritten</Eyebrow>
          <h2 id="disagrees-title" className="mt-1 font-display text-[26px] leading-tight text-night-100">
            Your brain disagrees with itself
          </h2>
        </div>
        {list.length > 0 && <Badge tone="ember">{list.length}</Badge>}
      </div>

      {disputes.isLoading && <Skeleton className="h-24 w-full rounded-xl" />}
      {disputes.isError && <p className="text-[13px] text-night-400">{(disputes.error as Error).message}</p>}
      {!disputes.isLoading && !disputes.isError && list.length === 0 && (
        <p className="flex items-center gap-2 text-[13px] text-night-400">
          <Scale className="size-4 text-aurora-400" /> Every claim agrees with the rest. When new material contradicts a page, both versions land here.
        </p>
      )}

      <ul className="space-y-3">
        {list.slice(0, visible).map((item, i) => (
          <motion.li
            key={item.id}
            initial={reduced ? false : { opacity: 0, y: 6 }}
            animate={{ opacity: 1, y: 0 }}
            transition={reduced ? { duration: 0 } : { delay: Math.min(i, 4) * 0.05 }}
          >
            <DisagreementCard item={item} onOpenPage={onOpenPage} onOpenSource={onOpenSource} />
          </motion.li>
        ))}
      </ul>

      {list.length > visible && (
        <button
          type="button"
          onClick={() => setVisible((n) => n + PAGE_SIZE * 2)}
          className="mt-3 inline-flex cursor-pointer items-center gap-1.5 rounded-full border border-white/[0.08] bg-white/[0.03] px-3 py-1 text-[12px] text-night-300 transition hover:border-white/[0.16] hover:text-night-100"
        >
          <ChevronDown className="size-3.5" /> Show more · {list.length - visible} more
        </button>
      )}
    </Panel>
  );
}

function DisagreementCard({ item, onOpenPage, onOpenSource }: { item: Disagreement; onOpenPage: (pageId: string) => void; onOpenSource?: (sourceId: string) => void }) {
  const { go } = useNav();
  const badge = STATE_BADGE[item.state];
  return (
    <div className="rounded-2xl border border-white/[0.07] bg-black/20 p-4">
      <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
        <button type="button" onClick={() => onOpenPage(item.pageId)} className="cursor-pointer text-left font-display text-[19px] leading-tight text-night-100 hover:text-beacon-200">
          {item.pageTitle}
        </button>
        <Badge tone={badge.tone}>{badge.label}</Badge>
      </div>
      {/* Stacked, not columns: the panel sits beside the feed, and each version needs room to read. */}
      <div className="space-y-1.5">
        {item.sides[0] && <Side side={item.sides[0]} onOpenPage={onOpenPage} onOpenSource={onOpenSource} />}
        {item.sides.length === 2 && (
          <div className="flex items-center gap-2 px-1" aria-hidden>
            <span className="h-px flex-1 bg-white/[0.06]" />
            <span className="font-display text-[15px] text-night-500 italic">versus</span>
            <span className="h-px flex-1 bg-white/[0.06]" />
          </div>
        )}
        {item.sides[1] && <Side side={item.sides[1]} onOpenPage={onOpenPage} onOpenSource={onOpenSource} />}
      </div>
      <div className="mt-3 flex justify-end">
        <Button variant="primary" size="sm" onClick={() => go('teachers', { teacher: 'guide', draft: item.prompt })}>
          <MessageCircleQuestion /> Work through it with the Guide
        </Button>
      </div>
    </div>
  );
}

function Side({ side, onOpenPage, onOpenSource }: { side: DisagreementSide; onOpenPage: (pageId: string) => void; onOpenSource?: (sourceId: string) => void }) {
  const tone = side.origin === 'student' ? 'border-aurora-400/25' : side.origin === 'course' ? 'border-beacon-400/25' : 'border-ember-400/25';
  return (
    <div className={`min-w-0 rounded-xl border-l-2 bg-white/[0.025] px-3.5 py-2.5 ${tone}`}>
      <div className="mb-1 text-[10.5px] font-semibold tracking-[0.14em] text-night-500 uppercase">
        {side.pageId ? (
          <button type="button" onClick={() => onOpenPage(side.pageId!)} className="cursor-pointer uppercase hover:text-beacon-200">
            {side.label}
          </button>
        ) : (
          side.label
        )}
      </div>
      <p className="text-[13.5px] leading-6 text-night-200">“{side.text}”</p>
      {(side.sources.length > 0 || side.missingSourceIds.length > 0) && (
        <div className="mt-2 flex flex-wrap gap-1.5">
          {side.sources.map((source) => (
            <button
              key={source.id}
              type="button"
              disabled={!onOpenSource}
              onClick={() => onOpenSource?.(source.id)}
              className="inline-flex max-w-full cursor-pointer items-center gap-1.5 rounded-full border border-white/[0.07] bg-white/[0.03] py-0.5 pr-2.5 pl-0.5 text-[11px] text-night-300 transition hover:border-white/[0.16] hover:text-night-100 disabled:cursor-default"
            >
              <ModalityMark modality={modalityOf({ kind: source.kind, mediaType: '', origin: source.origin })} className="size-5" iconClassName="size-2.5" />
              <span className="truncate">{source.title}</span>
            </button>
          ))}
          {side.missingSourceIds.map((id) => (
            <span key={id} className="rounded-full border border-ember-400/25 px-2 py-0.5 text-[11px] text-ember-300">
              {id} — gone
            </span>
          ))}
        </div>
      )}
    </div>
  );
}
