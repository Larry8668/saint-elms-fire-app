import assert from 'node:assert/strict';
import { test } from 'node:test';
import { CONTRACT_VERSION, type AdmissionMe, type EnrolmentStatus } from '@sef/shared';
import { admissionState } from './admission-state';

const enrolment = (status: EnrolmentStatus): AdmissionMe['enrolment'] => ({
  schemaVersion: CONTRACT_VERSION,
  id: 'enr_1',
  studentId: 'stu_1',
  programmeId: 'bsc-pma',
  curriculumVersion: 'v1',
  status,
  // The schema forbids a cohort on a pending enrolment, and requires one once decided.
  cohortId: status === 'pending' || status === 'withdrawn' ? null : 'bsc-pma-2026',
  version: 1,
  requestedAt: '2026-10-15T00:00:00.000Z',
  updatedAt: '2026-10-15T00:00:00.000Z',
  decision: null,
});

const me = (studentId: string | null, enrol: AdmissionMe['enrolment']): AdmissionMe => ({
  schemaVersion: CONTRACT_VERSION,
  user: { id: 'u1', email: 'a@example.test', name: 'A', emailVerified: true },
  studentId,
  enrolment: enrol,
  staffRoles: [],
});

test('a server-reported status is carried through unchanged', () => {
  for (const status of ['pending', 'approved', 'rejected', 'suspended', 'withdrawn'] as const) {
    assert.equal(admissionState(me('stu_1', enrolment(status))), status);
  }
});

test('an account with no student record has not applied', () => {
  assert.equal(admissionState(me(null, null)), 'not-applied');
});

test('a record without an enrolment reads as not-applied rather than throwing', () => {
  // The two are created together, so this is only reachable through an inconsistent server.
  // Failing closed is the point: the shell offers apply, and the server still decides.
  assert.equal(admissionState(me('stu_1', null)), 'not-applied');
});

test('an unverified account with a record still reports its real status', () => {
  const unverified = { ...me('stu_1', enrolment('pending')), user: { ...me('stu_1', enrolment('pending')).user, emailVerified: false } };
  assert.equal(admissionState(unverified), 'pending');
});
