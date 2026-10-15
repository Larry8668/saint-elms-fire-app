import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  EnrolmentApplicationSchema,
  EnrolmentDecisionRequestSchema,
  EnrolmentSchema,
  StudentProfileContextSchema,
} from './identity';
import { makeContractFixtures } from './testing/fixtures';

type AnySchema = { safeParse: (v: unknown) => { success: boolean }; parse: (v: unknown) => unknown };

const rejects = (schema: AnySchema, value: unknown, message?: string) =>
  assert.equal(schema.safeParse(value).success, false, message);

const pendingEnrolment = () => {
  const { enrolments } = makeContractFixtures();
  return {
    ...enrolments.a,
    id: 'enrolment-p',
    status: 'pending',
    cohortId: null,
    decision: null,
    version: 1,
  };
};

test('enrolment application is strictly programmeId plus version', () => {
  const { application } = makeContractFixtures();
  for (const extra of [
    { roles: ['student'] },
    { status: 'active' },
    { studentId: 'student-a' },
    { cohortId: 'cohort-a' },
  ]) {
    rejects(EnrolmentApplicationSchema, { ...application, ...extra });
  }
});

test('pending enrolment carries no cohort or decision', () => {
  const pending = pendingEnrolment();
  assert.equal(EnrolmentSchema.safeParse(pending).success, true);
  rejects(EnrolmentSchema, { ...pending, cohortId: 'cohort-a' });
  rejects(EnrolmentSchema, { ...pending, decision: { actorId: 'registrar-1', at: pending.updatedAt, reason: 'early' } });
});

test('approved and suspended enrolments require a cohort', () => {
  const { enrolments } = makeContractFixtures();
  for (const status of ['approved', 'suspended']) {
    rejects(EnrolmentSchema, { ...enrolments.a, status, cohortId: null });
  }
});

test('decided enrolments require decision provenance', () => {
  const { enrolments } = makeContractFixtures();
  for (const status of ['approved', 'rejected', 'suspended', 'withdrawn']) {
    const record = { ...enrolments.a, status, cohortId: status === 'rejected' || status === 'withdrawn' ? null : 'cohort-a' };
    rejects(EnrolmentSchema, { ...record, decision: null });
  }
  rejects(EnrolmentSchema, { ...enrolments.a, decision: { at: enrolments.a.updatedAt, reason: 'missing actor' } });
  rejects(EnrolmentSchema, {
    ...enrolments.a,
    decision: { actorId: 'registrar-1', at: enrolments.a.updatedAt, reason: '' },
  });
});

test('withdrawn and rejected enrolments may drop the cohort', () => {
  const { enrolments } = makeContractFixtures();
  for (const status of ['rejected', 'withdrawn']) {
    assert.equal(
      EnrolmentSchema.safeParse({ ...enrolments.a, status, cohortId: null }).success,
      true,
      `${status} without cohort should parse`,
    );
  }
});

test('enrolment version and ordering invariants', () => {
  const { enrolments } = makeContractFixtures();
  rejects(EnrolmentSchema, { ...enrolments.a, version: 0 });
  rejects(EnrolmentSchema, { ...enrolments.a, version: 1.5 });
  rejects(EnrolmentSchema, { ...enrolments.a, updatedAt: '2024-12-01T09:00:00.000Z' });
});

test('decision timestamp must fall between application and last update', () => {
  const { enrolments } = makeContractFixtures();
  const decision = { actorId: 'registrar-1', reason: 'Checked' };
  rejects(EnrolmentSchema, { ...enrolments.a, decision: { ...decision, at: '2024-12-01T09:00:00.000Z' } });
  rejects(EnrolmentSchema, { ...enrolments.a, decision: { ...decision, at: '2025-06-01T09:00:00.000Z' } });
  assert.equal(
    EnrolmentSchema.safeParse({
      ...enrolments.a,
      decision: { ...decision, at: '2025-02-01T09:00:00.000Z' },
    }).success,
    true,
  );
});

test('decision request couples cohort to approve and assign_cohort only', () => {
  const { decisionRequest } = makeContractFixtures();
  for (const action of ['approve', 'assign_cohort']) {
    rejects(EnrolmentDecisionRequestSchema, { ...decisionRequest, action, cohortId: undefined });
  }
  for (const action of ['reject', 'suspend', 'reinstate']) {
    rejects(EnrolmentDecisionRequestSchema, { ...decisionRequest, action, cohortId: 'cohort-b' });
    assert.equal(
      EnrolmentDecisionRequestSchema.safeParse({ ...decisionRequest, action, cohortId: undefined }).success,
      true,
      `${action} without cohort should parse`,
    );
  }
  rejects(EnrolmentDecisionRequestSchema, { ...decisionRequest, expectedVersion: 0 });
  rejects(EnrolmentDecisionRequestSchema, { ...decisionRequest, reason: '   ' });
});

test('profile context is a display identity, not an authorization proof', () => {
  const { contextA } = makeContractFixtures();
  assert.equal(StudentProfileContextSchema.safeParse(contextA).success, true);
  rejects(StudentProfileContextSchema, { ...contextA, token: 'sef1.abc' });
  rejects(StudentProfileContextSchema, { ...contextA, identity: { ...contextA.identity, issuer: 'not a url' } });
});
