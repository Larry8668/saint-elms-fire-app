/**
 * The onboarding shell is a small state machine over account creation and admission.
 * `admission` is the only signed-in state; every other mode is reachable without a session.
 */
export type PortalMode = 'sign-in' | 'register' | 'magic-link' | 'check-email' | 'recover' | 'reset-password' | 'admission';

/** What the server put in the URL after the student clicked an emailed link. */
export type Landing = 'verified' | 'link-error';

export interface PortalRoute {
  mode: PortalMode;
  /** Password-reset links carry the single-use token; present only in `reset-password`. */
  resetToken: string | null;
  landing: Landing | null;
  /** Code behind `landing === 'link-error'`, so the copy names the real failure. */
  errorCode: string | null;
}

export const PORTAL_PATH = '/app/';

/**
 * Email links land here, so the query string carries the outcome. Reading it once on mount
 * and then scrubbing the URL keeps a stale `?token=` out of history and out of the next view.
 */
export function readPortalRoute(): PortalRoute {
  const search = new URLSearchParams(window.location.search);
  const wantsReset = window.location.hash.replace(/^#/, '') === 'reset-password';

  if (wantsReset) {
    return { mode: 'reset-password', resetToken: search.get('token'), landing: null, errorCode: search.get('error') };
  }
  if (search.has('verified')) {
    return { mode: 'sign-in', resetToken: null, landing: 'verified', errorCode: null };
  }
  if (search.has('error')) {
    return { mode: 'sign-in', resetToken: null, landing: 'link-error', errorCode: search.get('error') };
  }
  return { mode: 'sign-in', resetToken: null, landing: null, errorCode: null };
}

/** Moves between modes, dropping the landing state the server wrote into the URL. */
export function goToMode(mode: PortalMode): PortalRoute {
  if (mode !== 'reset-password') window.history.replaceState(null, '', PORTAL_PATH);
  return { mode, resetToken: null, landing: null, errorCode: null };
}