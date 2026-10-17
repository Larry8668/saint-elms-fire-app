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

/** Terminal outcomes the card stays mounted for, so the student actually sees them. `seat_not_yours` is the engine refusing a hosted seat's non-owner. */
export type GrantOutcome = Extract<DevicePollResult, { status: 'denied' | 'expired' }>['status'] | 'seat_not_yours';

const OUTCOME_COPY: Record<GrantOutcome, string> = {
  denied: 'That request was denied. You can start again.',
  expired: 'That code expired. Start again to get a new one.',
  seat_not_yours: 'This seat belongs to another student. Sign in on your own seat instead.',
};

export const outcomeMessage = (outcome: GrantOutcome): string => OUTCOME_COPY[outcome];
