import type { WikiIndex, WikiPageEntry } from '@sef/shared';
import { BookOpenText, Brain, CircleHelp, Layers, ScrollText, Search, type LucideIcon } from 'lucide-react';
import { motion } from 'motion/react';
import { useMemo, useState } from 'react';
import { Badge, EmptyState, Eyebrow, Input, Panel } from '@/components/ui/primitives';
import { RowListSkeleton } from '@/components/ui/skeletons';
import { timeAgo } from '@/lib/time';
import { pageKindLabel } from '@/features/contribute/review';

const KIND_META: Record<WikiPageEntry['kind'], { Icon: LucideIcon; group: string; hint: string }> = {
  concept: { Icon: Brain, group: 'Concepts', hint: 'Your own pages, in your words' },
  synthesis: { Icon: Layers, group: 'Syntheses', hint: 'Worked answers saved from conversations' },
  source_summary: { Icon: ScrollText, group: 'Source notes', hint: 'What the engine drew out of kept material' },
  question: { Icon: CircleHelp, group: 'Open questions', hint: 'Things still unresolved' },
};
const KIND_ORDER: WikiPageEntry['kind'][] = ['synthesis', 'question', 'source_summary', 'concept'];

const shortRev = (revision: string) => (revision.length > 12 ? `${revision.slice(0, 10)}…` : revision);

function WikiRow({ page, index, onOpen }: { page: WikiPageEntry; index: number; onOpen: () => void }) {
  const { Icon } = KIND_META[page.kind];
  return (
    <motion.button
      initial={{ opacity: 0, y: 6 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ delay: Math.min(index, 8) * 0.03 }}
      onClick={onOpen}
      className="w-full cursor-pointer text-left"
    >
      <Panel className="flex items-start gap-3.5 p-4 transition hover:border-white/[0.14]">
        <span className="mt-0.5 grid size-9 shrink-0 place-items-center rounded-lg bg-white/[0.05] text-beacon-300">
          <Icon className="size-4" />
        </span>
        <span className="min-w-0 flex-1">
          <span className="flex flex-wrap items-center gap-2">
            <span className="truncate text-[14px] font-medium text-night-100">{page.title}</span>
            {page.state !== 'ok' && <Badge tone="ember">{page.state === 'out_of_band' ? 'edited outside the keeper' : page.state}</Badge>}
          </span>
          <span className="mt-1 line-clamp-2 block text-[12.5px] leading-5 text-night-400">{page.summary}</span>
          <span className="mt-2 flex flex-wrap gap-x-3 gap-y-1 text-[11px] text-night-500">
            <span>{shortRev(page.revision)}</span>
            {page.sourceIds.length > 0 && <span>{page.sourceIds.length} source{page.sourceIds.length === 1 ? '' : 's'}</span>}
            {page.claims > 0 && <span>{page.claims} claim{page.claims === 1 ? '' : 's'}</span>}
            {page.links > 0 && <span>{page.links} link{page.links === 1 ? '' : 's'}</span>}
            {page.updatedAt && <span>{timeAgo(page.updatedAt)}</span>}
          </span>
        </span>
      </Panel>
    </motion.button>
  );
}

/**
 * The compiled wiki as a catalogue: every typed page with its index summary, source count
 * and claim count — what index.md says, rendered. The filter runs client-side over the
 * same catalogue the teachers search through search_wiki.
 */
export function WikiIndexPanel({
  index,
  loading,
  onOpen,
  matchIds = null,
}: {
  index: WikiIndex | undefined;
  loading: boolean;
  onOpen: (id: string) => void;
  /** The Brain section's search, when one is active: only these pages are listed. */
  matchIds?: Set<string> | null;
}) {
  const [filter, setFilter] = useState('');
  const groups = useMemo(() => {
    const q = filter.trim().toLowerCase();
    const rows = (index?.pages ?? []).filter((p) => (!matchIds || matchIds.has(p.id)) && (!q || `${p.title} ${p.summary} ${p.id}`.toLowerCase().includes(q)));
    return KIND_ORDER.map((kind) => ({ kind, rows: rows.filter((p) => p.kind === kind) })).filter((g) => g.rows.length > 0);
  }, [index, filter, matchIds]);

  if (loading) return <RowListSkeleton />;

  return (
    <div className="max-w-3xl space-y-5">
      <div className="flex flex-wrap items-center gap-2">
        <Badge tone="beacon">
          <BookOpenText className="size-3" /> {index?.counts.pages ?? 0} page{(index?.counts.pages ?? 0) === 1 ? '' : 's'}
        </Badge>
        <Badge>{index?.counts.sources ?? 0} kept source{(index?.counts.sources ?? 0) === 1 ? '' : 's'}</Badge>
        {KIND_ORDER.filter((k) => (index?.counts.byKind[k] ?? 0) > 0).map((k) => (
          <Badge key={k} tone="neutral">
            {index!.counts.byKind[k]} {pageKindLabel(k).toLowerCase()}
            {index!.counts.byKind[k] === 1 ? '' : 's'}
          </Badge>
        ))}
        <span className="relative ml-auto">
          <Search className="pointer-events-none absolute top-1/2 left-2.5 size-3.5 -translate-y-1/2 text-night-500" />
          <Input value={filter} onChange={(e) => setFilter(e.target.value)} placeholder="Filter pages…" className="w-52 pl-8" aria-label="Filter wiki pages" />
        </span>
      </div>

      {index && index.pages.length === 0 && (
        <EmptyState
          icon={<BookOpenText />}
          title="The wiki is empty"
          body="Accept a proposal, save an answer, or file a source — pages land here once you review them, with their history kept revision by revision."
        />
      )}
      {groups.length === 0 && (index?.pages.length ?? 0) > 0 && <EmptyState icon={<Search />} title="Nothing matches" body="The filter runs over titles, summaries and ids — the same catalogue the teachers search." />}

      {groups.map(({ kind, rows }) => (
        <section key={kind}>
          <div className="mb-2 flex items-baseline gap-3">
            <Eyebrow>
              {KIND_META[kind].group} · {rows.length}
            </Eyebrow>
            <span className="text-[11px] text-night-500">{KIND_META[kind].hint}</span>
          </div>
          <div className="space-y-2">
            {rows.map((page, i) => (
              <WikiRow key={page.id} page={page} index={i} onOpen={() => onOpen(page.id)} />
            ))}
          </div>
        </section>
      ))}
    </div>
  );
}
