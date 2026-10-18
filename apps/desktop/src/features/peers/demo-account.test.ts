import assert from 'node:assert/strict';
import { test } from 'node:test';
import { DEMO_PEERS_TITLE, feedEmptyState, isDemoProfile } from './demo-account';

const demo = {};
const real = { programmeId: 'prog_1' };

test('a legacy password profile (no programme) is a demo account', () => {
  assert.equal(isDemoProfile(demo), true);
  assert.equal(isDemoProfile(real), false);
});

test('a demo account whose feed is refused gets the clear empty state, not "Sign in needed"', () => {
  const state = feedEmptyState('auth_required', 'Sharing needs a live university session. Sign in while online, then try again.', demo);
  assert.equal(state.title, DEMO_PEERS_TITLE);
  assert.match(state.body, /university account/);
  assert.doesNotMatch(state.body, /live university session/);
});

test('a real account keeps the existing wording for every state', () => {
  assert.deepEqual(feedEmptyState('auth_required', 'Sharing needs a live university session.', real), { title: 'Sign in needed', body: 'Sharing needs a live university session.' });
  assert.equal(feedEmptyState('offline', null, real).title, 'The university is unreachable');
  assert.equal(feedEmptyState('unavailable', null, real).body, 'The cohort feed is not available right now.');
});

test('a demo account that is merely offline still sees the offline state', () => {
  assert.equal(feedEmptyState('offline', 'x', demo).title, 'The university is unreachable');
});
