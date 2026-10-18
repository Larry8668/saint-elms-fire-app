import type { View } from '@/lib/nav';
import { startTour } from './tour';

const ANCHOR_WAIT_MS = 4000;
const POLL_MS = 150;

/**
 * Opens the Sky (the tour starts there) and runs the tour once its first anchor is on screen,
 * or after a few seconds regardless: a step without its anchor shows centred.
 */
export function startGuidedTour(go: (view: View) => void): void {
  go('sky');
  const started = Date.now();
  const tick = () => {
    const ready = document.querySelector('[data-tour="sky-stats"]') ?? document.querySelector('[data-tour="sky"]');
    if (ready || Date.now() - started > ANCHOR_WAIT_MS) {
      // A beat for the view's entrance animation, so the highlight lands on the settled layout.
      setTimeout(() => startTour(), 450);
      return;
    }
    setTimeout(tick, POLL_MS);
  };
  setTimeout(tick, POLL_MS);
}
