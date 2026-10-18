import { AlertTriangle, ArrowUpRight, Sparkles, X } from 'lucide-react';
import { AnimatePresence, motion, useReducedMotion } from 'motion/react';
import { useMemo, useState } from 'react';
import type { SourceDetail } from '@sef/shared';
import { Eyebrow, SkeletonText } from '@/components/ui/primitives';
import { SourceImage, SourceMedia } from '@/features/brain/SourceDetail';
import { usePageRecord, useSourceDetail } from '@/lib/queries';
import { shortDate } from '@/lib/time';
import { ModalityMark } from './modality';
import { claimSourceIds, modalityOf, readingOf, sourceNumbers } from './story';

type ClaimLike = { id: string; citations: readonly { sourceId: string }[] };

/**
 * "Built from": one chip per source the page rests on — what kind of material it was, when
 * it was kept, and how its text was produced (a Gemma vision, audio or video read, a PDF's
 * text layer, or typed). A chip opens the original beside its extraction, so the raw source
 * and what the compiler read from it sit next to each other.
 *
 * `active` is optionally controlled so the page can highlight the claims that source backs.
 */
export function Provenance({
  sourceIds,
  missingSourceIds = [],
  claims = [],
  active: controlled,
  onActiveChange,
  onOpenSource,
}: {
  sourceIds: readonly string[];
  missingSourceIds?: readonly string[];
  claims?: readonly ClaimLike[];
  active?: string | null;
  onActiveChange?: (sourceId: string | null) => void;
  onOpenSource?: (sourceId: string) => void;
}) {
  const [own, setOwn] = useState<string | null>(null);
  const active = controlled !== undefined ? controlled : own;
  const setActive = (id: string | null) => (onActiveChange ? onActiveChange(id) : setOwn(id));
  const ids = useMemo(() => [...new Set(sourceIds)].filter((id) => !missingSourceIds.includes(id)), [sourceIds, missingSourceIds]);
  const numbers = useMemo(() => sourceNumbers(ids), [ids]);
  const backs = useMemo(() => {
    const counts = new Map<string, number>();
    for (const claim of claims) for (const id of claimSourceIds(claim)) counts.set(id, (counts.get(id) ?? 0) + 1);
    return counts;
  }, [claims]);
  const reduced = useReducedMotion();

  if (!ids.length && !missingSourceIds.length) return null;
  return (
    <section aria-label="Built from">
      <Eyebrow className="mb-2">
        Built from · {ids.length + missingSourceIds.length} source{ids.length + missingSourceIds.length === 1 ? '' : 's'}
      </Eyebrow>
      <div className="flex flex-wrap gap-1.5">
        {ids.map((id) => (
          <SourceChip key={id} sourceId={id} number={numbers.get(id)!} backs={backs.get(id) ?? 0} active={active === id} onToggle={() => setActive(active === id ? null : id)} />
        ))}
        {missingSourceIds.map((id) => (
          <span key={id} className="inline-flex items-center gap-1.5 rounded-full border border-ember-400/25 bg-ember-500/10 px-2.5 py-1 text-[11.5px] text-ember-300">
            <AlertTriangle className="size-3" /> {id} — record gone
          </span>
        ))}
      </div>
      <AnimatePresence initial={false}>
        {active && ids.includes(active) && (
          <motion.div
            key={active}
            initial={reduced ? false : { opacity: 0, height: 0 }}
            animate={{ opacity: 1, height: 'auto' }}
            exit={reduced ? { opacity: 0, transition: { duration: 0 } } : { opacity: 0, height: 0 }}
            transition={{ duration: reduced ? 0 : 0.22 }}
            className="overflow-hidden"
          >
            <OriginalBeside sourceId={active} number={numbers.get(active)!} onClose={() => setActive(null)} onOpenSource={onOpenSource} />
          </motion.div>
        )}
      </AnimatePresence>
    </section>
  );
}

function SourceChip({ sourceId, number, backs, active, onToggle }: { sourceId: string; number: number; backs: number; active: boolean; onToggle: () => void }) {
  const detail = useSourceDetail(sourceId);
  const record = detail.data?.record;
  const modality = modalityOf(record ?? null);
  const reading = record ? readingOf(record.extractions) : null;
  return (
    <button
      type="button"
      onClick={onToggle}
      aria-expanded={active}
      className={`group inline-flex max-w-full cursor-pointer items-center gap-2 rounded-2xl border py-1 pr-3 pl-1 text-left transition ${
        active ? 'border-aurora-400/45 bg-aurora-500/[0.08] shadow-[0_0_18px_-6px] shadow-aurora-400/60' : 'border-white/[0.08] bg-white/[0.03] hover:border-white/[0.18]'
      }`}
    >
      <span className="relative">
        <ModalityMark modality={modality} className="size-7" />
        <span className="absolute -top-1 -right-1 grid size-3.5 place-items-center rounded-full bg-night-900 text-[8.5px] font-semibold text-night-200 ring-1 ring-white/15">{number}</span>
      </span>
      <span className="min-w-0">
        <span className="block max-w-[15rem] truncate text-[12px] text-night-100">{record?.title ?? (detail.isError ? sourceId : '…')}</span>
        <span className="flex items-center gap-1 text-[10.5px] text-night-500">
          {record && shortDate(record.createdAt)}
          {reading && (
            <>
              <span aria-hidden>·</span>
              <span className={reading.byModel ? 'inline-flex items-center gap-0.5 text-aurora-300' : ''}>
                {reading.byModel && <Sparkles className="size-2.5" />}
                {reading.label}
              </span>
            </>
          )}
          {backs > 0 && (
            <>
              <span aria-hidden>·</span>
              {backs} claim{backs === 1 ? '' : 's'}
            </>
          )}
        </span>
      </span>
    </button>
  );
}

/** The original on the left, what was read from it on the right. */
function OriginalBeside({ sourceId, number, onClose, onOpenSource }: { sourceId: string; number: number; onClose: () => void; onOpenSource?: (id: string) => void }) {
  const detail = useSourceDetail(sourceId);
  const data = detail.data;
  return (
    <div className="mt-2.5 rounded-2xl border border-white/[0.08] bg-black/25 p-3.5">
      <div className="mb-2.5 flex items-center justify-between gap-2">
        <span className="text-[12px] text-night-300">
          Source {number}
          {data ? ` · ${data.record.title}` : ''}
        </span>
        <div className="flex items-center gap-1">
          {onOpenSource && (
            <button type="button" onClick={() => onOpenSource(sourceId)} className="inline-flex cursor-pointer items-center gap-1 rounded-lg px-2 py-1 text-[11.5px] text-beacon-300 hover:bg-white/[0.06] hover:text-beacon-200">
              Full source <ArrowUpRight className="size-3" />
            </button>
          )}
          <button type="button" onClick={onClose} aria-label="Close source" className="cursor-pointer rounded-lg p-1 text-night-400 hover:bg-white/[0.06] hover:text-night-100">
            <X className="size-3.5" />
          </button>
        </div>
      </div>
      {detail.isLoading && <SkeletonText lines={4} />}
      {detail.isError && <p className="text-[12.5px] text-night-400">That source could not be opened — it may be erased or not yours.</p>}
      {data && <Beside detail={data} />}
    </div>
  );
}

function Beside({ detail }: { detail: SourceDetail }) {
  const { record, extraction } = detail;
  const reading = readingOf(record.extractions);
  const media = record.mediaType.toLowerCase();
  const visual = record.kind === 'image';
  const playable = record.kind === 'audio' || record.kind === 'video';
  const text = extraction?.text ?? '';
  return (
    <div className="grid gap-3 md:grid-cols-2">
      <div className="min-w-0">
        <div className="mb-1.5 text-[10.5px] font-semibold tracking-[0.14em] text-night-500 uppercase">The original · kept byte-for-byte</div>
        {visual && <SourceImage sourceId={record.id} title={record.title} />}
        {playable && <SourceMedia sourceId={record.id} title={record.title} video={media.startsWith('video/')} />}
        {!visual && !playable && (
          <blockquote className="max-h-48 overflow-y-auto rounded-xl border-l-2 border-beacon-400/40 bg-white/[0.02] px-3 py-2 font-display text-[15px] leading-6 whitespace-pre-wrap text-night-200">
            {text ? excerpt(text) : `${record.mediaType} · nothing readable to preview`}
          </blockquote>
        )}
        {record.attribution.creator && <p className="mt-1.5 text-[11px] text-night-500">By {record.attribution.creator}</p>}
      </div>
      <div className="min-w-0">
        <div className="mb-1.5 flex items-center gap-1 text-[10.5px] font-semibold tracking-[0.14em] uppercase">
          {reading.byModel ? (
            <span className="inline-flex items-center gap-1 text-aurora-300">
              <Sparkles className="size-3" /> What Gemma read · {reading.method}
            </span>
          ) : (
            <span className="text-night-500">What the compiler read · {reading.method ?? 'nothing yet'}</span>
          )}
          {reading.corrected && <span className="text-night-500">· corrected by you</span>}
        </div>
        {extraction?.note && <p className="mb-1.5 text-[11.5px] text-ember-300">{extraction.note}</p>}
        {text ? (
          <pre className="max-h-48 overflow-y-auto rounded-xl bg-white/[0.03] p-3 font-sans text-[12.5px] leading-5 whitespace-pre-wrap text-night-300">{text}</pre>
        ) : (
          <p className="rounded-xl border border-dashed border-white/[0.1] p-3 text-[12.5px] text-night-400">
            {detail.job?.stage === 'reading' ? 'Gemma is still reading it.' : 'Nothing read from it yet — the original is kept all the same.'}
          </p>
        )}
      </div>
    </div>
  );
}

const excerpt = (text: string) => (text.length > 700 ? `${text.slice(0, 700).trimEnd()}…` : text);

/**
 * The numbered marks a claim carries: which of the page's sources it came from. Clicking a
 * mark opens that source in the "Built from" row.
 */
export function CitationMarks({ claim, numbers, active, onSelect }: { claim: ClaimLike; numbers: Map<string, number>; active?: string | null; onSelect?: (sourceId: string) => void }) {
  const ids = claimSourceIds(claim).filter((id) => numbers.has(id));
  if (!ids.length) return null;
  return (
    <span className="inline-flex flex-wrap items-center gap-1">
      <span className="text-[10.5px] text-night-500">from</span>
      {ids.map((id) => (
        <CitationMark key={id} sourceId={id} number={numbers.get(id)!} active={active === id} onSelect={onSelect} />
      ))}
    </span>
  );
}

function CitationMark({ sourceId, number, active, onSelect }: { sourceId: string; number: number; active: boolean; onSelect?: (id: string) => void }) {
  const record = useSourceDetail(sourceId).data?.record;
  const modality = modalityOf(record ?? null);
  return (
    <button
      type="button"
      onClick={() => onSelect?.(sourceId)}
      title={record ? `${record.title} · ${readingOf(record.extractions).label}` : sourceId}
      className={`inline-flex cursor-pointer items-center gap-1 rounded-full border px-1 py-px pr-1.5 text-[10.5px] transition ${
        active ? 'border-aurora-400/50 bg-aurora-500/15 text-aurora-200' : 'border-white/[0.08] bg-white/[0.03] text-night-300 hover:border-white/[0.2]'
      }`}
    >
      <ModalityMark modality={modality} className="size-4 border-0 bg-transparent" iconClassName="size-2.5" />
      {number}
      {record && <span className="max-w-[9rem] truncate text-night-400">{record.title}</span>}
    </button>
  );
}

/** "Built from" for a page known only by id — reads its record and renders the chips. */
export function PageProvenance({ pageId }: { pageId: string }) {
  const record = usePageRecord(pageId).data;
  const sourceIds = useMemo(
    () => (record ? [...new Set([...record.sourceIds, ...record.claims.flatMap((c) => c.citations.map((x) => x.sourceId)), ...record.links.flatMap((l) => l.citations.map((x) => x.sourceId))])] : []),
    [record],
  );
  if (!record) return null;
  return <Provenance sourceIds={sourceIds} claims={record.claims} />;
}
