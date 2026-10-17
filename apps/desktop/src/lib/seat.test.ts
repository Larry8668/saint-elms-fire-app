import assert from 'node:assert/strict';
import { test } from 'node:test';
import { engineTarget, isRemoteTarget } from './seat';

test('engine calls go to the local engine unless the UI is served by an engine itself', () => {
  assert.deepEqual(engineTarget(undefined, 'localhost'), { kind: 'local', base: 'http://127.0.0.1:4100' });
  assert.equal(engineTarget('http://127.0.0.1:4910', 'localhost').base, 'http://127.0.0.1:4910', 'the build-time local address still applies');
  assert.equal(isRemoteTarget(engineTarget(undefined, '4100-abc.instabox.tech')), false);
});

test('the UI an engine serves itself calls its own origin; outside loopback that is a remote workspace', () => {
  const served = engineTarget('same-origin', '4100-abc.instabox.tech');
  assert.deepEqual(served, { kind: 'served', base: '', remote: true });
  assert.equal(isRemoteTarget(served), true);
  for (const host of ['127.0.0.1', 'localhost', '[::1]']) assert.equal(isRemoteTarget(engineTarget('same-origin', host)), false, host);
  assert.equal(isRemoteTarget(engineTarget('same-origin', null)), false, 'no page (tests, workers) is not remote');
});
