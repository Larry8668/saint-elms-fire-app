import { ChevronDown, Sprout } from 'lucide-react';
import { motion, useReducedMotion } from 'motion/react';
import { useMemo, useState } from 'react';
import { Eyebrow, Panel, Skeleton } from '@/components/ui/primitives';
import { useBrainLog, useEvents, useJobBoard, useRecords } from '@/lib/queries';
import { ModalityMark } from './modality';
import { buildStory, groupByDay, type StoryEntry } from './story';

const PAGE_SIZE = 8;

/** A page id the vault has no record for (a course concept) still reads as words. */
export const prettyId = (id: string) => id.replace(/[-_]+/g, ' ').replace(/^\w/, (c) => c.toUpperCase());

const clock = (at: string) => {
  const date = new Date(at);
  return Number.isNaN(date.getTime()) ? '' : date.toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' });
};

/**
 * "What your brain learned": the growth ledger read back as plain sentences, grouped by day —
 * which material came in, what it read as, and which pages it wrote. Page titles open the
 * page. Collected knowledge and the student's own work stay visibly different.
 */
export function LearnedTimeline({ onOpenPage, className }: { onOpenPage: (pageId: string) => void; className?: string }) {
  const events = useEvents();
  const log = useBrainLog();
  const board = useJobBoard();
  const records = useRecords();
  const reduced = useReducedMotion();
  const [visible, setVisible] = useState(PAGE_SIZE);

  const story = useMemo(() => {
    const byId = new Map((records.data ?? []).map((r) => [r.id, r]));
    return buildStory({
      events: events.data ?? [],
      log: log.data ?? [],
      sources: board.data?.sources ?? [],
      titleOf: (id) => byId.get(id)?.title ?? prettyId(id),
      kindOf: (id) => byId.get(id)?.kind,
    });
  }, [events.data, log.data, board.data, records.data]);

  const shown = story.slice(0, visible);
  const days = groupByDay(shown);
  const loading = events.isLoading || log.isLoading;

  return (
    <Panel className={`p-5 ${className ?? ''}`} aria-labelledby="learned-title">
      <div className="mb-4 flex items-baseline justify-between gap-3">
        <div>
          <Eyebrow className="tracking-[0.2em] text-aurora-300/80">Raw sources in, compiled pages out</Eyebrow>
          <h2 id="learned-title" className="mt-1 font-display text-[26px] leading-tight text-night-100">
            What your brain learned
          </h2>
        </div>
        {story.length > 0 && <span className="shrink-0 text-[11.5px] text-night-500">{story.length} moments</span>}
      </div>

      {loading && (
        <div className="space-y-3" aria-hidden>
          {[0, 1, 2].map((i) => (
            <div key={i} className="flex items-center gap-3">
              <Skeleton className="size-7 rounded-full" />
              <Skeleton className="h-4 flex-1" />
            </div>
          ))}
        </div>
      )}

      {!loading && story.length === 0 && (
        <p className="flex items-center gap-2 text-[13px] text-night-400">
          <Sprout className="size-4 text-aurora-400" /> Nothing yet. File a photo, a voice memo or a note and the first page it writes shows up here.
        </p>
      )}

      <div className="space-y-4">
        {days.map((day) => (
          <section key={day.label} aria-label={day.label}>
            <div className="mb-1.5 text-[10.5px] font-semibold tracking-[0.16em] text-night-500 uppercase">{day.label}</div>
            <ol className="relative space-y-0.5 before:absolute before:top-3 before:bottom-3 before:left-[13.5px] before:w-px before:bg-white/[0.07]">
              {day.entries.map((entry, i) => (
                <motion.li
                  key={entry.id}
                  initial={reduced ? false : { opacity: 0, y: 4 }}
                  animate={{ opacity: 1, y: 0 }}
                  transition={reduced ? { duration: 0 } : { delay: Math.min(i, 6) * 0.03, duration: 0.25 }}
                  className="relative"
                >
                  <StoryRow entry={entry} onOpenPage={onOpenPage} />
                </motion.li>
              ))}
            </ol>
          </section>
        ))}
      </div>

      {story.length > visible && (
        <button
          type="button"
          onClick={() => setVisible((n) => n + PAGE_SIZE * 2)}
          className="mt-4 inline-flex cursor-pointer items-center gap-1.5 rounded-full border border-white/[0.08] bg-white/[0.03] px-3 py-1 text-[12px] text-night-300 transition hover:border-white/[0.16] hover:text-night-100"
        >
          <ChevronDown className="size-3.5" /> Show more · {story.length - visible} earlier
        </button>
      )}
    </Panel>
  );
}

function StoryRow({ entry, onOpenPage }: { entry: StoryEntry; onOpenPage: (pageId: string) => void }) {
  return (
    <div className="flex items-start gap-3 rounded-xl px-0 py-1.5">
      <ModalityMark modality={entry.modality} className="relative z-[1] size-7 bg-night-900" />
      <div className="min-w-0 flex-1 pt-0.5">
        <div className="flex items-baseline justify-between gap-3">
          <p className={`text-[13.5px] leading-6 ${entry.yours ? 'text-night-100' : 'text-night-200'}`}>{entry.sentence}</p>
          <span className="shrink-0 text-[11px] text-night-500 tabular-nums" title={entry.yours ? 'Your own work' : 'Collected knowledge — it never counts as yours until you show it'}>
            {!entry.yours && entry.pages.length > 0 ? 'collected · ' : ''}
            {clock(entry.at)}
          </span>
        </div>
        {entry.pages.length > 0 && (
          <div className="mt-1 flex flex-wrap gap-1.5">
            {entry.pages.map((page) => (
              <button
                key={page.id}
                type="button"
                onClick={() => onOpenPage(page.id)}
                title={page.title}
                className="inline-flex max-w-full cursor-pointer items-center gap-1.5 rounded-full border border-white/[0.07] bg-white/[0.03] px-2 py-0.5 text-[11.5px] text-night-300 transition hover:border-beacon-400/40 hover:text-beacon-200"
              >
                {page.created && <span className="size-1.5 shrink-0 rounded-full bg-aurora-400 shadow-[0_0_6px] shadow-aurora-400" aria-label="new page" />}
                <span className="truncate">{page.title}</span>
              </button>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
