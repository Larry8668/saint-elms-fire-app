import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createSeatClient, SeatError, type Invoke } from './instabox';

const recording = (reply: (command: string) => unknown) => {
  const calls: Array<[string, Record<string, unknown> | undefined]> = [];
  const invoke: Invoke = async <T,>(command: string, args?: Record<string, unknown>) => {
    calls.push([command, args]);
    const value = reply(command);
    if (value instanceof Error || (typeof value === 'object' && value && 'code' in value)) throw value;
    return value as T;
  };
  return { calls, client: createSeatClient(invoke) };
};

test('arguments use the camelCase names Tauri maps onto the Rust parameters', async () => {
  const { calls, client } = recording(() => ({ id: 'op_1', type: 'create', state: 'queued' }));
  await client.createSeat('sef-seat-1', 'k-1');
  await client.power('m_x', 'resume', 'k-2');
  await client.startBootstrap('m_x', { gitRef: 'main', publicHost: 'h.example.test', uniUrl: 'https://u.example.test' });
  assert.deepEqual(calls, [
    ['seat_create', { name: 'sef-seat-1', idempotencyKey: 'k-1' }],
    ['seat_power', { machineId: 'm_x', action: 'resume', idempotencyKey: 'k-2' }],
    ['seat_bootstrap_start', { machineId: 'm_x', params: { gitRef: 'main', publicHost: 'h.example.test', uniUrl: 'https://u.example.test' } }],
  ]);
});

test('a shell error keeps its Instabox code and retryability', async () => {
  const { client } = recording(() => ({ code: 'no_capacity', message: 'full', status: 503, retryable: true }));
  await assert.rejects(client.createSeat('sef-seat-1', 'k'), (error: unknown) => {
    assert.ok(error instanceof SeatError);
    assert.equal(error.code, 'no_capacity');
    assert.equal(error.retryable, true);
    assert.equal(error.status, 503);
    return true;
  });
});

test('a failure outside the shell contract becomes shell_unavailable', async () => {
  const { client } = recording(() => new Error('invoke is not a function'));
  await assert.rejects(client.hasKey(), (error: unknown) => error instanceof SeatError && error.code === 'shell_unavailable');
});

test('the key is passed once to seat_key_save and to no other command', async () => {
  const { calls, client } = recording(() => null);
  await client.saveKey('ibk_example_key_1234');
  await client.account();
  await client.listSeats();
  const withKey = calls.filter(([, args]) => JSON.stringify(args ?? {}).includes('ibk_'));
  assert.deepEqual(withKey.map(([c]) => c), ['seat_key_save']);
});
