import assert from 'node:assert/strict';
import test from 'node:test';
import { spawnFailureReason } from './orchestrator';

test('the student reason is a fixed sentence per failure code', () => {
  assert.equal(spawnFailureReason('sync_error: The engine could not restore the vault.'), 'The engine could not restore the vault.');
  assert.equal(spawnFailureReason('health_timeout: whatever'), 'The workspace never reported that it was ready.');
});

test('unknown codes and raw detail never reach the student', () => {
  const raw = 'internal: TypeError m_abc123 https://4100-abc.instabox.tech token=secret';
  assert.equal(spawnFailureReason(raw), 'The workspace machine could not be prepared.');
  assert.equal(spawnFailureReason(null), 'The workspace machine could not be prepared.');
  assert.doesNotMatch(spawnFailureReason(raw), /m_abc|https?:|secret/);
});
