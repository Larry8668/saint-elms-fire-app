import type { DevicePollResult, DeviceSignInStart } from '@sef/shared';

/**
 * Timing and copy rules for the RFC 8628 device-grant card. The grant's
 * `expiresInSeconds` and `intervalSeconds` are already seconds (RFC 8628 §3.2);
 * nothing here may convert units.
 */

/** Clients must not poll faster than the server's interval; 2 s is the local floor. */
export const MIN_POLL_INTERVAL_SECONDS = 2;

export const clampPollInterval = (seconds: number): number => Math.max(MIN_POLL_INTERVAL_SECONDS, Math.ceil(seconds));

export const initialPollInterval = (grant: DeviceSignInStart): number => clampPollInterval(grant.intervalSeconds);

/** A `slow_down` from the uni arrives as a wider `intervalSeconds` hint; adopt it, otherwise keep the current delay. */
export const nextPollIntervalSeconds = (current: number, result: DevicePollResult): number =>
  result.status === 'pending' && typeof result.intervalSeconds === 'number' ? clampPollInterval(result.intervalSeconds) : current;

/** Remaining lifetime of the user code as m:ss; the input is already seconds. */
export const formatCountdown = (secondsLeft: number): string => `${Math.floor(secondsLeft / 60)}:${String(secondsLeft % 60).padStart(2, '0')}`;

/** Terminal outcomes the card stays mounted for, so the student actually sees them. */
export type GrantOutcome = Extract<DevicePollResult, { status: 'denied' | 'expired' }>['status'];

export const outcomeMessage = (outcome: GrantOutcome): string =>
  outcome === 'denied' ? 'That request was denied. You can start again.' : 'That code expired. Start again to get a new one.';
