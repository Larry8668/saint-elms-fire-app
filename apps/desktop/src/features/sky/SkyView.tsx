import { PERSONAL_SKY_ID, type GraphResponse } from '@sef/shared';
import { AlertTriangle, ArrowRight, Download, Eye, EyeOff, List, Maximize2, Minus, Plus, Search, Sparkles, X } from 'lucide-react';
import { motion } from 'motion/react';
import { useCallback, useEffect, useId, useMemo, useRef, useState, type ReactNode } from 'react';
import { Button } from '@/components/ui/button';
import { Tooltip } from '@/components/ui/overlays';
import { EmptyState } from '@/components/ui/primitives';
import { SkyLoading } from './SkyLoading';
import { ConceptSheet } from '@/features/brain/ConceptSheet';
import { PlansCard } from '@/features/plans/PlansCard';
import { KIND_STYLE, LESSON_HEX, ORIGIN_STYLE, starHex, STATUS_STYLE } from '@/lib/brain-style';
import { cn } from '@/lib/cn';
import { useNav } from '@/lib/nav';
import { useGraph } from '@/lib/queries';
import { useMediaQuery } from '@/lib/use-media-query';
import { buildLabels, courseProgress, READABLE_ZOOM, tierForZoom, type DetailTier } from './labels';
import { emptyBounds, growBounds, layoutSky, type SkyLayout } from './layout';
import type { FrameRequest, Insets, MapCameraApi } from './MapCamera';
import { nextUp } from './next-up';
import { SkyCanvas } from './SkyCanvas';
import { SkyLabels } from './SkyLabels';

/** Width of the concept sheet plus its margin, so a selected star centres in the space left over. */
const SHEET_INSET = 464;
const HUD_INSETS: Insets = { top: 96, right: 24, bottom: 96, left: 330 };
/** Below md the side panels collapse, so the camera stops reserving their width. */
const HUD_INSETS_NARROW: Insets = { top: 72, right: 16, bottom: 96, left: 24 };
/** Left reserve while the left column is folded to its compact count. */
const FOLDED_LEFT_INSET = 24;
const NEIGHBOURHOOD_PAD = 70;

export function SkyView() {
  const { data: graph, isLoading, error } = useGraph();
  const { go } = useNav();

  if (isLoading) return <SkyLoading />;
  if (error) return <EmptyState icon={<Sparkles />} title="The sky is hidden" body={(error as Error).message} />;
  if (!graph || graph.nodes.length === 0) {
    return (
      <EmptyState
        icon={<Sparkles />}
        title="An empty sky, for now"
        body="Download your released courses and each one becomes a constellation. As you learn, the stars you understand light up."
        action={
          <Button variant="primary" onClick={() => go('library')}>
            <Download /> Get my courses
          </Button>
        }
      />
    );
  }
  return <SkyChart graph={graph} />;
}

function SkyChart({ graph }: { graph: GraphResponse }) {
  const { conceptKey, page, go } = useNav();
  const layout = useMemo(() => layoutSky(graph), [graph]);
  const progress = useMemo(() => courseProgress(graph), [graph]);
  const suggestions = useMemo(() => nextUp(graph), [graph]);
  const wide = useMediaQuery('(min-width: 768px)');

  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [hoveredId, setHoveredId] = useState<string | null>(null);
  const [focusCourseId, setFocusCourseId] = useState<string | null>(null);
  const [showUnseen, setShowUnseen] = useState(true);
  const [tier, setTier] = useState<DetailTier>(0);
  const [frame, setFrame] = useState<FrameRequest>(() => ({ key: 'home', bounds: layout.bounds, maxZoom: 1, instant: true }));
  const cameraRef = useRef<MapCameraApi | null>(null);
  const labelRegistry = useRef(new Map<string, HTMLDivElement>());

  const selectedNode = selectedId ? (graph.nodes.find((n) => n.id === selectedId) ?? null) : null;
  const insets = useMemo<Insets>(() => {
    const base = wide ? HUD_INSETS : HUD_INSETS_NARROW;
    // While the sheet is open the left column folds away, so its width is no longer reserved.
    return selectedNode && wide ? { ...base, left: FOLDED_LEFT_INSET, right: SHEET_INSET } : base;
  }, [wide, selectedNode]);

  const focus = useMemo(() => {
    if (selectedId) return new Set([selectedId, ...(layout.neighbours.get(selectedId) ?? [])]);
    if (focusCourseId) return new Set(layout.constellations.find((c) => c.courseId === focusCourseId)?.nodeIds ?? []);
    return null;
  }, [selectedId, focusCourseId, layout]);

  const labels = useMemo(
    () => buildLabels({ graph, layout, tier, progress, selectedId, hoveredId, showUnseen }),
    [graph, layout, tier, progress, selectedId, hoveredId, showUnseen],
  );

  const select = useCallback(
    (id: string | null) => {
      setSelectedId(id);
      if (!id) return;
      const node = graph.nodes.find((n) => n.id === id);
      const bounds = emptyBounds();
      for (const nid of [id, ...(layout.neighbours.get(id) ?? [])]) {
        const other = graph.nodes.find((n) => n.id === nid);
        const p = layout.positions.get(nid);
        // Cross-course links would zoom the map right out; they stay highlighted but off-frame.
        if (p && other && other.courseId === node?.courseId) growBounds(bounds, p, NEIGHBOURHOOD_PAD);
      }
      setFrame({ key: `select:${id}:${Date.now()}`, bounds, maxZoom: READABLE_ZOOM + 0.3 });
    },
    [graph, layout],
  );

  const focusCourse = (courseId: string | null) => {
    setSelectedId(null);
    setFocusCourseId(courseId);
    const c = courseId ? layout.constellations.find((x) => x.courseId === courseId) : null;
    setFrame({ key: `course:${courseId}:${Date.now()}`, bounds: c?.bounds ?? layout.bounds, maxZoom: c ? 1.4 : 1 });
  };

  useEffect(() => {
    if (conceptKey) select(`c:${conceptKey}`);
  }, [conceptKey, select]);

  // Stable page anchor — deep links (journal entries, future invites) name a page, not a node id.
  useEffect(() => {
    if (!page) return;
    const n = graph.nodes.find((x) => x.pageId === page);
    if (n) select(n.id);
  }, [page, graph, select]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.target as HTMLElement).closest('input, textarea')) return;
      if (e.key === 'Escape') setSelectedId(null);
      if (e.key === '=' || e.key === '+') cameraRef.current?.zoomBy(1.4);
      if (e.key === '-') cameraRef.current?.zoomBy(1 / 1.4);
      if (e.key === '0') focusCourse(null);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  });

  const onZoom = useCallback((zoom: number) => setTier((t) => (tierForZoom(zoom) === t ? t : tierForZoom(zoom))), []);
  const minZoom = useMemo(() => fitZoom(layout, insets) * 0.6, [layout, insets]);
  const sheetOpen = Boolean(selectedNode);

  return (
    <div className="sky-backdrop relative h-full overflow-hidden" style={{ cursor: hoveredId ? 'pointer' : 'grab' }}>
      <div className="absolute inset-0">
        <SkyCanvas
          graph={graph}
          layout={layout}
          selectedId={selectedId}
          focus={focus}
          showUnseen={showUnseen}
          frame={frame}
          insets={insets}
          minZoom={minZoom}
          labels={labels}
          labelRegistry={labelRegistry}
          cameraRef={cameraRef}
          onSelect={select}
          onHover={setHoveredId}
          onZoom={onZoom}
        />
      </div>
      <SkyLabels items={labels} registry={labelRegistry} />
      <div className={cn('pointer-events-none absolute inset-y-0 left-0 hidden w-[380px] bg-gradient-to-r from-[#04060d] via-[#04060d]/75 to-transparent transition-opacity duration-300 md:block', sheetOpen && 'opacity-0')} />

      <div className={cn('pointer-events-none absolute top-5 left-6 hidden w-[290px] flex-col gap-4 transition-[opacity,transform] duration-300 md:flex', sheetOpen && '-translate-x-8 opacity-0')} aria-hidden={sheetOpen}>
        <Stats graph={graph} />
        <div className={cn('flex flex-col gap-4', sheetOpen && 'invisible')}>
          <NextUp items={suggestions} selectedId={selectedId} onPick={select} />
          <PlansCard />
        </div>
      </div>
      <div className={cn('pointer-events-none absolute top-5 left-6 hidden text-[12.5px] text-night-300 transition-opacity duration-300', sheetOpen && 'opacity-100 md:block')}>
        <span className="text-[10px] font-semibold tracking-[0.2em] text-night-500 uppercase">Your second brain</span>{' '}
        <b className="text-gradient font-semibold">{graph.stats.lit}</b> of {graph.stats.courseConcepts} lit
      </div>

      <SearchBox graph={graph} className={cn('absolute top-5 w-56 transition-[right] duration-300 sm:w-72', sheetOpen ? 'right-[476px] max-md:hidden' : 'right-6')} onPick={select} />

      <div className={cn('absolute bottom-5 left-6 flex flex-col gap-3 transition-[right] duration-300', sheetOpen ? 'right-[476px] max-md:right-6' : 'right-6')}>
        <div className="flex items-end gap-3">
          <div className="flex min-w-0 flex-1 gap-2 overflow-x-auto pb-1">
            <Chip active={!focusCourseId} onClick={() => focusCourse(null)}>
              Whole sky
            </Chip>
            {layout.constellations.map((c) => (
              <Chip key={c.courseId} active={focusCourseId === c.courseId} onClick={() => focusCourse(c.courseId)}>
                {c.courseId === PERSONAL_SKY_ID ? (
                  <>✦ {c.title}</>
                ) : (
                  <>
                    <span className="text-night-500">S{c.semesterNumber}</span> {c.title}
                  </>
                )}
              </Chip>
            ))}
          </div>
          <div className="glass flex shrink-0 overflow-hidden rounded-xl">
            <IconButton label="Zoom in (+)" onClick={() => cameraRef.current?.zoomBy(1.4)}>
              <Plus />
            </IconButton>
            <IconButton label="Zoom out (−)" onClick={() => cameraRef.current?.zoomBy(1 / 1.4)}>
              <Minus />
            </IconButton>
            <IconButton label="Fit whole sky (0)" onClick={() => focusCourse(null)}>
              <Maximize2 />
            </IconButton>
            <IconButton label={showUnseen ? 'Hide unseen stars' : 'Show unseen stars'} onClick={() => setShowUnseen((v) => !v)} active={!showUnseen}>
              {showUnseen ? <Eye /> : <EyeOff />}
            </IconButton>
          </div>
        </div>
        <div className="flex flex-wrap items-center gap-x-4 gap-y-1 text-[11.5px] text-night-400">
          <Legend color={LESSON_HEX} label="Lesson" />
          {(['unseen', 'met', 'shaky', 'solid'] as const).map((s) => (
            <Legend key={s} color={STATUS_STYLE[s].hex} label={STATUS_STYLE[s].label} />
          ))}
          {(['synthesis', 'question'] as const).map((k) => (
            <Legend key={k} color={KIND_STYLE[k].hex!} label={KIND_STYLE[k].label} />
          ))}
          <span className="mx-1 h-3 w-px bg-white/10" />
          {(['student', 'suggested', 'peer'] as const).map((o) => (
            <Legend key={o} color={ORIGIN_STYLE[o].hex} label={ORIGIN_STYLE[o].label} line />
          ))}
          <span className="mx-1 h-3 w-px bg-white/10" />
          <button onClick={() => go('brain')} className="flex cursor-pointer items-center gap-1.5 text-night-300 underline decoration-white/20 underline-offset-2 transition hover:text-night-100">
            <List className="size-3.5" /> Browse your pages as a list
          </button>
          <span className="ml-auto hidden text-night-500 xl:block">Drag to pan · scroll to zoom · click a star</span>
        </div>
      </div>

      <ConceptSheet node={selectedNode} graph={graph} onSelect={select} />
    </div>
  );
}

function fitZoom(layout: SkyLayout, insets: Insets): number {
  const w = window.innerWidth - insets.left - insets.right;
  const h = window.innerHeight - insets.top - insets.bottom;
  const b = layout.bounds;
  return Math.min(w / Math.max(1, b.maxX - b.minX), h / Math.max(1, b.maxY - b.minY), 1);
}

function Stats({ graph }: { graph: GraphResponse }) {
  const { stats } = graph;
  const litPct = stats.courseConcepts ? Math.round((stats.lit / stats.courseConcepts) * 100) : 0;
  return (
    <motion.div initial={{ opacity: 0, y: -8 }} animate={{ opacity: 1, y: 0 }}>
      <div className="text-[11px] font-semibold tracking-[0.2em] text-night-400 uppercase">Your second brain</div>
      <h1 className="mt-1 font-display text-[44px] leading-none text-night-100">
        <span className="text-gradient">{stats.lit}</span> <span className="text-night-400">of {stats.courseConcepts} lit</span>
      </h1>
      <div className="mt-3 h-1 w-56 overflow-hidden rounded-full bg-white/10">
        <motion.div className="h-full rounded-full bg-gradient-to-r from-beacon-500 to-aurora-400" initial={{ width: 0 }} animate={{ width: `${litPct}%` }} transition={{ duration: 1.2 }} />
      </div>
      <div className="mt-2.5 flex gap-4 text-[12.5px] text-night-400">
        <span>
          <b className="font-semibold text-ember-300">{stats.shaky}</b> shaky
        </span>
        <span>
          <b className="font-semibold text-gold-300">{stats.solid}</b> solid
        </span>
        <span>
          <b className="font-semibold text-aurora-300">{stats.studentLinks}</b> links you made
        </span>
      </div>
      {stats.personalPages > 0 && (
        <div className="mt-1.5 text-[12px] text-night-500">
          <b className="font-semibold text-[#6fe3c1]">{stats.personalPages}</b> page{stats.personalPages === 1 ? '' : 's'} of your own
          {' · '}
          <b className="font-semibold text-night-300">{stats.demonstrated}</b> shown
          {stats.collected > 0 && (
            <>
              {' · '}
              <b className="font-semibold text-night-300">{stats.collected}</b> collected
            </>
          )}
        </div>
      )}
    </motion.div>
  );
}

function NextUp({ items, selectedId, onPick }: { items: ReturnType<typeof nextUp>; selectedId: string | null; onPick: (id: string) => void }) {
  if (!items.length) return null;
  return (
    <motion.div initial={{ opacity: 0, y: 6 }} animate={{ opacity: 1, y: 0 }} transition={{ delay: 0.15 }} className="glass pointer-events-auto rounded-2xl p-2">
      <div className="px-2.5 pt-1.5 pb-1 text-[10.5px] font-semibold tracking-[0.18em] text-night-500 uppercase">Next up</div>
      {items.map(({ node, reason }) => (
        <button
          key={node.id}
          onClick={() => onPick(node.id)}
          className={cn(
            'group flex w-full cursor-pointer items-center gap-2.5 rounded-xl px-2.5 py-2 text-left transition hover:bg-white/[0.05]',
            selectedId === node.id && 'bg-white/[0.07]',
          )}
        >
          {reason === 'shaky' ? (
            <AlertTriangle className="size-3.5 shrink-0 text-ember-400" />
          ) : (
            <span className="size-2 shrink-0 rounded-full" style={{ background: STATUS_STYLE.unseen.hex, boxShadow: `0 0 6px ${STATUS_STYLE.unseen.hex}` }} />
          )}
          <span className="min-w-0 flex-1">
            <span className="block truncate text-[13px] text-night-100">{node.label}</span>
            <span className="block truncate text-[11px] text-night-500">{reason === 'shaky' ? 'Open misconception · ' : 'Next in '}{node.courseName}</span>
          </span>
          <ArrowRight className="size-3.5 shrink-0 text-night-600 transition group-hover:translate-x-0.5 group-hover:text-night-300" />
        </button>
      ))}
    </motion.div>
  );
}

function SearchBox({ graph, className, onPick }: { graph: GraphResponse; className?: string; onPick: (id: string) => void }) {
  const [query, setQuery] = useState('');
  const [active, setActive] = useState(0);
  const [dismissed, setDismissed] = useState(false);
  const listId = useId();
  const matches = useMemo(() => {
    const q = query.trim().toLowerCase();
    return q ? graph.nodes.filter((n) => n.label.toLowerCase().includes(q)).slice(0, 8) : [];
  }, [query, graph]);
  const open = !dismissed && matches.length > 0;
  const current = Math.min(active, Math.max(0, matches.length - 1));

  const choose = (id: string) => {
    onPick(id);
    setQuery('');
    setActive(0);
  };

  return (
    <div className={className}>
      <div className="glass flex items-center gap-2 rounded-xl px-3">
        <Search className="size-4 text-night-400" />
        <input
          role="combobox"
          aria-expanded={open}
          aria-controls={listId}
          aria-activedescendant={open ? `${listId}-${matches[current]!.id}` : undefined}
          aria-label="Find a star"
          value={query}
          onChange={(e) => {
            setQuery(e.target.value);
            setActive(0);
            setDismissed(false);
          }}
          onKeyDown={(e) => {
            if (e.key === 'ArrowDown') {
              e.preventDefault();
              setDismissed(false);
              setActive((a) => Math.min(a + 1, matches.length - 1));
            } else if (e.key === 'ArrowUp') {
              e.preventDefault();
              setActive((a) => Math.max(a - 1, 0));
            } else if (e.key === 'Enter' && open) {
              e.preventDefault();
              choose(matches[current]!.id);
            } else if (e.key === 'Escape') {
              setDismissed(true);
            }
          }}
          placeholder="Find a star…"
          className="h-10 flex-1 bg-transparent text-sm text-night-100 placeholder:text-night-500 focus:outline-none"
        />
        {query && (
          <button
            onClick={() => {
              setQuery('');
              setActive(0);
            }}
            className="text-night-400 hover:text-night-100"
            aria-label="Clear"
          >
            <X className="size-4" />
          </button>
        )}
      </div>
      {open && (
        <div role="listbox" id={listId} aria-label="Matching stars" className="glass-strong mt-2 overflow-hidden rounded-xl">
          {matches.map((n, i) => (
            <button
              key={n.id}
              id={`${listId}-${n.id}`}
              role="option"
              aria-selected={i === current}
              onMouseEnter={() => setActive(i)}
              onClick={() => choose(n.id)}
              className={cn('flex w-full cursor-pointer items-center gap-2 px-3 py-2 text-left text-sm', i === current ? 'bg-white/[0.08]' : 'hover:bg-white/[0.06]')}
            >
              <span className="size-2 shrink-0 rounded-full" style={{ background: starHex(n) }} />
              <span className="flex-1 truncate text-night-100">{n.label}</span>
              <span className="shrink-0 text-[11px] text-night-500">{n.courseName}</span>
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

function Chip({ active, onClick, children }: { active: boolean; onClick: () => void; children: ReactNode }) {
  return (
    <button
      onClick={onClick}
      className={cn(
        'glass shrink-0 cursor-pointer rounded-full px-3.5 py-1.5 text-[12.5px] whitespace-nowrap transition',
        active ? 'border-beacon-400/50 bg-beacon-500/20 text-night-100' : 'text-night-300 hover:text-night-100',
      )}
    >
      {children}
    </button>
  );
}

function IconButton({ label, onClick, active, children }: { label: string; onClick: () => void; active?: boolean; children: ReactNode }) {
  return (
    <Tooltip content={label}>
      <button
        onClick={onClick}
        aria-label={label}
        className={cn('grid size-9 cursor-pointer place-items-center text-night-300 transition hover:bg-white/[0.06] hover:text-night-50 [&_svg]:size-4', active && 'text-beacon-300')}
      >
        {children}
      </button>
    </Tooltip>
  );
}

function Legend({ color, label, line }: { color: string; label: string; line?: boolean }) {
  return (
    <span className="flex items-center gap-1.5">
      <span className={line ? 'h-0.5 w-3.5 rounded-full' : 'size-2 rounded-full'} style={{ background: color, boxShadow: line ? undefined : `0 0 8px ${color}` }} />
      {label}
    </span>
  );
}
