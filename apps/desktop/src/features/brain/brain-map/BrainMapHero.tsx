import type { GraphResponse, PageRecordSummary, WikiGraph } from '@sef/shared';
import { ChevronDown, Minus, Pause, Play, Plus, RotateCcw, Search, X } from 'lucide-react';
import { useEffect, useMemo, useRef, useState, type PointerEvent as ReactPointerEvent, type ReactNode } from 'react';
import { Skeleton } from '@/components/ui/primitives';
import { STATUS_STYLE } from '@/lib/brain-style';
import { cn } from '@/lib/cn';
import { markdownToPlainText } from '@/lib/markdown-text';
import { useMediaQuery } from '@/lib/use-media-query';
import { buildBrainMap, describeBrainMap, MAP_HEX, type BrainMap } from './layout';
import { BrainRenderer, type View } from './renderer';
import type { SearchResult } from './search';
import { AskModeToggle } from '../ask/AskBrainPanel';

const REPLAY_MS = 9000;
const MIN_K = 1;
const MAX_K = 7;
const monthYear = (t: number) => (t ? new Date(t).toLocaleDateString('en', { month: 'short', year: 'numeric' }) : '');
const KIND_NAME: Record<PageRecordSummary['kind'], string> = { concept: 'Concept', synthesis: 'Synthesis', question: 'Open question', source_summary: 'Source note' };

export interface SearchProps {
  /** What the student typed — echoed immediately. */
  query: string;
  onQuery: (query: string) => void;
  /** The debounced result for that query, or null when there is no query. */
  result: SearchResult | null;
  /** "Ask your brain": when on, Enter sends the query as a question and `panel` shows the answer. */
  ask?: { on: boolean; onToggle: (on: boolean) => void; onSubmit: (question: string) => void; panel: ReactNode };
}

type Tip = { index: number; x: number; y: number };

/**
 * The hero of the Brain section: the student's whole wiki as one living dendrite. See
 * layout.ts for the geometry and renderer.ts for how it stays cheap on a 1,400-page vault.
 * The page list below remains the accessible path; the canvas carries a one-line summary.
 */
export function BrainMapHero({
  records,
  graph,
  wiki,
  loading,
  onOpen,
  onScrollToList,
  search,
}: {
  search: SearchProps;
  /** True while the course graph or the wiki graph is still arriving — the layout needs both. */
  loading: boolean;
  records: PageRecordSummary[] | undefined;
  graph: GraphResponse | undefined;
  wiki: WikiGraph | undefined;
  onOpen: (pageId: string) => void;
  onScrollToList: () => void;
}) {
  const map = useMemo(() => (records && records.length && !loading ? buildBrainMap(records, graph, wiki) : null), [records, graph, wiki]);
  if (!records || loading) return <HeroFrame><Skeleton className="absolute inset-6 rounded-2xl opacity-60" /></HeroFrame>;
  if (!map) return null;
  return <BrainMapCanvas map={map} onOpen={onOpen} onScrollToList={onScrollToList} search={search} />;
}

function HeroFrame({ children, className }: { children: ReactNode; className?: string }) {
  return (
    <section
      className={cn(
        'relative h-[100dvh] min-h-[560px] overflow-hidden bg-night-950',
        className,
      )}
      style={{
        backgroundImage:
          'radial-gradient(70% 60% at 50% 55%, oklch(0.22 0.06 262 / 0.55), transparent 70%), radial-gradient(40% 35% at 85% 10%, oklch(0.3 0.08 180 / 0.18), transparent 70%), radial-gradient(45% 40% at 10% 95%, oklch(0.3 0.09 290 / 0.16), transparent 70%)',
      }}
    >
      {children}
    </section>
  );
}

function BrainMapCanvas({ map, onOpen, onScrollToList, search }: { map: BrainMap; onOpen: (pageId: string) => void; onScrollToList: () => void; search: SearchProps }) {
  const reduced = useMediaQuery('(prefers-reduced-motion: reduce)');
  const wrapRef = useRef<HTMLDivElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const rendererRef = useRef<BrainRenderer | null>(null);
  const drawRef = useRef<() => void>(() => {});
  const [tip, setTip] = useState<Tip | null>(null);
  const [zoom, setZoom] = useState(1);
  const [cutoff, setCutoff] = useState(Infinity);
  const [playing, setPlaying] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);
  const [searchOpen, setSearchOpen] = useState(false);
  const indexById = useMemo(() => new Map(map.nodes.map((n, i) => [n.id, i])), [map]);
  const drag = useRef<{ x: number; y: number; px: number; py: number; moved: boolean } | null>(null);
  const { stats } = map;

  // One renderer per map; one animation loop, paused when the hero is off screen or the tab hidden.
  useEffect(() => {
    const canvas = canvasRef.current!;
    const wrap = wrapRef.current!;
    const r = new BrainRenderer(canvas, map);
    rendererRef.current = r;
    let raf = 0;
    let onScreen = true;
    const loop = (now: number) => {
      r.frame(now, true);
      raf = requestAnimationFrame(loop);
    };
    const start = () => {
      cancelAnimationFrame(raf);
      if (reduced) raf = requestAnimationFrame((now) => r.frame(now, false));
      else if (onScreen && !document.hidden) raf = requestAnimationFrame(loop);
    };
    drawRef.current = () => {
      if (reduced || !onScreen || document.hidden) {
        cancelAnimationFrame(raf);
        raf = requestAnimationFrame((now) => r.frame(now, false));
      }
    };
    const size = () => {
      const box = wrap.getBoundingClientRect();
      r.resize(box.width, box.height, window.devicePixelRatio || 1);
      r.setKeepOut(
        [...(wrap.parentElement?.querySelectorAll('[data-keepout]') ?? [])].map((el) => {
          const b = el.getBoundingClientRect();
          return { x: b.left - box.left, y: b.top - box.top, w: b.width, h: b.height };
        }),
      );
      drawRef.current();
    };
    size();
    const ro = new ResizeObserver(size);
    ro.observe(wrap);
    const io = new IntersectionObserver(([entry]) => {
      onScreen = entry?.isIntersecting ?? true;
      start();
    });
    io.observe(wrap);
    const vis = () => start();
    document.addEventListener('visibilitychange', vis);
    // Canvas text needs the display serif loaded before the first labels are drawn.
    void document.fonts?.ready.then(() => drawRef.current());
    start();
    return () => {
      cancelAnimationFrame(raf);
      ro.disconnect();
      io.disconnect();
      document.removeEventListener('visibilitychange', vis);
      rendererRef.current = null;
    };
  }, [map, reduced]);

  // The growth replay walks the cutoff from the first page to today.
  useEffect(() => {
    rendererRef.current?.setCutoff(cutoff);
    drawRef.current();
  }, [cutoff]);
  useEffect(() => {
    if (!playing) return;
    const span = Math.max(1, stats.lastAt - stats.firstAt);
    const from = cutoff === Infinity || cutoff >= stats.lastAt ? stats.firstAt : cutoff;
    const t0 = performance.now() - ((from - stats.firstAt) / span) * REPLAY_MS;
    let raf = 0;
    const step = (now: number) => {
      const u = Math.min(1, (now - t0) / REPLAY_MS);
      const eased = u < 0.5 ? 2 * u * u : 1 - (-2 * u + 2) ** 2 / 2;
      if (u >= 1) {
        setCutoff(Infinity);
        setPlaying(false);
        return;
      }
      setCutoff(stats.firstAt + eased * span);
      raf = requestAnimationFrame(step);
    };
    raf = requestAnimationFrame(step);
    return () => cancelAnimationFrame(raf);
    // eslint-disable-next-line react-hooks/exhaustive-deps -- the start point is read once per play
  }, [playing, stats.firstAt, stats.lastAt]);

  // Search: matches stay lit, everything else dims.
  useEffect(() => {
    const r = rendererRef.current;
    if (!r) return;
    r.setHighlight(search.result ? new Set(search.result.ids.flatMap((id) => (indexById.has(id) ? [indexById.get(id)!] : []))) : null);
    drawRef.current();
  }, [search.result, indexById, map, reduced]);

  // "/" jumps to the search field from anywhere that is not already a text field.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== '/' || e.metaKey || e.ctrlKey || e.altKey) return;
      const el = e.target as HTMLElement | null;
      if (el && (el.isContentEditable || ['INPUT', 'TEXTAREA', 'SELECT'].includes(el.tagName))) return;
      e.preventDefault();
      inputRef.current?.focus();
      inputRef.current?.select();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  /** Glide the camera to a node, then open its page. */
  const focusNode = (id: string) => {
    const r = rendererRef.current;
    const i = indexById.get(id);
    if (r && i !== undefined) {
      const from = r.getView();
      const to = r.viewFor(i, Math.max(3, from.k));
      if (reduced) setView(to);
      else {
        const t0 = performance.now();
        const step = (now: number) => {
          const u = Math.min(1, (now - t0) / 650);
          const e = 1 - (1 - u) ** 3;
          setView({ k: from.k + (to.k - from.k) * e, px: from.px + (to.px - from.px) * e, py: from.py + (to.py - from.py) * e });
          if (u < 1) requestAnimationFrame(step);
        };
        requestAnimationFrame(step);
      }
    }
    setSearchOpen(false);
    onOpen(id);
  };

  const setView = (view: View) => {
    const r = rendererRef.current;
    if (!r) return;
    r.setView(view);
    setZoom(view.k);
    drawRef.current();
  };
  const zoomAt = (factor: number, mx?: number, my?: number) => {
    const r = rendererRef.current;
    const wrap = wrapRef.current;
    if (!r || !wrap) return;
    const box = wrap.getBoundingClientRect();
    const v = r.getView();
    const k = Math.max(MIN_K, Math.min(MAX_K, v.k * factor));
    if (k === MIN_K) return setView({ k, px: 0, py: 0 });
    // Keep the point under the cursor (or the centre) fixed while zooming.
    const ax = (mx ?? r.cx) - r.cx;
    const ay = (my ?? r.cy) - r.cy;
    const f = k / v.k;
    setView({ k, px: ax - (ax - v.px) * f, py: ay - (ay - v.py) * f });
  };

  // Pinch / ctrl+wheel zooms; a plain wheel keeps scrolling the page down to the list.
  useEffect(() => {
    const wrap = wrapRef.current!;
    const onWheel = (e: WheelEvent) => {
      if (!e.ctrlKey && !e.metaKey) return;
      e.preventDefault();
      const box = wrap.getBoundingClientRect();
      zoomAt(Math.exp(-e.deltaY * 0.01), e.clientX - box.left, e.clientY - box.top);
    };
    wrap.addEventListener('wheel', onWheel, { passive: false });
    return () => wrap.removeEventListener('wheel', onWheel);
    // eslint-disable-next-line react-hooks/exhaustive-deps -- zoomAt only reads refs
  }, []);

  const local = (e: ReactPointerEvent) => {
    const box = wrapRef.current!.getBoundingClientRect();
    return { x: e.clientX - box.left, y: e.clientY - box.top };
  };
  const onPointerDown = (e: ReactPointerEvent<HTMLCanvasElement>) => {
    const p = local(e);
    const v = rendererRef.current?.getView() ?? { k: 1, px: 0, py: 0 };
    drag.current = { x: p.x, y: p.y, px: v.px, py: v.py, moved: false };
    e.currentTarget.setPointerCapture(e.pointerId);
  };
  const onPointerMove = (e: ReactPointerEvent<HTMLCanvasElement>) => {
    const r = rendererRef.current;
    if (!r) return;
    const p = local(e);
    const d = drag.current;
    if (d) {
      const dx = p.x - d.x;
      const dy = p.y - d.y;
      if (Math.hypot(dx, dy) > 4) d.moved = true;
      if (d.moved && r.getView().k > 1) {
        setView({ k: r.getView().k, px: d.px + dx, py: d.py + dy });
        return;
      }
    }
    const i = r.hit(p.x, p.y);
    r.setHover(i);
    drawRef.current();
    setTip((prev) => (i < 0 ? null : prev?.index === i ? prev : { index: i, ...r.screenOf(i) }));
  };
  const onPointerUp = (e: ReactPointerEvent<HTMLCanvasElement>) => {
    const d = drag.current;
    drag.current = null;
    if (d?.moved) return;
    const i = rendererRef.current?.hit(local(e).x, local(e).y) ?? -1;
    if (i >= 0) onOpen(map.nodes[i]!.id);
  };
  const onLeave = () => {
    rendererRef.current?.setHover(-1);
    drawRef.current();
    setTip(null);
  };

  const span = Math.max(1, stats.lastAt - stats.firstAt);
  const scrub = cutoff === Infinity ? 1000 : Math.round(((cutoff - stats.firstAt) / span) * 1000);
  const shownNow = cutoff === Infinity ? stats.pages : map.nodes.filter((n) => n.updatedAt <= cutoff).length;
  const tipNode = tip ? map.nodes[tip.index] : null;
  const tipBranch = tipNode && tipNode.branch >= 0 ? map.branches[tipNode.branch] : null;

  return (
    <>
    <HeroFrame>
      <div ref={wrapRef} className="absolute inset-0">
        <canvas
          ref={canvasRef}
          role="img"
          aria-label={describeBrainMap(map)}
          className={cn('block touch-none', tip ? 'cursor-pointer' : zoom > 1 ? 'cursor-grab active:cursor-grabbing' : 'cursor-default')}
          onPointerDown={onPointerDown}
          onPointerMove={onPointerMove}
          onPointerUp={onPointerUp}
          onPointerLeave={onLeave}
          onDoubleClick={() => setView({ k: 1, px: 0, py: 0 })}
        />
      </div>

      {/* Headline */}
      <div data-keepout className="pointer-events-none absolute top-6 left-7 max-w-md">
        <div className="text-[11px] font-semibold tracking-[0.2em] text-aurora-300/80 uppercase">Your second brain</div>
        <h2 className="mt-1.5 font-display text-[40px] leading-[1.02] text-night-100">
          {cutoff === Infinity ? (
            <>
              Grown since <span className="italic text-gradient">{monthYear(stats.firstAt)}</span>
            </>
          ) : (
            <>
              As it was in <span className="italic text-gradient">{monthYear(cutoff)}</span>
            </>
          )}
        </h2>
        <div className="mt-3 flex flex-wrap items-center gap-x-3 gap-y-1 text-[12.5px] text-night-300">
          <Stat value={shownNow} label={shownNow === 1 ? 'page' : 'pages'} />
          <Dot />
          <Stat value={stats.studentLinks} label={stats.studentLinks === 1 ? 'link you made' : 'links you made'} hex={MAP_HEX.student} />
          <Dot />
          <Stat value={stats.openQuestions} label={stats.openQuestions === 1 ? 'open question' : 'open questions'} hex={MAP_HEX.question} />
        </div>
        <div className={cn('pointer-events-auto relative mt-5', search.ask?.on ? 'w-[min(480px,100%)]' : 'w-[min(380px,100%)]')}>
          <div className="glass flex h-11 items-center gap-2.5 rounded-2xl pr-2 pl-3.5 transition focus-within:border-aurora-400/40 focus-within:shadow-[0_0_0_3px_oklch(0.78_0.14_172/0.12)]">
            <Search className="size-4 shrink-0 text-night-400" aria-hidden />
            <input
              ref={inputRef}
              type="search"
              value={search.query}
              onChange={(e) => {
                search.onQuery(e.target.value);
                setSearchOpen(true);
              }}
              onFocus={() => setSearchOpen(true)}
              onBlur={() => setTimeout(() => setSearchOpen(false), 150)}
              onKeyDown={(e) => {
                if (e.key === 'Escape') {
                  e.preventDefault();
                  if (search.query) search.onQuery('');
                  else e.currentTarget.blur();
                } else if (e.key === 'Enter' && search.ask?.on) {
                  if (search.query.trim()) search.ask.onSubmit(search.query.trim());
                } else if (e.key === 'Enter' && search.result?.ids[0]) {
                  focusNode(search.result.ids[0]);
                }
              }}
              placeholder={search.ask?.on ? 'Ask your brain a question…' : 'Search your brain…'}
              aria-label={search.ask?.on ? 'Ask a question answered only from your own pages' : 'Search your pages by title, summary or claim'}
              aria-describedby="brain-search-count"
              className="h-full min-w-0 flex-1 bg-transparent text-[14px] text-night-100 placeholder:text-night-500 focus:outline-none [&::-webkit-search-cancel-button]:hidden"
            />
            {search.query ? (
              <button type="button" aria-label="Clear search" onClick={() => search.onQuery('')} className="grid size-7 cursor-pointer place-items-center rounded-lg text-night-400 hover:bg-white/[0.07] hover:text-night-100">
                <X className="size-3.5" />
              </button>
            ) : (
              <kbd className="rounded-md border border-white/10 px-1.5 py-0.5 font-sans text-[10.5px] text-night-400">/</kbd>
            )}
            {search.ask && <AskModeToggle mode={search.ask.on ? 'ask' : 'search'} onChange={(mode) => search.ask!.onToggle(mode === 'ask')} />}
          </div>
          <div id="brain-search-count" aria-live="polite" className="mt-1.5 h-4 pl-1 text-[11.5px] text-night-400">
            {search.ask?.on
              ? 'Enter asks · answered only from your own pages, with citations'
              : search.result &&
              (search.result.ids.length
                ? `${search.result.ids.length.toLocaleString('en')} of ${stats.pages.toLocaleString('en')} pages match · the list below is filtered`
                : 'No page matches')}
          </div>
          {search.ask?.on && search.ask.panel && <div className="absolute top-[4.25rem] right-0 left-0 z-20 max-h-[min(440px,52vh)] overflow-y-auto rounded-2xl bg-night-950/90 shadow-[0_20px_60px_-20px_oklch(0_0_0/0.8)] backdrop-blur-md">{search.ask.panel}</div>}
          {!search.ask?.on && searchOpen && search.result && search.result.ids.length > 0 && (
            <ul className="glass-strong absolute top-12 right-0 left-0 z-20 max-h-72 overflow-y-auto rounded-2xl p-1.5 shadow-[0_20px_60px_-20px_oklch(0_0_0/0.8)]">
              {search.result.ids.slice(0, 8).map((id) => {
                const n = map.nodes[indexById.get(id) ?? -1];
                if (!n) return null;
                const b = n.branch >= 0 ? map.branches[n.branch] : null;
                return (
                  <li key={id}>
                    <button
                      type="button"
                      onMouseDown={(e) => e.preventDefault()}
                      onClick={() => focusNode(id)}
                      className="flex w-full cursor-pointer items-center gap-3 rounded-xl px-3 py-2 text-left hover:bg-white/[0.06] focus-visible:bg-white/[0.08] focus-visible:outline-none"
                    >
                      <span className="size-2 shrink-0 rounded-full" style={{ background: n.hex, boxShadow: `0 0 8px ${n.hex}` }} />
                      <span className="min-w-0 flex-1">
                        <span className="block truncate text-[13px] text-night-100">{n.title}</span>
                        <span className="block truncate text-[11px] text-night-500">{b ? b.name : KIND_NAME[n.kind]}</span>
                      </span>
                    </button>
                  </li>
                );
              })}
              {search.result.ids.length > 8 && <li className="px-3 py-1.5 text-[11px] text-night-500">+{(search.result.ids.length - 8).toLocaleString('en')} more in the list below</li>}
            </ul>
          )}
        </div>
      </div>

      {/* Controls */}
      <div data-keepout className="absolute top-6 right-6 flex items-center gap-1.5">
        <button
          type="button"
          onClick={() => setPlaying((p) => !p)}
          className="glass inline-flex h-9 cursor-pointer items-center gap-2 rounded-full pr-4 pl-3 text-[12.5px] font-medium text-night-100 transition hover:border-aurora-400/40 hover:text-aurora-300"
        >
          {playing ? <Pause className="size-3.5" /> : <Play className="size-3.5" />}
          {playing ? 'Pause' : 'Replay your growth'}
        </button>
        <div className="glass ml-1 flex items-center rounded-full p-0.5">
          <IconButton label="Zoom out" onClick={() => zoomAt(1 / 1.6)} disabled={zoom <= MIN_K}>
            <Minus />
          </IconButton>
          <IconButton label="Zoom in" onClick={() => zoomAt(1.6)} disabled={zoom >= MAX_K}>
            <Plus />
          </IconButton>
          <IconButton label="Reset view" onClick={() => setView({ k: 1, px: 0, py: 0 })} disabled={zoom === 1}>
            <RotateCcw />
          </IconButton>
        </div>
      </div>

      {/* Legend */}
      <div data-keepout className="glass pointer-events-none absolute bottom-6 left-6 rounded-2xl px-4 py-3 text-[11px] text-night-300">
        <div className="grid grid-cols-2 gap-x-5 gap-y-1.5">
          <Swatch hex={MAP_HEX.solid} label={`${STATUS_STYLE.solid.label} · ${stats.solid}`} />
          <Swatch hex={MAP_HEX.met} label={`${STATUS_STYLE.met.label} · ${stats.met}`} />
          <Swatch hex={MAP_HEX.shaky} label={`${STATUS_STYLE.shaky.label} · ${stats.shaky}`} />
          <Swatch hex={MAP_HEX.synthesis} label={stats.syntheses ? `Synthesis · ${stats.syntheses}` : 'Synthesis'} />
          <Swatch hex={MAP_HEX.question} label="Open question" ring />
          <Swatch hex={MAP_HEX.source} label={stats.sources ? `Source · ${stats.sources}` : 'Source'} small />
          <Line hex={MAP_HEX.student} label="Your link" />
          <Line hex={MAP_HEX.peer} label="From a peer" />
          {stats.suggestedLinks > 0 && <Line hex={MAP_HEX.suggested} label="Suggested" dashed />}
        </div>
      </div>

      {/* Time scrubber */}
      <div data-keepout className="glass absolute right-6 bottom-6 flex w-[min(360px,40%)] items-center gap-3 rounded-2xl px-4 py-3">
        <span className="w-16 shrink-0 text-[11px] whitespace-nowrap text-night-400">{monthYear(stats.firstAt)}</span>
        <input
          type="range"
          min={0}
          max={1000}
          value={scrub}
          aria-label="Show your brain as it was on a date"
          aria-valuetext={cutoff === Infinity ? 'Today' : monthYear(cutoff)}
          onChange={(e) => {
            setPlaying(false);
            const v = Number(e.target.value);
            setCutoff(v >= 1000 ? Infinity : stats.firstAt + (v / 1000) * span);
          }}
          className="h-1 flex-1 cursor-pointer accent-aurora-400"
        />
        <span className="w-16 shrink-0 text-right text-[11px] whitespace-nowrap text-night-300">{cutoff === Infinity ? 'Today' : monthYear(cutoff)}</span>
      </div>


      {/* Hover card */}
      {tipNode && tip && (
        <div
          className="glass-strong pointer-events-none absolute z-10 w-72 rounded-2xl p-4 shadow-[0_20px_60px_-20px_oklch(0_0_0/0.8)]"
          style={{
            left: Math.min(tip.x + 18, (wrapRef.current?.clientWidth ?? 1000) - 300),
            top: Math.max(12, Math.min(tip.y - 20, (wrapRef.current?.clientHeight ?? 600) - 190)),
          }}
        >
          <div className="mb-2 flex items-center gap-2 text-[10.5px] font-semibold tracking-[0.14em] uppercase" style={{ color: tipNode.hex }}>
            <span className="size-2 rounded-full" style={{ background: tipNode.hex, boxShadow: `0 0 10px ${tipNode.hex}` }} />
            {KIND_NAME[tipNode.kind]}
            {tipNode.status && <span className="text-night-400">· {STATUS_STYLE[tipNode.status].label}</span>}
            {tipNode.peer && <span style={{ color: MAP_HEX.peer }}>· peer</span>}
          </div>
          <div className="font-display text-[22px] leading-tight text-night-100">{tipNode.title}</div>
          {tipNode.summary && <p className="mt-1.5 line-clamp-3 text-[12.5px] leading-5 text-night-300">{markdownToPlainText(tipNode.summary)}</p>}
          <div className="mt-3 flex flex-wrap gap-x-3 gap-y-1 text-[11px] text-night-500">
            {tipBranch && <span>{tipBranch.name}</span>}
            {tipNode.degree > 0 && <span>{tipNode.degree} link{tipNode.degree === 1 ? '' : 's'}</span>}
            {tipNode.claims > 0 && <span>{tipNode.claims} claim{tipNode.claims === 1 ? '' : 's'}</span>}
            {tipNode.openMisconceptions > 0 && <span className="text-ember-400">{tipNode.openMisconceptions} open</span>}
            {tipNode.updatedAt > 0 && <span>{monthYear(tipNode.updatedAt)}</span>}
          </div>
          <div className="mt-2 text-[10.5px] text-night-500">Click to open</div>
        </div>
      )}
    </HeroFrame>
      <button
        type="button"
        onClick={onScrollToList}
        className="glass absolute bottom-6 left-1/2 z-10 flex -translate-x-1/2 cursor-pointer items-center gap-1.5 rounded-full px-3.5 py-1.5 text-[11.5px] text-night-300 transition hover:text-night-100"
      >
        Every page, listed <ChevronDown className="size-3.5 animate-bounce motion-reduce:animate-none" />
      </button>
    </>
  );
}

function Stat({ value, label, hex }: { value: number; label: string; hex?: string }) {
  return (
    <span className="inline-flex items-baseline gap-1.5">
      <span className="font-display text-[19px] text-night-100" style={hex ? { color: hex } : undefined}>
        {value.toLocaleString('en')}
      </span>
      {label}
    </span>
  );
}
const Dot = () => <span className="text-night-600">·</span>;

function Swatch({ hex, label, ring, small }: { hex: string; label: string; ring?: boolean; small?: boolean }) {
  return (
    <span className="flex items-center gap-2">
      <span
        className={cn('shrink-0 rounded-full', small ? 'size-1.5' : 'size-2.5')}
        style={ring ? { border: `1.5px solid ${hex}`, boxShadow: `0 0 8px ${hex}` } : { background: hex, boxShadow: `0 0 8px ${hex}` }}
      />
      {label}
    </span>
  );
}
function Line({ hex, label, dashed }: { hex: string; label: string; dashed?: boolean }) {
  return (
    <span className="flex items-center gap-2">
      <span className="h-0 w-4 shrink-0" style={{ borderTop: `1.5px ${dashed ? 'dashed' : 'solid'} ${hex}`, boxShadow: dashed ? undefined : `0 0 6px ${hex}` }} />
      {label}
    </span>
  );
}
function IconButton({ label, onClick, disabled, children }: { label: string; onClick: () => void; disabled?: boolean; children: ReactNode }) {
  return (
    <button
      type="button"
      aria-label={label}
      title={label}
      onClick={onClick}
      disabled={disabled}
      className="grid size-8 cursor-pointer place-items-center rounded-full text-night-300 transition hover:bg-white/[0.07] hover:text-night-100 disabled:cursor-default disabled:opacity-35 [&_svg]:size-3.5"
    >
      {children}
    </button>
  );
}
