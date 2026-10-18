/**
 * Whether the tour was finished (localStorage, per browser) and whether a self-serve sign-in
 * asked for it (sessionStorage, consumed once). Storage that is missing or throws reads as
 * "not done, not requested" and every write is best-effort.
 */
export const TOUR_DONE_KEY = 'sef.tour.done';
export const TOUR_PENDING_KEY = 'sef.tour.pending';

type Store = Pick<Storage, 'getItem' | 'setItem' | 'removeItem'> | null;

const local = (): Store => {
  try {
    return typeof localStorage === 'undefined' ? null : localStorage;
  } catch {
    return null;
  }
};

const session = (): Store => {
  try {
    return typeof sessionStorage === 'undefined' ? null : sessionStorage;
  } catch {
    return null;
  }
};

export function tourDone(store: Store = local()): boolean {
  try {
    return store?.getItem(TOUR_DONE_KEY) === '1';
  } catch {
    return false;
  }
}

export function markTourDone(store: Store = local()): void {
  try {
    store?.setItem(TOUR_DONE_KEY, '1');
  } catch {
    // Not remembered: the tour may be offered again, which is harmless.
  }
}

/** A self-serve demo sign-in asks for the tour to run once the dashboard is up. */
export function requestTour(store: Store = session()): void {
  try {
    store?.setItem(TOUR_PENDING_KEY, '1');
  } catch {
    // No tour then; the sidebar button still offers it.
  }
}

/** The sign-in that asked for the tour failed: drop the request. */
export function cancelTourRequest(store: Store = session()): void {
  try {
    store?.removeItem(TOUR_PENDING_KEY);
  } catch {
    // Nothing to drop.
  }
}

/** True once per request, and only when the tour was not finished before. */
export function consumeTourRequest(store: Store = session(), done: Store = local()): boolean {
  try {
    if (store?.getItem(TOUR_PENDING_KEY) !== '1') return false;
    store.removeItem(TOUR_PENDING_KEY);
  } catch {
    return false;
  }
  return !tourDone(done);
}
