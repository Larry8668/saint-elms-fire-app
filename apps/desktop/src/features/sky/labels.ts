import { KIND_STYLE, STATUS_STYLE } from '@/lib/brain-style';
import { PERSONAL_SKY_ID, type GraphNode, type GraphResponse } from '@sef/shared';
import type { SkyLayout } from './layout';

/** Semantic zoom: what is worth reading at each scale. */
export type DetailTier = 0 | 1 | 2;
const TIER_ZOOM: [number, number] = [0.6, 1.3];
export const tierForZoom = (zoom: number): DetailTier => (zoom < TIER_ZOOM[0] ? 0 : zoom < TIER_ZOOM[1] ? 1 : 2);
/** Zoom that guarantees concept names are readable when a star is selected. */
export const READABLE_ZOOM = TIER_ZOOM[1] + 0.2;

export type LabelTone = 'semester' | 'course' | 'lesson' | 'concept' | 'shaky' | 'neighbour' | 'selected' | 'hover';

export interface LabelItem {
  id: string;
  x: number;
  y: number;
  text: string;
  sub?: string;
  tone: LabelTone;
}

export interface CourseProgress {
  lit: number;
  total: number;
  shaky: number;
}

export function courseProgress(graph: GraphResponse): Map<string, CourseProgress> {
  const map = new Map<string, CourseProgress>();
  for (const n of graph.nodes) {
    if (n.kind !== 'concept' || n.courseId === PERSONAL_SKY_ID) continue;
    const p = map.get(n.courseId) ?? { lit: 0, total: 0, shaky: 0 };
    p.total += 1;
    if (n.status !== 'unseen') p.lit += 1;
    if (n.status === 'shaky') p.shaky += 1;
    map.set(n.courseId, p);
  }
  return map;
}

const statusText = (n: GraphNode) => (n.kind === 'concept' ? STATUS_STYLE[n.status].label : KIND_STYLE[n.kind].label);

/** Picks the labels to show; later entries win so selection and hover always override tier rules. */
export function buildLabels(args: {
  graph: GraphResponse;
  layout: SkyLayout;
  tier: DetailTier;
  progress: Map<string, CourseProgress>;
  selectedId: string | null;
  hoveredId: string | null;
  showUnseen: boolean;
}): LabelItem[] {
  const { graph, layout, tier, progress, selectedId, hoveredId, showUnseen } = args;
  const out = new Map<string, LabelItem>();
  const at = (n: GraphNode, tone: LabelTone, sub?: string) => {
    const p = layout.positions.get(n.id);
    if (p) out.set(n.id, { id: n.id, x: p[0], y: p[1], text: n.label, tone, sub });
  };

  for (const s of layout.semesters) {
    out.set(`sem:${s.semesterNumber}`, { id: `sem:${s.semesterNumber}`, x: s.x + 18, y: s.top - 6, text: `Semester ${s.semesterNumber}`, tone: 'semester' });
  }
  for (const c of layout.constellations) {
    const p = progress.get(c.courseId);
    out.set(`course:${c.courseId}`, {
      id: `course:${c.courseId}`,
      x: c.bounds.minX + 18,
      y: c.bounds.maxY - 6,
      text: c.title,
      sub: c.courseId === PERSONAL_SKY_ID ? `${c.nodeIds.length} page${c.nodeIds.length === 1 ? '' : 's'}` : p ? `${p.lit} of ${p.total} lit${p.shaky ? ` · ${p.shaky} shaky` : ''}` : undefined,
      tone: 'course',
    });
  }

  // With a selection, only its neighbourhood is named; everything else is context.
  const quiet = Boolean(selectedId);
  for (const n of graph.nodes) {
    if (n.kind === 'lesson') {
      if (tier >= 1) at(n, 'lesson');
      continue;
    }
    if (n.kind === 'concept') {
      if (n.status === 'shaky') at(n, 'shaky');
      else if (tier >= 2 && !quiet && (showUnseen || n.status !== 'unseen')) at(n, 'concept');
      continue;
    }
    // Personal pages are few and pointful — name them at reading zoom.
    if (tier >= 1 && !quiet) at(n, 'concept');
  }

  if (selectedId) {
    for (const id of layout.neighbours.get(selectedId) ?? []) {
      const n = graph.nodes.find((x) => x.id === id);
      if (n) at(n, 'neighbour');
    }
    const sel = graph.nodes.find((x) => x.id === selectedId);
    if (sel) at(sel, 'selected', statusText(sel));
  }
  if (hoveredId && hoveredId !== selectedId) {
    const n = graph.nodes.find((x) => x.id === hoveredId);
    if (n) at(n, 'hover', statusText(n));
  }
  return [...out.values()];
}
