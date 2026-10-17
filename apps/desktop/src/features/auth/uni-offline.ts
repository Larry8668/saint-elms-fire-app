/** True only when a health reply says the university is down; no reply yet never blocks sign-in. */
export function uniOfflineFrom(health: { uni?: { reachable: boolean } } | undefined): boolean {
  return health?.uni ? !health.uni.reachable : false;
}
