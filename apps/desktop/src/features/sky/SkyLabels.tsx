import { useFrame, useThree } from '@react-three/fiber';
import { useRef, type RefObject } from 'react';
import type { OrthographicCamera } from 'three';
import { cn } from '@/lib/cn';
import type { LabelItem, LabelTone } from './labels';

export type LabelRegistry = RefObject<Map<string, HTMLDivElement>>;

const OFFSCREEN_MARGIN = 120;

const TONE_CLASS: Record<LabelTone, string> = {
  semester: '-translate-y-[calc(100%+52px)] text-[11px] font-semibold tracking-[0.22em] uppercase text-night-500',
  course: '-translate-y-full',
  lesson: '-translate-x-1/2 translate-y-3 text-[11.5px] font-medium text-[#cdbfff]/90',
  concept: '-translate-x-1/2 translate-y-2.5 text-[10.5px] text-night-300/80',
  shaky: '-translate-x-1/2 translate-y-2.5 text-[11px] font-medium text-ember-300',
  neighbour: '-translate-x-1/2 translate-y-2.5 text-[11px] text-night-100',
  selected: '-translate-x-1/2 -translate-y-[calc(100%+14px)] glass-strong rounded-lg px-2.5 py-1 text-[12.5px] font-medium text-night-50 shadow-lg',
  hover: '-translate-x-1/2 -translate-y-[calc(100%+14px)] glass-strong rounded-lg px-2.5 py-1 text-[12px] font-medium text-night-100 shadow-lg',
};

/** Plain DOM labels, positioned every frame by <LabelProjector>. No per-label React roots. */
export function SkyLabels({ items, registry }: { items: LabelItem[]; registry: LabelRegistry }) {
  return (
    <div className="pointer-events-none absolute inset-0 overflow-hidden select-none">
      {items.map((item) => (
        <div
          key={item.id}
          ref={(el) => {
            if (el) registry.current.set(item.id, el);
            else registry.current.delete(item.id);
          }}
          className="absolute top-0 left-0 will-change-transform"
          style={{ visibility: 'hidden' }}
        >
          <div className={cn('whitespace-nowrap [text-shadow:0_1px_8px_#000]', TONE_CLASS[item.tone], item.tone === 'selected' || item.tone === 'hover' ? '[text-shadow:none]' : '')}>
            {item.tone === 'course' ? (
              <>
                <div className="overflow-hidden font-display text-[22px] leading-none text-ellipsis text-night-100/90 italic" title={item.text}>
                  {item.text}
                </div>
                {item.sub && <div className="mt-1 text-[11px] text-night-400">{item.sub}</div>}
              </>
            ) : (
              <>
                {item.text}
                {item.sub && <span className="ml-2 text-[10.5px] font-normal text-night-400">{item.sub}</span>}
              </>
            )}
          </div>
        </div>
      ))}
    </div>
  );
}

/** Lower wins when labels collide. Selection, hover and headings are never dropped. */
const PRIORITY: Record<LabelTone, number> = { selected: 0, hover: 0, semester: 1, course: 1, neighbour: 2, shaky: 3, lesson: 4, concept: 5 };
const ALWAYS_SHOWN = new Set<LabelTone>(['selected', 'hover', 'semester', 'course']);
const LABEL_GAP_PX = 3;
/** Semester headings sit this far above the first course title in their column (matches TONE_CLASS). */
const SEMESTER_LIFT_PX = 52;

interface Rect {
  x0: number;
  y0: number;
  x1: number;
  y1: number;
}

/** Approximates where a label's box lands relative to its anchor, mirroring TONE_CLASS offsets. */
function labelRect(tone: LabelTone, sx: number, sy: number, w: number, h: number): Rect {
  if (tone === 'semester') return { x0: sx, y0: sy - SEMESTER_LIFT_PX - h, x1: sx + w, y1: sy - SEMESTER_LIFT_PX };
  if (tone === 'course') return { x0: sx, y0: sy - h, x1: sx + w, y1: sy };
  if (tone === 'selected' || tone === 'hover') return { x0: sx - w / 2, y0: sy - 14 - h, x1: sx + w / 2, y1: sy - 14 };
  return { x0: sx - w / 2, y0: sy + 10, x1: sx + w / 2, y1: sy + 10 + h };
}

const overlaps = (a: Rect, b: Rect) => a.x0 < b.x1 + LABEL_GAP_PX && b.x0 < a.x1 + LABEL_GAP_PX && a.y0 < b.y1 + LABEL_GAP_PX && b.y0 < a.y1 + LABEL_GAP_PX;

/**
 * Lives inside the Canvas: projects label anchors to screen space when the camera or items change,
 * and drops lower-priority labels that would overlap ones already placed.
 */
export function LabelProjector({ items, registry }: { items: LabelItem[]; registry: LabelRegistry }) {
  const { camera, size } = useThree();
  const last = useRef({ x: NaN, y: NaN, zoom: NaN, w: 0, h: 0, items: null as LabelItem[] | null });
  const sizes = useRef(new Map<string, { w: number; h: number }>());
  const ordered = useRef<LabelItem[]>([]);

  useFrame(() => {
    const cam = camera as OrthographicCamera;
    const l = last.current;
    if (l.x === cam.position.x && l.y === cam.position.y && l.zoom === cam.zoom && l.w === size.width && l.h === size.height && l.items === items) return;
    if (l.items !== items) {
      sizes.current.clear();
      ordered.current = [...items].sort((a, b) => PRIORITY[a.tone] - PRIORITY[b.tone]);
    }
    Object.assign(l, { x: cam.position.x, y: cam.position.y, zoom: cam.zoom, w: size.width, h: size.height, items });

    const placed: Rect[] = [];
    for (const item of ordered.current) {
      const el = registry.current.get(item.id);
      if (!el) continue;
      const sx = (item.x - cam.position.x) * cam.zoom + size.width / 2;
      const sy = size.height / 2 - (item.y - cam.position.y) * cam.zoom;
      let visible = sx > -OFFSCREEN_MARGIN && sx < size.width + OFFSCREEN_MARGIN && sy > -OFFSCREEN_MARGIN && sy < size.height + OFFSCREEN_MARGIN;
      if (visible) {
        const inner = el.firstElementChild as HTMLElement | null;
        let box = sizes.current.get(item.id);
        if (!box) {
          // Measure the natural size once, unclipped; the clip below depends on zoom.
          if (inner && item.maxWidth !== undefined) inner.style.maxWidth = 'none';
          box = { w: inner?.offsetWidth ?? 0, h: inner?.offsetHeight ?? 0 };
          sizes.current.set(item.id, box);
        }
        let w = box.w;
        if (inner && item.maxWidth !== undefined) {
          // Column titles never run into the next column: clip them to the column's screen width.
          const limit = Math.max(40, item.maxWidth * cam.zoom);
          inner.style.maxWidth = `${limit.toFixed(0)}px`;
          w = Math.min(w, limit);
        }
        const rect = labelRect(item.tone, sx, sy, w, box.h);
        if (!ALWAYS_SHOWN.has(item.tone) && placed.some((p) => overlaps(p, rect))) visible = false;
        else placed.push(rect);
      }
      el.style.visibility = visible ? 'visible' : 'hidden';
      if (visible) el.style.transform = `translate3d(${sx.toFixed(1)}px, ${sy.toFixed(1)}px, 0)`;
    }
  });

  return null;
}
