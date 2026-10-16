import type { ConceptStatus, EdgeOrigin, GraphNode, SkyNodeKind } from '@sef/shared';

/** One source of truth for how statuses and link origins look, in 2D and in the sky. */
export const STATUS_STYLE: Record<ConceptStatus, { label: string; tone: 'neutral' | 'beacon' | 'ember' | 'gold' | 'aurora'; hex: string; blurb: string }> = {
  unseen: { label: 'Unseen', tone: 'neutral', hex: '#5d6a8a', blurb: 'In your courses, not yet in your brain' },
  met: { label: 'Met', tone: 'beacon', hex: '#7fb2ff', blurb: 'You have engaged with it' },
  shaky: { label: 'Shaky', tone: 'ember', hex: '#ffb057', blurb: 'An open misconception or a failed check' },
  solid: { label: 'Solid', tone: 'gold', hex: '#ffe08a', blurb: 'Two different passed checks, nothing open — a signal, not a certificate' },
};

export const ORIGIN_STYLE: Record<EdgeOrigin, { label: string; hex: string; opacity: number }> = {
  course: { label: 'Course link', hex: '#6f86c2', opacity: 0.14 },
  student: { label: 'Your link', hex: '#5ff0d0', opacity: 0.9 },
  peer: { label: 'From a peer', hex: '#b8a1ff', opacity: 0.75 },
  suggested: { label: 'Suggested', hex: '#9fb6e8', opacity: 0.45 },
};

export const LESSON_HEX = '#c7b8ff';

/**
 * Personal-sky node shapes and colours. Concepts keep their status colour; syntheses and
 * questions are fixed hues with their own point shapes so the eye can tell a page you wove
 * together from one that is still open.
 */
export const KIND_STYLE: Record<SkyNodeKind, { label: string; hex?: string }> = {
  lesson: { label: 'Lesson', hex: LESSON_HEX },
  concept: { label: 'Concept' },
  synthesis: { label: 'Synthesis', hex: '#6fe3c1' },
  question: { label: 'Open question', hex: '#ff9fb0' },
};

/** The halo rim a personal node carries — whose work the page is, never what the status is. */
export const NODE_ORIGIN_RIM: Record<Exclude<GraphNode['origin'], 'course'>, { label: string; hex: string }> = {
  student: { label: 'Your page', hex: '#5ff0d0' },
  peer: { label: 'Built from a peer share', hex: '#b8a1ff' },
};

/** A course node's rim is invisible — the rim only ever marks personal pages. */
export const rimFor = (node: GraphNode): string => (node.origin === 'course' ? starHex(node) : NODE_ORIGIN_RIM[node.origin].hex);

/** Fill colour for a star point: kind for personal shapes, status for concepts. */
export function starHex(node: GraphNode): string {
  if (node.kind === 'lesson') return LESSON_HEX;
  if (node.kind === 'synthesis') return KIND_STYLE.synthesis.hex!;
  if (node.kind === 'question') return KIND_STYLE.question.hex!;
  return STATUS_STYLE[node.status].hex;
}

/** Point-sprite silhouettes: 0 disc (lessons, concepts), 1 diamond (synthesis), 2 square (question). */
export const nodeShape = (node: GraphNode): number => (node.kind === 'synthesis' ? 1 : node.kind === 'question' ? 2 : 0);
