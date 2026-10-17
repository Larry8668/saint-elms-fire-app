/** True only when a health reply says the university is down; no reply yet never blocks sign-in. */
export function uniOfflineFrom(health: { uni?: { reachable: boolean } } | undefined): boolean {
  return health?.uni ? !health.uni.reachable : false;
}

/**
 * The banner copy while the uni is down. Offline unlock is only promised when this engine
 * listed a profile that can actually unlock: a hosted seat (or any remote caller) gets an
 * empty picker and has offline-login refused, so the promise would be false there.
 */
export function uniOfflineMessage(offlineUnlockAvailable: boolean): string {
  const base = 'The university server is unreachable, so first-time sign-in is unavailable.';
  return offlineUnlockAvailable ? `${base} Students who signed in here before can still unlock offline.` : `${base} Try again once it is back.`;
}
