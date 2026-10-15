import type { AdmissionMe, EnrolmentStatus } from '@sef/shared';

/** Everything the shell can show after a successful sign-in. */
export type AdmissionState = 'not-applied' | EnrolmentStatus;

/**
 * Admission is derived from the server's record, never claimed by the client. A missing
 * student record reads as "has not applied" regardless of whether an enrolment row exists,
 * because the application is the thing that creates that record.
 */
export function admissionState(me: AdmissionMe): AdmissionState {
  if (me.studentId === null || me.enrolment === null) return 'not-applied';
  return me.enrolment.status;
}