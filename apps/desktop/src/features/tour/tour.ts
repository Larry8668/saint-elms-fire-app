import { driver, type Driver } from 'driver.js';
import 'driver.js/dist/driver.css';
import { capture } from '@/lib/analytics';
import { log } from '@/lib/log';
import { markTourDone } from './tour-state';
import { firstVisibleAnchor, TOUR_STEPS } from './tour-steps';

let active: Driver | null = null;

const findAnchor = (anchor: string) => document.querySelector(`[data-tour="${anchor}"]`);

/**
 * Runs the guided tour over whatever is on screen. Next/Back/Done, Esc closes; the highlighted
 * element cannot be clicked, so a step on a nav item never navigates. Finishing or closing it
 * is remembered, so it is not offered by itself again.
 */
export function startTour(hooks: { account?: string | null; onStart?: () => void; onComplete?: () => void } = {}): void {
  if (active?.isActive()) return;
  let completed = false;
  const tour = driver({
    popoverClass: 'sef-tour',
    showProgress: true,
    progressText: '{{current}} of {{total}}',
    nextBtnText: 'Next',
    prevBtnText: 'Back',
    doneBtnText: 'Done',
    allowClose: true,
    allowKeyboardControl: true,
    disableActiveInteraction: true,
    overlayColor: '#02040a',
    overlayOpacity: 0.62,
    stagePadding: 6,
    stageRadius: 14,
    steps: TOUR_STEPS.map((step) => ({
      // Resolved when the step shows: the first anchor on screen, else a centred popover.
      element: step.anchors.length ? () => firstVisibleAnchor(step.anchors, findAnchor) ?? centred() : undefined,
      popover: { title: step.title, description: step.description, side: step.side, align: 'start' },
    })),
    onDoneClick: () => {
      completed = true;
      tour.destroy();
    },
    onDestroyed: () => {
      active = null;
      markTourDone(hooks.account);
      log.info('tour_ended', { completed });
      if (completed) {
        capture('tour_completed');
        hooks.onComplete?.();
      }
    },
  });
  active = tour;
  log.info('tour_started', {});
  capture('tour_started');
  hooks.onStart?.();
  tour.drive();
}

/** A zero-size element in the middle of the screen, for a step whose anchor is not shown. */
function centred(): Element {
  let el = document.getElementById('sef-tour-centre');
  if (!el) {
    el = document.createElement('div');
    el.id = 'sef-tour-centre';
    el.setAttribute('aria-hidden', 'true');
    el.style.cssText = 'position:fixed;top:50%;left:50%;width:1px;height:1px;pointer-events:none';
    document.body.appendChild(el);
  }
  return el;
}
