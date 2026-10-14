import type { GraphResponse } from '@sef/shared';
import { AlertTriangle, ArrowRight, Download, Eye, EyeOff, Maximize2, Minus, Plus, Search, Sparkles, X } from 'lucide-react';
import { motion } from 'motion/react';
import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { Button } from '@/components/ui/button';
import { Tooltip } from '@/components/ui/overlays';
import { EmptyState } from '@/components/ui/primitives';
import { SkyLoading } from './SkyLoading';
import { ConceptSheet } from '@/features/brain/ConceptSheet';
import { LESSON_HEX, ORIGIN_STYLE, STATUS_STYLE } from '@/lib/brain-style';
import { cn } from '@/lib/cn';
import { useNav } from '@/lib/nav';
import { useGraph } from '@/lib/queries';
import { buildLabels, courseProgress, READABLE_ZOOM, tierForZoom, type DetailTier } from './labels';
import { emptyBounds, growBounds, layoutSky, type SkyLayout } from './layout';
import type { FrameRequest, Insets, MapCameraApi } from './MapCamera';
import { nextUp } from './next-up';
import { SkyCanvas } from './SkyCanvas';
import { SkyLabels } from './SkyLabels';

/** Width of the concept sheet plus its margin, so a selected star centres in the space left over. */
const SHEET_INSET = 464;
const HUD_INSETS: Insets = { top: 96, right: 24, bottom: 96, left: 330 };
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
  const { conceptKey } = useNav();
  const layout = useMemo(() => layoutSky(graph), [graph]);
  const progress = useMemo(() => courseProgress(graph), [graph]);
  const suggestions = useMemo(() => nextUp(graph), [graph]);

  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [hoveredId, setHoveredId] = useState<string | null>(null);
  const [focusCourseId, setFocusCourseId] = useState<string | null>(null);
  const [showUnseen, setShowUnseen] = useState(true);
  const [tier, setTier] = useState<DetailTier>(0);
  const [frame, setFrame] = useState<FrameRequest>(() => ({ key: 'home', bounds: layout.bounds, maxZoom: 1, instant: true }));
  const cameraRef = useRef<MapCameraApi | null>(null);
  const labelRegistry = useRef(new Map<string, HTMLDivElement>());

  const selectedNode = selectedId ? (graph.nodes.find((n) => n.id === selectedId) ?? null) : null;
  const insets = useMemo<Insets>(() => ({ ...HUD_INSETS, right: selectedNode ? SHEET_INSET : HUD_INSETS.right }), [selectedNode]);

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
  const minZoom = useMemo(() => fitZoom(layout) * 0.6, [layout]);
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
      <div className="pointer-events-none absolute inset-y-0 left-0 w-[380px] bg-gradient-to-r from-[#04060d] via-[#04060d]/75 to-transparent" />

      <div className="pointer-events-none absolute top-5 left-6 flex w-[290px] flex-col gap-4">
        <Stats graph={graph} />
        <NextUp items={suggestions} selectedId={selectedId} onPick={select} />
      </div>

      <SearchBox graph={graph} className={cn('absolute top-5 w-72 transition-[right] duration-300', sheetOpen ? 'right-[476px]' : 'right-6')} onPick={select} />

      <div className={cn('absolute bottom-5 left-6 flex flex-col gap-3 transition-[right] duration-300', sheetOpen ? 'right-[476px]' : 'right-6')}>
        <div className="flex items-end gap-3">
          <div className="flex min-w-0 flex-1 gap-2 overflow-x-auto pb-1">
            <Chip active={!focusCourseId} onClick={() => focusCourse(null)}>
              Whole sky
            </Chip>
            {layout.constellations.map((c) => (
              <Chip key={c.courseId} active={focusCourseId === c.courseId} onClick={() => focusCourse(c.courseId)}>
                <span className="text-night-500">S{c.semesterNumber}</span> {c.title}
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
          <span className="mx-1 h-3 w-px bg-white/10" />
          {(['student', 'suggested', 'peer'] as const).map((o) => (
            <Legend key={o} color={ORIGIN_STYLE[o].hex} label={ORIGIN_STYLE[o].label} line />
          ))}
          <span className="ml-auto hidden text-night-500 xl:block">Drag to pan · scroll to zoom · click a star</span>
        </div>
      </div>

      <ConceptSheet node={selectedNode} graph={graph} onSelect={select} />
    </div>
  );
}

function fitZoom(layout: SkyLayout): number {
  const w = window.innerWidth - HUD_INSETS.left - HUD_INSETS.right;
  const h = window.innerHeight - HUD_INSETS.top - HUD_INSETS.bottom;
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
  const matches = useMemo(() => {
    const q = query.trim().toLowerCase();
    return q ? graph.nodes.filter((n) => n.label.toLowerCase().includes(q)).slice(0, 8) : [];
  }, [query, graph]);

  return (
    <div className={className}>
      <div className="glass flex items-center gap-2 rounded-xl px-3">
        <Search className="size-4 text-night-400" />
        <input
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && matches[0]) {
              onPick(matches[0].id);
              setQuery('');
            }
          }}
          placeholder="Find a star…"
          className="h-10 flex-1 bg-transparent text-sm text-night-100 placeholder:text-night-500 focus:outline-none"
        />
        {query && (
          <button onClick={() => setQuery('')} className="text-night-400 hover:text-night-100" aria-label="Clear">
            <X className="size-4" />
          </button>
        )}
      </div>
      {matches.length > 0 && (
        <div className="glass-strong mt-2 overflow-hidden rounded-xl">
          {matches.map((n) => (
            <button
              key={n.id}
              onClick={() => {
                onPick(n.id);
                setQuery('');
              }}
              className="flex w-full cursor-pointer items-center gap-2 px-3 py-2 text-left text-sm hover:bg-white/[0.06]"
            >
              <span className="size-2 shrink-0 rounded-full" style={{ background: n.kind === 'lesson' ? LESSON_HEX : STATUS_STYLE[n.status].hex }} />
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
