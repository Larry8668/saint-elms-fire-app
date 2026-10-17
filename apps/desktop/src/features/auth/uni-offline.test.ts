import assert from 'node:assert/strict';
import { test } from 'node:test';
import { uniOfflineFrom, uniOfflineMessage } from './uni-offline';

test('the sign-in banner and Continue gate follow the public uni boolean', () => {
  assert.equal(uniOfflineFrom({ uni: { reachable: false } }), true);
  assert.equal(uniOfflineFrom({ uni: { reachable: true } }), false);
  assert.equal(uniOfflineFrom(undefined), false, 'not yet known: do not block');
  assert.equal(uniOfflineFrom({}), false);
});

test('the offline-unlock promise appears only when an offline-ready profile is listed', () => {
  assert.match(uniOfflineMessage(true), /can still unlock offline/);
  const hosted = uniOfflineMessage(false);
  assert.doesNotMatch(hosted, /offline/i, 'a hosted seat refuses offline unlock and lists no profiles');
  assert.match(hosted, /unreachable/);
});
