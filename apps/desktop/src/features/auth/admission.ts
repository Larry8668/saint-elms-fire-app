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
    action: 'Check again',
  },
  rejected: {
    title: 'Application not accepted',
    body: 'The registrar did not accept this application. Contact the admissions office if you think that is wrong.',
    action: 'Open the university site',
  },
  suspended: {
    title: 'Enrolment suspended',
    body: 'Your enrolment is suspended. Your own files stay on this device and can still be read and exported.',
    action: 'Open the university site',
  },
  withdrawn: {
    title: 'Enrolment withdrawn',
    body: 'You have withdrawn from the programme. Your own files stay on this device and can still be read and exported.',
    action: 'Open the university site',
  },
};

export const admissionCopy = (state: AdmissionState): AdmissionCopy => COPY[state];
