/**
 * Whether the tour was finished or dismissed for an account (localStorage, per browser and per
 * account: a shared laptop that switches demo students gets it once per student) and whether a
 * self-serve sign-in asked for it (sessionStorage, consumed once). Storage that is missing or
 * throws reads as "not done, not requested" and every write is best-effort.
 */
export const TOUR_DONE_KEY = 'sef.tour.done';
/** The flag for one account; an unknown account shares one flag so the tour never repeats within a browser. */
export const tourDoneKey = (account: string | null | undefined): string => (account ? `${TOUR_DONE_KEY}:${account}` : TOUR_DONE_KEY);
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

export function tourDone(account: string | null | undefined, store: Store = local()): boolean {
  try {
    return store?.getItem(tourDoneKey(account)) === '1';
  } catch {
    return false;
  }
}

export function markTourDone(account: string | null | undefined, store: Store = local()): void {
  try {
    store?.setItem(tourDoneKey(account), '1');
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

/**
 * True once per request. For the demo the tour runs on every self-serve sign-in (judges share
 * laptops and expect it each time); the per-account done flag is kept for analytics and for a
 * later "only once" mode, but it does not suppress the run.
 */
export function consumeTourRequest(account: string | null | undefined, store: Store = session(), _done: Store = local()): boolean {
  try {
    if (store?.getItem(TOUR_PENDING_KEY) !== '1') return false;
    store.removeItem(TOUR_PENDING_KEY);
  } catch {
    return false;
  }
  void account;
  return true;
}
