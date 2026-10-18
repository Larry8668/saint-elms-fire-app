import assert from 'node:assert/strict';
import { test } from 'node:test';
import { consumeTourRequest, markTourDone, requestTour, TOUR_DONE_KEY, tourDone, tourDoneKey } from './tour-state';
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

test('completion is remembered per account under sef.tour.done:<account>', () => {
  const store = memory();
  assert.equal(tourDone('ananya', store), false);
  markTourDone('ananya', store);
  assert.equal(store.data.get(tourDoneKey('ananya')), '1');
  assert.equal(tourDone('ananya', store), true);
  assert.equal(tourDone('brinda', store), false, 'another student on the same browser still gets the tour');
  markTourDone(null, store);
  assert.equal(store.data.get(TOUR_DONE_KEY), '1', 'no account: one shared flag');
});

test('a requested tour runs once per request, on every sign-in, even after it was finished before', () => {
  const session = memory();
  const local = memory();
  assert.equal(consumeTourRequest('ananya', session, local), false, 'nothing requested');
  requestTour(session);
  assert.equal(consumeTourRequest('ananya', session, local), true);
  assert.equal(consumeTourRequest('ananya', session, local), false, 'consumed');
  markTourDone('ananya', local);
  requestTour(session);
  assert.equal(consumeTourRequest('ananya', session, local), true, 'the next sign-in shows it again');
});

test('storage that throws or is missing never breaks the tour', () => {
  assert.equal(tourDone('ananya', broken), false);
  assert.doesNotThrow(() => markTourDone('ananya', broken));
  assert.doesNotThrow(() => requestTour(broken));
  assert.equal(consumeTourRequest('ananya', broken, broken), false);
  assert.equal(tourDone('ananya', null), false);
  assert.equal(consumeTourRequest('ananya', null, null), false);
});

test('the first anchor laid out on screen is highlighted', () => {
  const shown = { getClientRects: () => [1] } as unknown as Element;
  const hidden = { getClientRects: () => [] } as unknown as Element;
  const els: Record<string, Element> = { 'sky-stats': hidden, sky: shown };
  assert.equal(firstVisibleAnchor(['sky-stats', 'sky'], (a) => els[a] ?? null), shown);
  assert.equal(firstVisibleAnchor(['missing'], () => null), null);
});
