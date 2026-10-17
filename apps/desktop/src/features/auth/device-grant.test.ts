import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { DeviceSignInStart } from '@sef/shared';
import { formatCountdown, initialPollInterval, nextPollIntervalSeconds, outcomeMessage } from './device-grant';

const grant = (intervalSeconds: number): DeviceSignInStart => ({
  userCode: 'ABCD-EFGH',
  verificationUri: 'https://uni.example.test/device',
  expiresInSeconds: 600,
  intervalSeconds,
});

test('a 600-second grant counts down from 10:00 — the value is already seconds', () => {
  // Regression: dividing expiresInSeconds by 1000 showed "0:01" for a ten-minute
  // grant and disabled the verification link for its whole validity window.
  assert.equal(formatCountdown(grant(5).expiresInSeconds), '10:00');
  assert.equal(formatCountdown(599), '9:59');
  assert.equal(formatCountdown(61), '1:01');
  assert.equal(formatCountdown(60), '1:00');
  assert.equal(formatCountdown(0), '0:00');
});

test('the first poll delay comes from the grant, clamped to the floor', () => {
  assert.equal(initialPollInterval(grant(5)), 5);
  assert.equal(initialPollInterval(grant(0)), 2);
});

test('a slow_down hint widens the poll interval', () => {
  assert.equal(nextPollIntervalSeconds(5, { status: 'pending', intervalSeconds: 10 }), 10);
});

test('a hinted interval is still clamped to the floor', () => {
  assert.equal(nextPollIntervalSeconds(5, { status: 'pending', intervalSeconds: 1 }), 2);
});

test('a pending result without a hint keeps the current interval', () => {
  assert.equal(nextPollIntervalSeconds(7, { status: 'pending' }), 7);
});

test('terminal results never change the interval', () => {
  assert.equal(nextPollIntervalSeconds(7, { status: 'denied' }), 7);
  assert.equal(nextPollIntervalSeconds(7, { status: 'expired' }), 7);
});

test('denied and expired outcomes carry start-again copy', () => {
  assert.match(outcomeMessage('denied'), /denied/i);
  assert.match(outcomeMessage('denied'), /start again/i);
  assert.match(outcomeMessage('expired'), /expired/i);
  assert.match(outcomeMessage('expired'), /start again/i);
});

test('a hosted seat refusing a non-owner says whose seat it is', () => {
  assert.match(outcomeMessage('seat_not_yours'), /belongs to another student/i);
});
