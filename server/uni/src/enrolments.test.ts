import assert from 'node:assert/strict';
import test from 'node:test';
import { canDecide } from './enrolments';
import type { EnrolmentDecisionRequest, EnrolmentStatus } from '@sef/shared';

const actions: EnrolmentDecisionRequest['action'][] = ['approve', 'reject', 'suspend', 'reinstate', 'assign_cohort'];
const statuses: EnrolmentStatus[] = ['pending', 'approved', 'rejected', 'suspended', 'withdrawn'];

test('the staff transition matrix allows exactly the documented edges', () => {
  const allowed: Record<EnrolmentStatus, EnrolmentDecisionRequest['action'][]> = {
    pending: ['approve', 'reject'],
    approved: ['suspend', 'assign_cohort'],
    suspended: ['reinstate'],
    rejected: [],
    withdrawn: [],
  };
  for (const status of statuses) {
    for (const action of actions) {
      assert.equal(canDecide(status, action), allowed[status].includes(action), `${status} + ${action}`);
    }
  }
});

test('terminal states accept no staff action', () => {
  for (const action of actions) {
    assert.equal(canDecide('rejected', action), false);
    assert.equal(canDecide('withdrawn', action), false);
  }
});
