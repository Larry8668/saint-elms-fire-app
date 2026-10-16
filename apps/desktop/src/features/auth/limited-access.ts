import type { LimitedAccessReason, SessionAccess } from '@sef/shared';

/**
 * Read/export-only sessions, from the desktop's side.
 *
 * The engine decides the mode when a session is issued — an expired offline
 * entitlement, or an enrolment the uni now reports as suspended or withdrawn — and
 * enforces it on every route. The UI's only job is to say so honestly: the access
 * is server-derived, never inferred from anything the client holds.
 */
export type LimitedReason = LimitedAccessReason;

/** Why this session is limited, or null when it is a full one. `undefined` = limited, reason unknown (older engine). */
export const limitedReasonOf = (access: SessionAccess | undefined): LimitedReason | undefined | null =>
  access?.mode === 'limited' ? access.reason : null;

export interface LimitedAccessCopy {
  title: string;
  body: string;
  /** How full access comes back, when there is a way back. */
  restore?: string;
}

const COPY: Record<LimitedReason, LimitedAccessCopy> = {
  entitlement_expired: {
    title: 'Offline access expired',
    body: 'Your offline entitlement has expired, so studying is paused. Your own files stay on this device — export them below whenever you need them.',
    restore: 'Sign in while online to restore full access.',
  },
  admission_suspended: {
    title: 'Enrolment suspended',
    body: 'Your enrolment is suspended, so studying is paused. Your own files stay yours — they remain on this device, and you can export them below.',
  },
  admission_withdrawn: {
    title: 'Enrolment withdrawn',
    body: 'Your enrolment has been withdrawn. Your own files stay yours — they remain on this device, and you can export them below.',
  },
};

/** The reason crosses the network, so a newer engine can name one this build predates. */
const UNKNOWN: LimitedAccessCopy = {
  title: 'Read and export only',
  body: 'This sign-in is limited, so studying is paused. Your own files stay on this device — export them below whenever you need them.',
};

export const limitedAccessCopy = (reason: LimitedReason | undefined): LimitedAccessCopy => (reason ? COPY[reason] ?? UNKNOWN : UNKNOWN);
