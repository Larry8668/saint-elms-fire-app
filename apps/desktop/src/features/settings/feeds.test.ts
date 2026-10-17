import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { Feed, FeedItem } from '@sef/shared';
import { feedStatus, hostOf, originLabel, safeHref } from './feeds';

const NOW = Date.parse('2026-10-17T10:00:00Z');
const feed = (over: Partial<Feed> = {}): Feed => ({
  id: 'feed_1',
  url: 'https://www.nasa.gov/feed/',
  title: 'NASA',
  origin: 'student',
  consentedAt: null,
  enabled: false,
  addedAt: '2026-10-17T09:00:00Z',
  failures: 0,
  ...over,
});
const item = (link: string): FeedItem => ({ id: 'fi', feedId: 'feed_1', title: 't', summary: '', link, publishedAt: null, fetchedAt: '2026-10-17T09:00:00Z' });

test('status leads with consent, then off, then health, then freshness', () => {
  assert.match(feedStatus(feed(), NOW).text, /^Not fetched/);
  assert.match(feedStatus(feed({ consentedAt: '2026-10-17T09:00:00Z' }), NOW).text, /^Switched off/);
  const on = { consentedAt: '2026-10-17T09:00:00Z', enabled: true };
  assert.equal(feedStatus(feed({ ...on, failures: 4 }), NOW).tone, 'warn');
  assert.equal(feedStatus(feed({ ...on, lastSuccessAt: '2026-10-17T09:30:00Z' }), NOW).text, 'Checked 30 min ago');
  assert.match(feedStatus(feed(on), NOW).text, /every 15 minutes/);
});

test('labels and hosts', () => {
  assert.equal(hostOf('https://www.nasa.gov/feed/'), 'nasa.gov');
  assert.equal(originLabel(feed({ origin: 'uni' })), 'From your course');
  assert.equal(originLabel(feed()), 'Added by you');
});

test('only http(s) item links become links', () => {
  assert.equal(safeHref(item('https://www.nasa.gov/a')), 'https://www.nasa.gov/a');
  assert.equal(safeHref(item('javascript:alert(1)')), null);
  assert.equal(safeHref(item('')), null);
});
