import assert from 'node:assert/strict';
import { test } from 'node:test';
import { SeatError, type BootstrapStatus, type SeatClient, type SeatMachine, type SeatOperation } from '@/lib/instabox';
import { ClaimRunner, type ClaimConfig, type ClaimProgress, type ProgressStore } from './claim';

/**
 * The checklist against a fake Instabox account: machines, idempotent creates, a quota, a
 * capacity switch, and a box whose bootstrap advances one status poll at a time. Each failure
 * test then retries and checks the flow resumes without duplicating anything.
 */

type Fault = { code: string; status: number; retryable?: boolean };
const fault = ({ code, status, retryable = false }: Fault) => new SeatError({ code, message: `fake ${code}`, status, retryable });

class FakeAccount {
  machines: SeatMachine[] = [];
  creates: Array<{ name: string; key: string }> = [];
  replays = new Map<string, SeatOperation>();
  powers: Array<{ action: string; key: string }> = [];
  launches = 0;
  activated = true;
  savedKey: string | null = 'ibk_already_saved_key';
  opPolls = 1;
  /** One-shot failures by method name. */
  failNext = new Map<string, Fault>();
  createFault: Fault | null = null;
  bootstrapPlan: string[] = ['running', 'running', 'done'];
  bootstrapState = 'absent';
  healthPlan: number[] = [502, 200];
  private pending = new Map<string, number>();

  private trip(method: string) {
    const f = this.failNext.get(method);
    if (f) {
      this.failNext.delete(method);
      throw fault(f);
    }
  }

  private machineById(id: string) {
    const m = this.machines.find((x) => x.id === id);
    if (!m) throw fault({ code: 'not_found', status: 404 });
    return m;
  }

  client(): SeatClient {
    return {
      saveKey: async (key) => {
        this.trip('saveKey');
        this.savedKey = key;
      },
      hasKey: async () => this.savedKey !== null,
      forgetKey: async () => {
        this.savedKey = null;
      },
      account: async () => {
        this.trip('account');
        if (!this.savedKey) throw fault({ code: 'key_missing', status: 0 });
        return { login: 'student', activated: this.activated, inviteRequired: true };
      },
      listSeats: async () => {
        this.trip('listSeats');
        return this.machines.map((m) => ({ ...m }));
      },
      createSeat: async (name, key) => {
        this.creates.push({ name, key });
        const replay = this.replays.get(key);
        if (replay) return replay;
        if (this.createFault) {
          const f = this.createFault;
          this.createFault = null;
          throw fault(f);
        }
        if (this.machines.length >= 5) throw fault({ code: 'quota_exceeded', status: 429 });
        const id = `m_${String(this.machines.length + 1).padStart(26, '0')}`;
        this.machines.push({ id, name, state: 'creating', runtime: { ready: false } });
        const op: SeatOperation = { id: `op_${id.slice(2)}`, machineId: id, type: 'create', state: 'queued' };
        this.pending.set(op.id, this.opPolls);
        this.replays.set(key, op);
        this.trip('createSeatAfterCommit');
        return op;
      },
      operation: async (opId) => {
        const left = this.pending.get(opId) ?? 0;
        this.pending.set(opId, left - 1);
        if (left > 0) return { id: opId, type: 'create', state: 'running', phase: 'booting' };
        const m = this.machines.find((x) => x.id === `m_${opId.slice(3)}`);
        if (m) Object.assign(m, { state: 'running', runtime: { ready: true } });
        return { id: opId, type: 'create', state: 'succeeded' };
      },
      machine: async (id) => ({ ...this.machineById(id) }),
      power: async (id, action, key) => {
        this.powers.push({ action, key });
        Object.assign(this.machineById(id), { state: 'running', runtime: { ready: true } });
        return { id: 'op_power', type: action, state: 'succeeded' };
      },
      publish: async (id) => {
        this.trip('publish');
        return { port: 4100, url: `https://4100-${id.slice(2)}.instabox.tech` };
      },
      startBootstrap: async (id) => {
        if (this.machineById(id).state !== 'running') throw fault({ code: 'machine_not_running', status: 409 });
        this.launches += 1;
        this.bootstrapState = 'starting';
        return 'started';
      },
      bootstrapStatus: async (id): Promise<BootstrapStatus> => {
        if (this.machineById(id).state !== 'running') throw fault({ code: 'machine_not_running', status: 409 });
        if (this.bootstrapState === 'absent' || this.bootstrapState === 'done' || this.bootstrapState.startsWith('failed:')) {
          return { state: this.bootstrapState, running: false, steps: [], logTail: '' };
        }
        const next = this.bootstrapPlan.shift() ?? 'done';
        this.bootstrapState = next;
        return { state: next, running: next === 'running', steps: [{ name: 'build', state: next === 'done' ? 'done' : 'running', seconds: null }], logTail: 'log' };
      },
      health: async () => {
        const status = this.healthPlan.length > 1 ? this.healthPlan.shift()! : (this.healthPlan[0] ?? 200);
        return { ok: status === 200, status };
      },
    };
  }
}

function memoryStore(): ProgressStore & { value: ClaimProgress } {
  return {
    value: {},
    load() {
      return { ...this.value };
    },
    save(p) {
      this.value = { ...p };
    },
    clear() {
      this.value = {};
    },
  };
}

const CONFIG: ClaimConfig = { machineName: 'sef-seat', gitRef: 'main', uniUrl: 'https://uni.example.test' };
let counter = 0;

function runner(account: FakeAccount, store = memoryStore(), remembered: Array<{ engineUrl: string; machineId: string }> = []) {
  const r = new ClaimRunner({
    client: account.client(),
    store,
    remember: (seat) => remembered.push(seat),
    newKey: () => `key-${++counter}`,
    sleep: async () => {},
    timing: { bootstrapStartGraceMs: Number.POSITIVE_INFINITY },
  });
  return { r, store, remembered };
}

test('a clean account goes from key to a remembered seat in one run', async () => {
  const account = new FakeAccount();
  account.savedKey = null;
  const { r, remembered, store } = runner(account);
  const view = await r.run({ ...CONFIG, key: 'ibk_fresh_student_key' });
  assert.equal(view.complete, true, JSON.stringify(view.failure));
  assert.ok(Object.values(view.steps).every((s) => s === 'done'));
  assert.equal(account.savedKey, 'ibk_fresh_student_key');
  assert.equal(account.creates.length, 1);
  assert.equal(account.launches, 1);
  assert.deepEqual(remembered, [{ engineUrl: `https://4100-${'1'.padStart(26, '0')}.instabox.tech`, machineId: account.machines[0]!.id }]);
  assert.deepEqual(store.value, {}, 'finished progress is cleared');
  assert.ok(!JSON.stringify(store.value).includes('ibk_'), 'progress never holds the key');
});

test('no key in the keychain stops at the key step', async () => {
  const account = new FakeAccount();
  account.savedKey = null;
  const view = await runner(account).r.run(CONFIG);
  assert.equal(view.steps.key, 'error');
  assert.equal(view.failure?.code, 'key_missing');
  assert.equal(account.creates.length, 0);
});

test('an unactivated account is told to redeem its invite, and a retry passes once it has', async () => {
  const account = new FakeAccount();
  account.activated = false;
  const { r } = runner(account);
  let view = await r.run(CONFIG);
  assert.equal(view.failure?.code, 'invite_required');
  assert.match(view.failure!.message, /invite/i);
  account.activated = true;
  view = await r.retry(CONFIG);
  assert.equal(view.complete, true);
});

test('a key without machine scope is surfaced as insufficient_scope', async () => {
  const account = new FakeAccount();
  account.failNext.set('listSeats', { code: 'insufficient_scope', status: 403 });
  const { r } = runner(account);
  const view = await r.run(CONFIG);
  assert.equal(view.steps.machine, 'error');
  assert.equal(view.failure?.code, 'insufficient_scope');
  assert.match(view.failure!.message, /machines:write/);
  assert.equal((await r.retry(CONFIG)).complete, true);
});

test('the list precheck adopts an existing seat instead of creating a second', async () => {
  const account = new FakeAccount();
  account.machines.push({ id: `m_${'7'.padStart(26, '0')}`, name: 'sef-seat-old', state: 'running', runtime: { ready: true } });
  const view = await runner(account).r.run(CONFIG);
  assert.equal(view.complete, true);
  assert.equal(account.creates.length, 0);
  assert.equal(account.machines.length, 1);
});

test('a create whose response was lost is retried with the same Idempotency-Key and replays', async () => {
  const account = new FakeAccount();
  // The machine is created, then the reply never arrives (status 0: outcome unknown).
  account.failNext.set('createSeatAfterCommit', { code: 'network', status: 0, retryable: true });
  const { r } = runner(account);
  // Worst case: the list right after the loss does not show the new machine yet.
  (r as unknown as { deps: { client: SeatClient } }).deps.client.listSeats = async () => [];
  let view = await r.run(CONFIG);
  assert.equal(view.failure?.code, 'network');
  view = await r.retry(CONFIG);
  assert.equal(view.complete, true, JSON.stringify(view.failure));
  assert.equal(account.creates.length, 2);
  assert.equal(account.creates[0]!.key, account.creates[1]!.key, 'same key on the retry');
  assert.equal(account.machines.length, 1, 'the replay made no second machine');
});

test('no_capacity is surfaced honestly and the retry uses a fresh key', async () => {
  const account = new FakeAccount();
  account.createFault = { code: 'no_capacity', status: 503, retryable: true };
  const { r } = runner(account);
  let view = await r.run(CONFIG);
  assert.equal(view.failure?.code, 'no_capacity');
  assert.match(view.failure!.message, /no free capacity/i);
  assert.equal(account.machines.length, 0);
  view = await r.retry(CONFIG);
  assert.equal(view.complete, true);
  assert.notEqual(account.creates[0]!.key, account.creates[1]!.key, 'a refused create is not replayed');
});

test('quota_exceeded is surfaced with what to do about it', async () => {
  const account = new FakeAccount();
  account.createFault = { code: 'quota_exceeded', status: 429 };
  const view = await runner(account).r.run(CONFIG);
  assert.equal(view.steps.machine, 'error');
  assert.equal(view.failure?.code, 'quota_exceeded');
  assert.match(view.failure!.message, /machine limit/);
});

test('a flow interrupted after create resumes in a new window without a duplicate', async () => {
  const account = new FakeAccount();
  account.failNext.set('publish', { code: 'network', status: 0, retryable: true });
  const store = memoryStore();
  const first = await runner(account, store).r.run(CONFIG);
  assert.equal(first.steps.publish, 'error');
  assert.equal(store.value.doneThrough, 'ready');

  // The app restarts: a new runner over the same stored progress.
  const second = runner(account, store);
  assert.equal(second.r.state.steps.machine, 'done', 'finished steps show as done before the retry');
  const view = await second.r.run(CONFIG);
  assert.equal(view.complete, true);
  assert.equal(account.creates.length, 1);
  assert.equal(account.machines.length, 1);
});

test('a stopped box is started with a persisted key, then setup continues', async () => {
  const account = new FakeAccount();
  account.machines.push({ id: `m_${'3'.padStart(26, '0')}`, name: 'sef-seat', state: 'stopped', runtime: { ready: false } });
  const view = await runner(account).r.run(CONFIG);
  assert.equal(view.complete, true);
  assert.deepEqual(account.powers.map((p) => p.action), ['start']);
});

test('machine_not_running mid-bootstrap sends the retry back to the ready step', async () => {
  const account = new FakeAccount();
  const { r } = runner(account);
  account.bootstrapPlan = ['running'];
  const client = (r as unknown as { deps: { client: SeatClient } }).deps.client;
  const status = client.bootstrapStatus;
  let polls = 0;
  client.bootstrapStatus = async (id) => {
    polls += 1;
    if (polls === 2) {
      account.machines[0]!.state = 'suspended';
    }
    return status(id);
  };
  let view = await r.run(CONFIG);
  assert.equal(view.steps.bootstrap, 'error');
  assert.equal(view.failure?.code, 'machine_not_running');
  assert.equal(view.failure?.retryFrom, 'ready');
  view = await r.retry(CONFIG);
  assert.equal(view.complete, true, JSON.stringify(view.failure));
  assert.deepEqual(account.powers.map((p) => p.action), ['resume']);
});

test('a failed bootstrap step is named, and the retry relaunches the script', async () => {
  const account = new FakeAccount();
  account.bootstrapPlan = ['running', 'failed:build'];
  const { r } = runner(account);
  let view = await r.run(CONFIG);
  assert.equal(view.failure?.code, 'bootstrap_failed');
  assert.match(view.failure!.message, /"build"/);
  account.bootstrapPlan = ['running', 'done'];
  view = await r.retry(CONFIG);
  assert.equal(view.complete, true);
  assert.equal(account.launches, 2);
});

test('a bootstrap already running is joined, not launched again', async () => {
  const account = new FakeAccount();
  account.machines.push({ id: `m_${'4'.padStart(26, '0')}`, name: 'sef-seat', state: 'running', runtime: { ready: true } });
  account.bootstrapState = 'running';
  account.bootstrapPlan = ['running', 'running', 'done'];
  const view = await runner(account).r.run(CONFIG);
  assert.equal(view.complete, true);
  assert.equal(account.launches, 0);
});

test('a finished bootstrap is not re-run on a resumed flow', async () => {
  const account = new FakeAccount();
  account.machines.push({ id: `m_${'5'.padStart(26, '0')}`, name: 'sef-seat', state: 'running', runtime: { ready: true } });
  account.bootstrapState = 'done';
  const view = await runner(account).r.run(CONFIG);
  assert.equal(view.complete, true);
  assert.equal(account.launches, 0);
});

test('health waits through 502 while the engine starts', async () => {
  const account = new FakeAccount();
  account.healthPlan = [502, 502, 0, 200];
  const view = await runner(account).r.run(CONFIG);
  assert.equal(view.complete, true);
});

test('health 503 means the box went offline; the retry starts from the ready step', async () => {
  const account = new FakeAccount();
  account.healthPlan = [503, 200];
  const { r } = runner(account);
  let view = await r.run(CONFIG);
  assert.equal(view.steps.health, 'error');
  assert.equal(view.failure?.retryFrom, 'ready');
  view = await r.retry(CONFIG);
  assert.equal(view.complete, true);
});

test('a corrected key re-runs the key step even after later steps finished', async () => {
  const account = new FakeAccount();
  const store = memoryStore();
  store.value = { doneThrough: 'machine', machineId: 'm_x' };
  account.failNext.set('account', { code: 'api_key_revoked', status: 401 });
  const { r } = runner(account, store);
  let view = await r.run(CONFIG, 'key');
  assert.equal(view.failure?.code, 'api_key_revoked');
  assert.match(view.failure!.message, /did not accept that key/);
  view = await r.run({ ...CONFIG, key: 'ibk_the_new_one_123' });
  assert.equal(account.savedKey, 'ibk_the_new_one_123');
  assert.notEqual(view.failure?.code, 'api_key_revoked');
});
