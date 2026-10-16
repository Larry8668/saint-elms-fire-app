import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { DeviceProfile } from '@sef/shared';
import { admissionCopy, admissionOf, mayEnterDashboard, type AdmissionState } from './admission';

const profile = (admission: DeviceProfile['admission']): DeviceProfile => ({
  id: 'p1',
  name: 'Test',
  email: 'test@example.test',
  cohortId: 'c1',
  offlineReady: true,
  ...(admission === undefined ? {} : { admission }),
});

test('an unapproved enrolment never reaches the dashboard', () => {
  for (const status of ['pending', 'rejected', 'suspended', 'withdrawn', 'none'] as const) {
    assert.equal(mayEnterDashboard(status), false, status);
  }
});

test('only an approval or a legacy profile reaches the dashboard', () => {
  assert.equal(mayEnterDashboard('approved'), true);
  // Legacy/password profiles predate the gate and stay usable.
  assert.equal(mayEnterDashboard('legacy'), true);
});

test('an absent admission field reads as legacy, never as approved-by-omission', () => {
  assert.equal(admissionOf(profile(undefined)), 'legacy');
  assert.equal(mayEnterDashboard(admissionOf(profile(undefined))), true);
});

test('a server-set admission value is carried through unchanged', () => {
  for (const status of ['pending', 'approved', 'rejected', 'suspended', 'withdrawn', 'none'] as const) {
    assert.equal(admissionOf(profile(status)), status);
  }
});

test('every state has honest copy and only pending offers a retry', () => {
  for (const status of ['approved', 'legacy', 'pending', 'rejected', 'suspended', 'withdrawn', 'none'] as const) {
    const copy = admissionCopy(status);
    assert.ok(copy.title.length > 0, status);
    assert.ok(copy.body.length > 0, status);
  }
  assert.equal(admissionCopy('approved').action, undefined, 'an approved student has nothing to fix');
  assert.ok(admissionCopy('pending').action, 'a pending student needs a way to check again');
});

test('the pending portal link is not labelled like the "Check again" refresh button', () => {
  // Regression: AdmissionGate renders a "Check again" refresh button beside this
  // link, so sharing the label showed two identical actions doing different things.
  const action = admissionCopy('pending').action;
  assert.ok(action);
  assert.notEqual(action, 'Check again');
  assert.match(action, /portal|university site/i);
});

test('withdrawn and suspended tell the student their own files are still theirs', () => {
  for (const status of ['withdrawn', 'suspended'] as const) {
    assert.match(admissionCopy(status).body, /stay on this device/i, status);
  }
});

test('an enrolment state this build predates still fails closed with usable copy', () => {
  // The value crosses the network from the engine, so a version skew can supply one.
  const unknown = 'archived' as AdmissionState;
  assert.equal(mayEnterDashboard(unknown), false, 'an unrecognised state must never unlock the dashboard');
  const copy = admissionCopy(unknown);
  assert.ok(copy.title.length > 0);
  assert.ok(copy.body.length > 0);
});

test('every known state has its own copy rather than falling through', () => {
  const states: AdmissionState[] = ['approved', 'legacy', 'none', 'pending', 'rejected', 'suspended', 'withdrawn'];
  const titles = states.map((s) => admissionCopy(s).title);
  assert.equal(new Set(titles).size, states.length, 'no two states share the same fallback text');
});
