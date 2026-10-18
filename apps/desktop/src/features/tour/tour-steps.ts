/**
 * The guided tour over the real UI. Each step points at a `data-tour` anchor; a step whose
 * anchor is not on screen (another view, a narrow window) shows centred instead. The steps
 * only explain: the tour never navigates and the highlighted element cannot be clicked.
 */
export interface TourStep {
  /** `data-tour` anchors to try in order; the first visible one is highlighted. None: a centred step. */
  anchors: string[];
  title: string;
  description: string;
  side?: 'top' | 'right' | 'bottom' | 'left';
}

export const TOUR_STEPS: TourStep[] = [
  {
    anchors: ['sky-stats', 'sky'],
    title: 'The Sky',
    description: 'Your second brain: every released concept is a star; lit stars are what you’ve met, amber ones are shaky.',
    side: 'right',
  },
  {
    anchors: ['next-up'],
    title: 'Next up',
    description: 'What to look at next: an open misconception first, then the next concept in each course. Click one later to fly to its star.',
    side: 'right',
  },
  {
    anchors: ['nav-teachers'],
    title: 'Teachers',
    description: 'Three minds: Friend for campus life, Guide strictly from your lessons, Philosopher beyond the syllabus.',
    side: 'right',
  },
  {
    anchors: ['nav-contribute'],
    title: 'Add to my wiki',
    description: 'Drop a note, PDF, photo of notes, voice memo or a lecture video: Gemma reads it and proposes pages.',
    side: 'right',
  },
  {
    anchors: ['nav-brain'],
    title: 'Brain',
    description: 'Your pages, written in your voice from what you actually showed, plus the open questions. The model only proposes; a validator decides what gets written.',
    side: 'right',
  },
  {
    anchors: ['nav-library'],
    title: 'Library',
    description: 'Courses your university released, as signed packages verified before they install. Then everything works offline.',
    side: 'right',
  },
  {
    anchors: ['nav-peers'],
    title: 'Peers',
    description: 'Publish a page to your cohort, or import a classmate’s share. Imports land in your review queue, never straight in your brain.',
    side: 'right',
  },
  {
    anchors: [],
    title: 'Ask the Guide',
    description: 'Open Teachers, pick the Guide and ask about anything in your lessons. It answers only from what you have been taught, and shows where.',
  },
];

export const TOUR_MAX_STEPS = 8;

/** The first anchor that is laid out on screen, else null. */
export function firstVisibleAnchor(anchors: readonly string[], find: (anchor: string) => Element | null): Element | null {
  for (const anchor of anchors) {
    const el = find(anchor);
    if (el && el.getClientRects().length > 0) return el;
  }
  return null;
}
