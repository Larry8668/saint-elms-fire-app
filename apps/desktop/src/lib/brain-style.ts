import type { ConceptStatus, EdgeOrigin } from '@sef/shared';

/** One source of truth for how statuses and link origins look, in 2D and in the sky. */
export const STATUS_STYLE: Record<ConceptStatus, { label: string; tone: 'neutral' | 'beacon' | 'ember' | 'gold'; hex: string; blurb: string }> = {
  unseen: { label: 'Unseen', tone: 'neutral', hex: '#5d6a8a', blurb: 'In your courses, not yet in your brain' },
  met: { label: 'Met', tone: 'beacon', hex: '#7fb2ff', blurb: 'You have engaged with it' },
  shaky: { label: 'Shaky', tone: 'ember', hex: '#ffb057', blurb: 'An open misconception or a failed check' },
  solid: { label: 'Solid', tone: 'gold', hex: '#ffe08a', blurb: 'Two passed checks, nothing open' },
};

export const ORIGIN_STYLE: Record<EdgeOrigin, { label: string; hex: string; opacity: number }> = {
  course: { label: 'Course link', hex: '#6f86c2', opacity: 0.14 },
  student: { label: 'Your link', hex: '#5ff0d0', opacity: 0.9 },
  peer: { label: 'From a peer', hex: '#b8a1ff', opacity: 0.75 },
  suggested: { label: 'Suggested', hex: '#9fb6e8', opacity: 0.45 },
};

export const LESSON_HEX = '#c7b8ff';
