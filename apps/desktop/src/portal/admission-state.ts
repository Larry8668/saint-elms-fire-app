import type { AdmissionMe, EnrolmentStatus } from '@sef/shared';

/** Everything the shell can show after a successful sign-in. */
export type AdmissionState = 'not-applied' | EnrolmentStatus;

/**
 * Admission is derived from the server's record, never claimed by the client.
 *
 * Either half being absent reads as "has not applied". The two move together in practice —
 * applying is what creates the student record — so the only way to observe one without the
 * other is a server or migration that left them inconsistent. Treating that as not-applied
 * fails closed: the shell offers the apply path, and the server still decides the outcome.
 */
export function admissionState(me: AdmissionMe): AdmissionState {
  if (me.studentId === null || me.enrolment === null) return 'not-applied';
  return me.enrolment.status;
}