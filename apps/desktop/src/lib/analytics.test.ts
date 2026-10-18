import assert from 'node:assert/strict';
import { test } from 'node:test';
import { analyticsConfig, capture, DEFAULT_POSTHOG_HOST, demoDistinctId, identifyDemo, initAnalytics, scrubUrls } from './analytics';

test('no key, no PostHog', () => {
  assert.equal(analyticsConfig(undefined), null);
  assert.equal(analyticsConfig({}), null);
  assert.equal(analyticsConfig({ VITE_POSTHOG_KEY: '  ' }), null);
});

test('the host defaults to PostHog US and drops a trailing slash', () => {
  assert.deepEqual(analyticsConfig({ VITE_POSTHOG_KEY: 'phc_x' }), { key: 'phc_x', host: DEFAULT_POSTHOG_HOST });
  assert.deepEqual(analyticsConfig({ VITE_POSTHOG_KEY: 'phc_x', VITE_POSTHOG_HOST: 'https://eu.i.posthog.com/' }), { key: 'phc_x', host: 'https://eu.i.posthog.com' });
});

test('a session is identified by the demo persona only, never by an email', () => {
  assert.equal(demoDistinctId('ananya'), 'demo:ananya');
  assert.equal(demoDistinctId('ananya@saintelms.local'), null);
  assert.equal(demoDistinctId(''), null);
  assert.equal(demoDistinctId(null), null);
});

test('without a key every call is a silent no-op', () => {
  assert.doesNotThrow(() => {
    initAnalytics({});
    capture('tour_started');
    identifyDemo('ananya');
  });
});

test('outgoing URLs lose their query and fragment, so a token or workspace address never leaves', () => {
  const props = scrubUrls({ $current_url: 'https://sef-uni.onrender.com/app?token=secret#x', $referrer: 'https://a.example/?workspace=https%3A%2F%2Fvm', $pathname: '/app', other: 'keep?me' });
  assert.deepEqual(props, { $current_url: 'https://sef-uni.onrender.com/app', $referrer: 'https://a.example/', $pathname: '/app', other: 'keep?me' });
  assert.equal(scrubUrls(undefined), undefined);
});
