import type { AnchorCandidate } from '@sef/shared';
import { BookMarked, ChevronDown, Globe, Search, Telescope, X } from 'lucide-react';
import { useState } from 'react';
import { Button } from '@/components/ui/button';
import { Badge, Eyebrow } from '@/components/ui/primitives';
import { SkeletonText } from '@/components/ui/primitives';
import { STATUS_STYLE } from '@/lib/brain-style';
import { cn } from '@/lib/cn';
import { useNav } from '@/lib/nav';
import { useAnchors, useAnchorWebPreview } from '@/lib/queries';
import type { Thread } from './chat-store';

function AnchorRow({ anchor, selected, onPick }: { anchor: AnchorCandidate; selected?: boolean; onPick: (a: AnchorCandidate) => void }) {
  const status = STATUS_STYLE[anchor.status];
  return (
    <button
      onClick={() => onPick(anchor)}
      className={cn(
        'flex w-full cursor-pointer items-center gap-3 rounded-xl border px-3.5 py-2.5 text-left transition',
        selected ? 'border-aurora-400/50 bg-aurora-500/[0.08]' : 'border-white/[0.07] hover:border-white/[0.16] hover:bg-white/[0.03]',
      )}
    >
      <Telescope className={cn('size-4 shrink-0', selected ? 'text-aurora-300' : 'text-night-500')} />
      <span className="min-w-0 flex-1">
        <span className="block truncate text-[13.5px] text-night-100">{anchor.title}</span>
        <span className="block truncate text-[11.5px] text-night-500">{anchor.courseName} · {anchor.conceptLabel}</span>
      </span>
      <Badge tone={status.tone}>{status.label}</Badge>
    </button>
  );
}

/**
 * The catalogue the Philosopher may start from — free text matched on-device as a filter;
 * the engine re-judges whatever is picked before the turn runs.
 */
export function AnchorPicker({ selected, onPick }: { selected?: string | null; onPick: (a: AnchorCandidate) => void }) {
  const anchors = useAnchors();
  const [query, setQuery] = useState('');
  const list = anchors.data?.anchors ?? [];
  const q = query.trim().toLowerCase();
  const filtered = q ? list.filter((a) => `${a.title} ${a.conceptLabel} ${a.courseName}`.toLowerCase().includes(q)) : list;

  if (anchors.isLoading) return <SkeletonText lines={3} />;
  if (anchors.isError) {
    return (
      <div className="rounded-xl border border-ember-400/25 bg-ember-500/[0.06] p-4 text-[13px] leading-6 text-night-300">
        <p>Your committed pages could not be loaded — {(anchors.error as Error).message}</p>
        <Button size="sm" variant="outline" className="mt-2.5" onClick={() => void anchors.refetch()}>
          Try again
        </Button>
      </div>
    );
  }
  if (!list.length) {
    return (
      <p className="rounded-xl border border-white/[0.06] bg-white/[0.03] p-4 text-sm leading-6 text-night-400">
        Nothing to explore from yet — the Philosopher starts from a concept already committed to your wiki. Write one there first, or let the Guide help you build it.
      </p>
    );
  }
  return (
    <div>
      <div className="mb-2 flex items-center gap-2 rounded-xl border border-white/[0.07] px-3">
        <Search className="size-3.5 text-night-500" />
        <input
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder="Filter your pages…"
          className="h-9 flex-1 bg-transparent text-[13px] text-night-100 placeholder:text-night-500 focus:outline-none"
        />
      </div>
      <div className="max-h-64 space-y-1.5 overflow-y-auto pr-0.5">
        {filtered.length ? (
          filtered.map((a) => <AnchorRow key={a.pageId} anchor={a} selected={a.pageId === selected} onPick={onPick} />)
        ) : (
          <p className="px-1 py-2 text-[12.5px] text-night-500">No committed page matches “{query}”.</p>
        )}
      </div>
    </div>
  );
}

/**
 * The consent row: what would leave this device if the web is armed this turn — the
 * topic-only query the engine derives, and where it would go. The toggle is one turn's:
 * it disarms after every send.
 */
function WebConsent({ pageId, armed, onToggle }: { pageId: string; armed: boolean; onToggle: (on: boolean) => void }) {
  const preview = useAnchorWebPreview(pageId);
  const p = preview.data;
  return (
    <div className="rounded-xl border border-white/[0.07] bg-white/[0.03] px-3 py-2.5">
      <label className="flex cursor-pointer items-center gap-2.5 text-[12.5px] text-night-200 select-none">
        <input type="checkbox" checked={armed} onChange={(e) => onToggle(e.target.checked)} className="size-3.5 accent-aurora-400" />
        <Globe className="size-3.5 text-aurora-300" />
        Search the web on this turn only
      </label>
      <p className="mt-1.5 text-[11.5px] leading-5 text-night-500">
        {preview.isLoading ? (
          'Checking what would be sent…'
        ) : p ? (
          <>
            Sends the topic <span className="text-night-300">“{p.query}”</span> to your SearXNG at {p.host} — never your words.
            {!p.reachable && <span className="text-ember-300"> It looks unreachable right now; the answer will say so.</span>}
          </>
        ) : (
          'The preview could not be checked — the answer will say if the web was unreachable.'
        )}
      </p>
    </div>
  );
}

/**
 * The Philosopher's anchor state over the composer: which committed page the conversation
 * explores from, with a jump to it in the sky and a way to re-anchor when the page moved.
 */
export function AnchorBar({
  thread,
  onAnchor,
  onConsent,
  onExploreChoice,
  onDismissChoices,
}: {
  thread: Thread;
  onAnchor: (a: AnchorCandidate | null) => void;
  onConsent: (on: boolean) => void;
  onExploreChoice: (a: AnchorCandidate) => void;
  onDismissChoices: () => void;
}) {
  const { go } = useNav();
  const [pickerOpen, setPickerOpen] = useState(false);
  const anchor = thread.anchor ?? null;
  const choices = thread.anchorChoices ?? null;

  return (
    <div className="mx-auto w-full max-w-3xl space-y-2 pb-3">
      {choices && (
        <div className="rounded-xl border border-aurora-400/25 bg-aurora-500/[0.06] p-3">
          <div className="mb-2 flex items-center justify-between gap-2">
            <Eyebrow>More than one page matches — pick the anchor</Eyebrow>
            <button onClick={onDismissChoices} className="cursor-pointer text-night-500 hover:text-night-200" aria-label="Dismiss">
              <X className="size-3.5" />
            </button>
          </div>
          <div className="space-y-1.5">
            {choices.map((a) => (
              <AnchorRow key={a.pageId} anchor={a} onPick={onExploreChoice} />
            ))}
          </div>
        </div>
      )}

      <div className="flex flex-wrap items-center gap-2 rounded-xl border border-white/[0.07] bg-white/[0.02] px-3 py-2">
        <Telescope className="size-3.5 shrink-0 text-aurora-300" />
        {anchor ? (
          <>
            <span className="min-w-0 flex-1 truncate text-[12.5px] text-night-200">
              Exploring from <button onClick={() => go('sky', { page: anchor.pageId })} className="cursor-pointer font-medium text-night-100 underline decoration-white/25 underline-offset-2 hover:text-aurora-200">{anchor.title}</button>
              <span className="text-night-500"> · {anchor.courseName}</span>
            </span>
            <Badge tone={STATUS_STYLE[anchor.status].tone}>{STATUS_STYLE[anchor.status].label}</Badge>
          </>
        ) : (
          <span className="flex-1 text-[12.5px] text-night-400">No anchor — pick a committed page of yours to explore from.</span>
        )}
        <button
          onClick={() => setPickerOpen((v) => !v)}
          className="inline-flex cursor-pointer items-center gap-1 rounded-lg px-2 py-1 text-[11.5px] text-night-400 transition hover:bg-white/[0.05] hover:text-night-200"
        >
          <BookMarked className="size-3" /> {anchor ? 'Change' : 'Choose page'} <ChevronDown className={cn('size-3 transition', pickerOpen && 'rotate-180')} />
        </button>
      </div>

      {pickerOpen && (
        <div className="rounded-xl border border-white/[0.07] bg-white/[0.02] p-3">
          <AnchorPicker
            selected={anchor?.pageId ?? null}
            onPick={(a) => {
              onAnchor(a);
              setPickerOpen(false);
            }}
          />
        </div>
      )}

      {anchor && <WebConsent pageId={anchor.pageId} armed={Boolean(thread.webConsent)} onToggle={onConsent} />}
    </div>
  );
}
