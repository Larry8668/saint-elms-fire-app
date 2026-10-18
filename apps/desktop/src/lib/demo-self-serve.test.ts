import assert from 'node:assert/strict';
import { test } from 'node:test';
import { selfServePassword } from './demo-self-serve';

test('self-serve needs both the flag and an embedded password', () => {
  assert.equal(selfServePassword({ VITE_DEMO_SELF_SERVE: 'true', VITE_DEMO_PASSWORD: 'pw' }), 'pw');
  assert.equal(selfServePassword({ VITE_DEMO_SELF_SERVE: 'true' }), null);
  assert.equal(selfServePassword({ VITE_DEMO_SELF_SERVE: 'true', VITE_DEMO_PASSWORD: '' }), null);
  assert.equal(selfServePassword({ VITE_DEMO_SELF_SERVE: 'false', VITE_DEMO_PASSWORD: 'pw' }), null);
  assert.equal(selfServePassword({ VITE_DEMO_PASSWORD: 'pw' }), null);
  assert.equal(selfServePassword(undefined), null);
});
