import type { DeviceProfile, PeerFeedResponse } from '@sef/shared';

export const DEMO_PEERS_TITLE = 'Peers are not available on demo accounts';
export const DEMO_PEERS_BODY = 'Sharing with your cohort needs a university account. Sign in with one to publish pages and import classmates’ shares.';

/**
 * A demo student signed in with the legacy password path, so it has no better-auth session and
 * the uni refuses its share calls. Device sign-in always records the programme; profiles that
 * predate it (legacy password profiles) never have one.
 */
export const isDemoProfile = (profile: Pick<DeviceProfile, 'programmeId'>): boolean => !profile.programmeId;

/** The empty state for a refused feed: demo accounts get the clear explanation, everyone else the server's own. */
export function feedEmptyState(
  state: PeerFeedResponse['state'],
  detail: string | null | undefined,
  profile: Pick<DeviceProfile, 'programmeId'>,
): { title: string; body: string } {
  if (state === 'auth_required' && isDemoProfile(profile)) return { title: DEMO_PEERS_TITLE, body: DEMO_PEERS_BODY };
  return {
    title: state === 'offline' ? 'The university is unreachable' : state === 'auth_required' ? 'Sign in needed' : 'Feed unavailable',
    body: detail ?? 'The cohort feed is not available right now.',
  };
}
