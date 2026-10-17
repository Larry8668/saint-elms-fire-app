// Contract tests: the TypeScript client against the in-repo fake Instabox (no database needed).

import assert from 'node:assert/strict';
import { after, before, beforeEach, test } from 'node:test';
import { InstaboxClient, InstaboxError } from './client';
import { FAKE_KEY, FakeInstabox } from './fake';

let fake: FakeInstabox;
let client: InstaboxClient;
const SNAPSHOT = 'sn_agquvqu6h2bc33n7w2bfctcxni';
const input = (name: string) => ({ name, snapshotId: SNAPSHOT, metadata: { app: 'sef-session', account: 'ananya' } });

before(async () => {
  fake = new FakeInstabox();
  await fake.listen();
});
after(() => fake.close());
beforeEach(() => {
  fake.machines.clear();
  fake.seen.length = 0;
  fake.injections = [];
  fake.noCapacity = 0;
  fake.quota = 5;
  fake.pollsToFinish = 1;
  client = new InstaboxClient({ apiKey: FAKE_KEY, baseUrl: fake.base });
});

const rejectsWith = async (promise: Promise<unknown>, code: string) => {
  const error = await promise.then(() => null, (e: unknown) => e);
  assert.ok(error instanceof InstaboxError, `expected an InstaboxError, got ${String(error)}`);
  assert.equal(error.code, code);
  return error;
};

test('create sends vault:false, the snapshot and the labels, with an Idempotency-Key', async () => {
  const op = await client.createMachine(input('sef-s-1'), 'key-create-1');
  assert.equal(op.type, 'create');
  const [seen] = fake.requests('POST', '/v1/machines');
  assert.equal(seen!.headers['idempotency-key'], 'key-create-1');
  assert.equal(seen!.headers['x-api-key'], FAKE_KEY);
  assert.deepEqual(seen!.body, { name: 'sef-s-1', snapshotId: SNAPSHOT, vault: false, metadata: { app: 'sef-session', account: 'ananya' } });
});

test('a replayed create returns the same operation and makes no second machine', async () => {
  const first = await client.createMachine(input('sef-s-2'), 'key-replay');
  const second = await client.createMachine(input('sef-s-2'), 'key-replay');
  assert.equal(second.id, first.id);
  assert.equal(second.machineId, first.machineId);
  assert.equal(fake.machines.size, 1);
  // The same key with a different body is a conflict, not a silent second create.
  await rejectsWith(client.createMachine(input('sef-s-other'), 'key-replay'), 'idempotency_conflict');
});

test('operation polling: waits through running and resolves on success; the machine comes back stopped', async () => {
  fake.pollsToFinish = 3;
  const op = await client.createMachine(input('sef-s-3'), 'key-poll');
  const done = await client.waitOperation(op, Date.now() + 10_000);
  assert.equal(done.state, 'succeeded');
  assert.equal(fake.requests('GET', '/v1/operations/').length, 4);
  assert.match(fake.requests('GET', '/v1/operations/')[0]!.path, /\?wait=\d+s$/);
  const machine = await client.getMachine(done.machineId!);
  assert.equal(machine?.state, 'stopped');
  const started = await client.waitOperation(await client.start(machine!.id, 'key-start'), Date.now() + 10_000);
  assert.equal(started.state, 'succeeded');
  assert.equal((await client.getMachine(machine!.id))?.state, 'running');
});

test('an operation that never finishes times out with a retryable error', async () => {
  fake.pollsToFinish = 1000;
  const op = await client.createMachine(input('sef-s-4'), 'key-slow');
  const error = await rejectsWith(client.waitOperation(op, Date.now() + 50), 'timeout');
  assert.equal(error.retryable, true);
  assert.equal(error.operationId, op.id);
});

test('no_capacity: a failed create operation and a synchronous 503 both map to retryable no_capacity', async () => {
  fake.noCapacity = 1;
  const op = await client.createMachine(input('sef-s-5'), 'key-cap-op');
  const error = await rejectsWith(client.waitOperation(op, Date.now() + 5_000), 'no_capacity');
  assert.equal(error.retryable, true);
  assert.equal(fake.machines.size, 0, 'Instabox removes the failed sandbox');

  fake.noCapacity = 1;
  fake.noCapacityMode = 'http';
  const sync = await rejectsWith(client.createMachine(input('sef-s-5'), 'key-cap-http'), 'no_capacity');
  assert.equal(sync.status, 503);
  assert.equal(sync.retryable, true);
  assert.equal(sync.definiteRefusal, true);
  fake.noCapacityMode = 'op';
  // The replay of a refused key returns the refusal again: a retry needs a fresh key.
  fake.noCapacity = 0;
  await rejectsWith(client.createMachine(input('sef-s-5'), 'key-cap-http'), 'no_capacity');
});

test('quota_exceeded counts every machine on the account, not just ours', async () => {
  fake.quota = 2;
  fake.addForeignMachine();
  await client.createMachine(input('sef-s-6'), 'key-q-1');
  const error = await rejectsWith(client.createMachine(input('sef-s-7'), 'key-q-2'), 'quota_exceeded');
  assert.equal(error.status, 429);
  assert.equal(error.retryable, false);
});

test('error mapping: machine_not_running, operation_conflict, no body, and a dropped connection', async () => {
  const op = await client.waitOperation(await client.createMachine(input('sef-s-8'), 'key-e'), Date.now() + 5_000);
  const id = op.machineId!;
  await rejectsWith(client.exec(id, { cmd: 'true' }), 'machine_not_running');

  fake.pollsToFinish = 100;
  await client.start(id, 'key-e-start');
  const conflict = await rejectsWith(client.deleteMachine(id, 'key-e-del'), 'operation_conflict');
  assert.equal(conflict.status, 409);
  assert.ok(conflict.operationId);

  fake.injections.push({ match: (r) => r.path.startsWith('/v1/machines/'), respond: 'drop' });
  const dropped = await rejectsWith(client.getMachine(id), 'network');
  assert.equal(dropped.status, 0);
  assert.equal(dropped.retryable, true);
  assert.equal(dropped.definiteRefusal, false);
});

test('exec and publish carry no Idempotency-Key; exec values travel in envs and the timeout is capped', async () => {
  fake.createdState = 'running';
  const op = await client.waitOperation(await client.createMachine(input('sef-s-9'), 'key-x'), Date.now() + 5_000);
  fake.createdState = 'stopped';
  const result = await client.exec(op.machineId!, { cmd: 'bash run.sh', envs: { TOKEN: 'secret' }, timeoutSeconds: 600 });
  assert.equal(result.exitCode, 0);
  const [exec] = fake.requests('POST', `/v1/machines/${op.machineId}/exec`);
  assert.equal(exec!.headers['idempotency-key'], undefined);
  assert.deepEqual(exec!.body, { cmd: 'bash run.sh', envs: { TOKEN: 'secret' }, timeoutSeconds: 58 });
  const port = await client.createPort(op.machineId!, 4100, 'engine');
  assert.match(port.url, /\/engine\/m_/);
  assert.equal(fake.requests('POST', `/v1/machines/${op.machineId}/ports`)[0]!.headers['idempotency-key'], undefined);
});

test('listMachines filters by metadata and follows pagination', async () => {
  fake.pageSize = 2;
  for (let i = 0; i < 3; i += 1) fake.addForeignMachine({ app: 'sef-session', session: `s${i}` });
  fake.addForeignMachine({ app: 'other' });
  fake.addForeignMachine();
  const ours = await client.listMachines({ app: 'sef-session' });
  assert.equal(ours.length, 3);
  assert.equal(fake.requests('GET', '/v1/machines?').length, 2);
  assert.equal((await client.listMachines({ app: 'sef-session', session: 's1' })).length, 1);
  fake.pageSize = 50;
});

test('a deleted machine reads as null and a repeated delete is a no-op', async () => {
  fake.pollsToFinish = 0;
  const op = await client.createMachine(input('sef-s-10'), 'key-d');
  const id = op.machineId!;
  const deleted = await client.deleteMachine(id, 'key-d-1');
  assert.equal(deleted?.state, 'succeeded');
  assert.equal(await client.getMachine(id), null);
  assert.equal(await client.deleteMachine(id, 'key-d-2'), null);
});

test('the key never leaks: wrong key maps to unauthenticated, and neither errors nor JSON carry it', async () => {
  const wrong = new InstaboxClient({ apiKey: 'ibk_wrong_key_value', baseUrl: fake.base });
  const error = await rejectsWith(wrong.listMachines({ app: 'sef-session' }), 'unauthenticated');
  assert.equal(JSON.stringify({ ...error, message: error.message }).includes('ibk_wrong_key_value'), false);
  assert.equal(JSON.stringify(wrong).includes('ibk_'), false);
  assert.equal(String(Object.values(wrong)).includes('ibk_'), false);
  assert.throws(() => new InstaboxClient({ apiKey: '' }), /INSTABOX_API_KEY/);
});

test('ids are validated before they reach a URL path', async () => {
  await rejectsWith(client.getMachine('m_../../v1/keys'), 'invalid_input');
  await rejectsWith(client.getMachine('box-c0ab84'), 'invalid_input');
  await rejectsWith(client.createMachine({ ...input('Bad Name'), name: 'Bad Name' }, 'k'), 'invalid_input');
  assert.equal(fake.seen.length, 0);
});
