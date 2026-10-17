import assert from 'node:assert/strict';
import { test } from 'node:test';
import { screeningBadge } from './screening';

test('the badge names what the screen found, honestly', () => {
  assert.deepEqual(screeningBadge({ status: 'clean', categories: [], model: 'shieldgemma:2b' }), {
    tone: 'aurora',
    label: 'Screened on-device — nothing flagged',
  });
  assert.deepEqual(screeningBadge({ status: 'flagged', categories: ['hate speech', 'dangerous'], model: 'm' }), {
    tone: 'ember',
    label: 'Flagged on-device: hate speech, dangerous',
  });
  assert.deepEqual(screeningBadge({ status: 'flagged', categories: [], model: 'm' }), {
    tone: 'ember',
    label: 'Flagged by on-device screening',
  });
  assert.deepEqual(screeningBadge({ status: 'unavailable', categories: [], model: '' }), {
    tone: 'neutral',
    label: 'Screening unavailable — no check ran',
  });
});
