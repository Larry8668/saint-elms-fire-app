import type { DeviceProfile } from '@sef/shared';

/**
 * What the desktop is allowed to show for a signed-in student.
 *
 * Admission is server-derived (the engine sets `profile.admission` during device sign-in)
 * and is never inferred from anything the client holds. `undefined` means a legacy
 * password/demo profile that predates admission gating and stays usable.
 */
export type AdmissionState = NonNullable<DeviceProfile['admission']> | 'legacy';

export const admissionOf = (profile: DeviceProfile): AdmissionState => profile.admission ?? 'legacy';

/** Only an approved enrolment reaches the dashboard; everything else gets its own screen. */
export const mayEnterDashboard = (state: AdmissionState): boolean => state === 'approved' || state === 'legacy';

export interface AdmissionCopy {
  title: string;
  body: string;
  /** Label for the escape hatch to the university-hosted site, when one makes sense. */
  action?: string;
}

const COPY: Record<AdmissionState, AdmissionCopy> = {
  approved: { title: "You're enrolled", body: 'Your course sky and teachers are ready.' },
  legacy: { title: 'Signed in', body: 'This device profile predates university admission checks.' },
  none: {
    title: 'Apply to the programme',
    body: 'Your account is verified. Applying puts you in the queue for the registrar to approve.',
    action: 'Apply on the university site',
  },
  pending: {
    title: 'Waiting for approval',
    body: 'The registrar is reviewing your application. You will be able to study as soon as they approve it.',
    // The gate renders a "Check again" refresh button next to this link, so the link needs its own label.
    action: 'Open the university portal',
  },
  rejected: {
    title: 'Application not accepted',
    body: 'The registrar did not accept this application. Contact the admissions office if you think that is wrong.',
    action: 'Open the university site',
  },
  suspended: {
    title: 'Enrolment suspended',
    // A fresh sign-in is a limited (read/export-only) session routed to its own screen;
    // this gate is the fallback for a session issued before the suspension landed.
    body: 'Your enrolment is suspended. Your own files stay on this device — sign out and back in to read and export them.',
    action: 'Open the university site',
  },
  withdrawn: {
    title: 'Enrolment withdrawn',
    body: 'You have withdrawn from the programme. Your own files stay on this device — sign out and back in to read and export them.',
    action: 'Open the university site',
  },
};

/**
 * The value arrives over the network from the engine, so a version skew could in principle
 * carry a state this build predates. `mayEnterDashboard` already fails closed for anything
 * unrecognised; this keeps the copy total instead of returning undefined and crashing.
 */
const UNKNOWN: AdmissionCopy = {
  title: 'Signed in, but not approved here',
  body: 'The university server reported an enrolment state this app does not recognise. Nothing is unlocked until it does.',
};

export const admissionCopy = (state: AdmissionState): AdmissionCopy => COPY[state] ?? UNKNOWN;
