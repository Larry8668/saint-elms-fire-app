import assert from 'node:assert/strict';
import { test } from 'node:test';
import { uniOfflineFrom } from './uni-offline';

test('the sign-in banner and Continue gate follow the public uni boolean', () => {
  assert.equal(uniOfflineFrom({ uni: { reachable: false } }), true);
  assert.equal(uniOfflineFrom({ uni: { reachable: true } }), false);
  assert.equal(uniOfflineFrom(undefined), false, 'not yet known: do not block');
  assert.equal(uniOfflineFrom({}), false);
});
