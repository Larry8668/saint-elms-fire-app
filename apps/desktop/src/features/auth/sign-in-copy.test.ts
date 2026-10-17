import assert from 'node:assert/strict';
import { test } from 'node:test';
import { engineTarget } from '@/lib/seat';
import { SIGN_IN_PROMISES, signInCopyMode } from './sign-in-copy';

test('the UI a remote workspace serves gets the hosted copy; loopback and the local engine keep theirs', () => {
  assert.equal(signInCopyMode(engineTarget('same-origin', '4100-abc.instabox.tech')), 'hosted');
  assert.equal(signInCopyMode(engineTarget('same-origin', '127.0.0.1')), 'local', 'an engine serving its UI on loopback is this computer');
  assert.equal(signInCopyMode(engineTarget('same-origin', 'localhost')), 'local');
  assert.equal(signInCopyMode(engineTarget(undefined, '4100-abc.instabox.tech')), 'local', 'a build pointed at a local engine is local wherever it is opened');
  assert.equal(signInCopyMode(engineTarget('http://127.0.0.1:4910', null)), 'local');
});

test('the hosted copy never promises on-device storage or offline use', () => {
  const hosted = SIGN_IN_PROMISES.hosted.map((p) => p.text.toLowerCase()).join(' | ');
  assert.doesNotMatch(hosted, /this device|offline/);
  assert.match(hosted, /university's servers/);
  assert.match(hosted, /saved to your university storage/);
  const local = SIGN_IN_PROMISES.local.map((p) => p.text).join(' | ');
  assert.match(local, /stays on this device/, 'the local desktop keeps its current copy');
  assert.match(local, /Keeps working offline/);
});

test('inline storage notes follow the same mode', async () => {
  const { whereItIsKept } = await import('./sign-in-copy');
  assert.equal(whereItIsKept('local'), 'stays on this device');
  assert.equal(whereItIsKept('hosted'), 'saved to your university storage');
});
