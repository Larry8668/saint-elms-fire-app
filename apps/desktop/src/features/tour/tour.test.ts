import assert from 'node:assert/strict';
import { test } from 'node:test';
import { consumeTourRequest, markTourDone, requestTour, TOUR_DONE_KEY, tourDone } from './tour-state';
import { firstVisibleAnchor, TOUR_MAX_STEPS, TOUR_STEPS } from './tour-steps';

const memory = () => {
  const data = new Map<string, string>();
  return {
    data,
    getItem: (k: string) => data.get(k) ?? null,
    setItem: (k: string, v: string) => void data.set(k, v),
    removeItem: (k: string) => void data.delete(k),
  };
};

const broken = {
  getItem: () => {
    throw new Error('denied');
  },
  setItem: () => {
    throw new Error('denied');
  },
  removeItem: () => {
    throw new Error('denied');
  },
};

test('the tour stays light: at most eight steps, each anchor used once, closing on the Guide', () => {
  assert.ok(TOUR_STEPS.length <= TOUR_MAX_STEPS);
  const anchors = TOUR_STEPS.flatMap((s) => s.anchors);
  assert.equal(new Set(anchors).size, anchors.length);
  assert.match(TOUR_STEPS.at(-1)!.title, /Guide/);
  assert.deepEqual(TOUR_STEPS.at(-1)!.anchors, []);
});

test('completion is remembered under sef.tour.done', () => {
  const store = memory();
  assert.equal(tourDone(store), false);
  markTourDone(store);
  assert.equal(store.data.get(TOUR_DONE_KEY), '1');
  assert.equal(tourDone(store), true);
});

test('a requested tour runs once, and never after it was finished', () => {
  const session = memory();
  const local = memory();
  assert.equal(consumeTourRequest(session, local), false);
  requestTour(session);
  assert.equal(consumeTourRequest(session, local), true);
  assert.equal(consumeTourRequest(session, local), false, 'consumed');
  markTourDone(local);
  requestTour(session);
  assert.equal(consumeTourRequest(session, local), false);
});

test('storage that throws or is missing never breaks the tour', () => {
  assert.equal(tourDone(broken), false);
  assert.doesNotThrow(() => markTourDone(broken));
  assert.doesNotThrow(() => requestTour(broken));
  assert.equal(consumeTourRequest(broken, broken), false);
  assert.equal(tourDone(null), false);
  assert.equal(consumeTourRequest(null, null), false);
});

test('the first anchor laid out on screen is highlighted', () => {
  const shown = { getClientRects: () => [1] } as unknown as Element;
  const hidden = { getClientRects: () => [] } as unknown as Element;
  const els: Record<string, Element> = { 'sky-stats': hidden, sky: shown };
  assert.equal(firstVisibleAnchor(['sky-stats', 'sky'], (a) => els[a] ?? null), shown);
  assert.equal(firstVisibleAnchor(['missing'], () => null), null);
});
