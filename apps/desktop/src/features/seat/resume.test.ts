import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { MachineState, SeatClient } from '@/lib/instabox';
import { resumeSeat } from './resume';

function fakeClient(state: MachineState) {
  const calls: string[] = [];
  const client: Pick<SeatClient, 'machine' | 'power'> = {
    machine: async (id) => ({ id, name: 'sef-seat', state }),
    power: async (id, action, key) => {
      calls.push(`${action}:${id}:${key}`);
      return { id: 'op_1', machineId: id, type: action, state: 'queued' };
    },
  };
  return { client, calls };
}

test('a stopped seat is started and a paused one resumed, each with a fresh idempotency key', async () => {
  const stopped = fakeClient('stopped');
  assert.equal(await resumeSeat(stopped.client, 'm_x', () => 'k1'), 'requested');
  assert.deepEqual(stopped.calls, ['start:m_x:k1']);
  const paused = fakeClient('suspended');
  assert.equal(await resumeSeat(paused.client, 'm_x', () => 'k2'), 'requested');
  assert.deepEqual(paused.calls, ['resume:m_x:k2']);
});

test('a box already on its way needs no call; a deleted one cannot come back', async () => {
  for (const state of ['running', 'starting', 'resuming'] as const) {
    const fake = fakeClient(state);
    assert.equal(await resumeSeat(fake.client, 'm_x'), 'already_up', state);
    assert.deepEqual(fake.calls, []);
  }
  for (const state of ['deleted', 'deleting', 'error'] as const) {
    const fake = fakeClient(state);
    assert.equal(await resumeSeat(fake.client, 'm_x'), 'gone', state);
    assert.deepEqual(fake.calls, []);
  }
});
