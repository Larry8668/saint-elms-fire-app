import assert from 'node:assert/strict';
import { test } from 'node:test';
import { SESSION_STEP_LABELS, SESSION_STEPS, type SessionStep, type StudentSessionStatus } from '@sef/shared';
import {
  handoffUrl,
  HANDOFF_TIMEOUT_MS,
  healthVerdict,
  MAX_POLL_FAILURES,
  QUEUE_POLL_MS,
  runWorkspaceFlow,
  safeWorkspaceUrl,
  waitForWorkspace,
  type FlowDeps,
  type WorkspaceFlow,
} from './session-flow';

const URL_ = 'https://4100-abc.instabox.tech';

function session(state: StudentSessionStatus['state'], extra: Partial<StudentSessionStatus> = {}, at: SessionStep | null = null): StudentSessionStatus {
  const index = at ? SESSION_STEPS.indexOf(at) : state === 'ready' ? SESSION_STEPS.length : -1;
  return {
    id: 'ses_1',
    state,
    step: at,
    steps: SESSION_STEPS.map((name, i) => ({ name, label: SESSION_STEP_LABELS[name], status: i < index ? 'done' : i === index ? 'active' : 'pending' })),
    createdAt: '2026-10-17T10:00:00.000Z',
    ...extra,
  };
}

const healthy = { status: 200, body: { ok: true, engine: '0.2.0', uni: { reachable: true } } };

/** A fake clock and scripted university/VM answers; `sleep` advances time instantly. */
function harness(opts: {
  start: Array<StudentSessionStatus | { status: number; code: string }>;
  polls: Array<StudentSessionStatus | null | { status: number; code: string }>;
  health?: Array<{ status: number; body: unknown } | null>;
}) {
  let clock = 0;
  const sleeps: number[] = [];
  const probed: string[] = [];
  const calls: string[] = [];
  const health = opts.health ?? [healthy];
  const next = <T>(list: T[], label: string): T => {
    calls.push(label);
    return (list.length > 1 ? list.shift() : list[0]) as T;
  };
  const deps: FlowDeps = {
    start: async () => {
      const answer = next(opts.start, 'POST');
      if ('code' in answer && !('state' in answer)) throw answer;
      return answer as StudentSessionStatus;
    },
    status: async () => {
      const answer = next(opts.polls, 'GET');
      if (answer && 'code' in answer && !('state' in answer)) throw answer;
      return answer as StudentSessionStatus | null;
    },
    probe: async (url) => {
      probed.push(url);
      return health.length > 1 ? health.shift()! : health[0]!;
    },
    sleep: async (ms) => {
      sleeps.push(ms);
      clock += ms;
    },
    now: () => clock,
  };
  const states: WorkspaceFlow[] = [];
  return { deps, states, emit: (s: WorkspaceFlow) => states.push(s), sleeps, probed, calls, elapsed: () => clock };
}

const phases = (states: WorkspaceFlow[]) => states.map((s) => s.phase).filter((p, i, all) => p !== all[i - 1]);

test('queued → spawning through the real steps → ready → browser health → hand-off', async () => {
  const h = harness({
    start: [session('queued', { position: 2 })],
    polls: [
      session('queued', { position: 1 }),
      session('spawning', {}, 'create'),
      session('spawning', {}, 'start'),
      session('spawning', {}, 'publish'),
      session('spawning', {}, 'session_start'),
      session('spawning', {}, 'health'),
      session('ready', { url: URL_ }),
    ],
  });
  const final = await runWorkspaceFlow(h.deps, h.emit);
  assert.deepEqual(final, { phase: 'ready', url: URL_ });
  assert.deepEqual(phases(h.states), ['requesting', 'queued', 'spawning', 'connecting', 'ready']);
  const queued = h.states.filter((s) => s.phase === 'queued').map((s) => s.phase === 'queued' && s.position);
  assert.deepEqual(queued, [2, 1], 'the queue position is shown as the university reports it');
  const active = h.states.flatMap((s) => (s.phase === 'spawning' ? [s.steps.find((x) => x.status === 'active')?.label] : []));
  assert.deepEqual(active, ['Creating your workspace', 'Starting it up', 'Giving it an address', 'Starting your study engine', 'Restoring your vault']);
  assert.deepEqual(h.probed, [URL_], 'the browser checks the VM itself before leaving');
  assert.equal(h.sleeps.filter((ms) => ms === QUEUE_POLL_MS).length, 2, 'a queue is polled more gently than a spawn');
});

test('waiting for Instabox capacity is said plainly while spawning', async () => {
  const h = harness({
    start: [session('spawning', { error: { code: 'no_capacity', message: 'Waiting for capacity', retryable: true } }, 'create')],
    polls: [session('ready', { url: URL_ })],
  });
  await runWorkspaceFlow(h.deps, h.emit);
  const spawning = h.states.find((s) => s.phase === 'spawning');
  assert.equal(spawning?.phase === 'spawning' && spawning.waitingForCapacity, true);
});

test('a failed spawn is a clear failure that can be retried, and a retry starts over with a new POST', async () => {
  const h = harness({ start: [session('spawning', {}, 'create')], polls: [session('failed', { error: { code: 'spawn_failed', message: 'x', retryable: false } })] });
  assert.deepEqual(await runWorkspaceFlow(h.deps, h.emit), { phase: 'failed', reason: 'spawn_failed', retryable: true });

  const retry = harness({ start: [session('ready', { url: URL_ })], polls: [null] });
  assert.equal((await runWorkspaceFlow(retry.deps, retry.emit)).phase, 'ready');
  assert.deepEqual(retry.calls, ['POST'], 'a ready session needs no polling');
});

test('a previous session still saving is waited out, then a new one is requested', async () => {
  const h = harness({
    start: [session('stopping'), session('spawning', {}, 'create')],
    polls: [session('stopping'), session('ended'), session('ready', { url: URL_ })],
  });
  assert.equal((await runWorkspaceFlow(h.deps, h.emit)).phase, 'ready');
  assert.deepEqual(h.calls, ['POST', 'GET', 'GET', 'POST', 'GET']);
  assert.deepEqual(phases(h.states), ['requesting', 'previous-stopping', 'spawning', 'connecting', 'ready']);
});

test('refusals map to honest, non-retryable failures', async () => {
  const cases: Array<[{ status: number; code: string }, string, boolean]> = [
    [{ status: 503, code: 'session_orchestrator_unavailable' }, 'unavailable', false],
    [{ status: 403, code: 'unapproved' }, 'unapproved', false],
    [{ status: 409, code: 'account_unsupported' }, 'unapproved', false],
    [{ status: 401, code: 'unauthenticated' }, 'signed_out', false],
    [{ status: 0, code: 'network_unavailable' }, 'network', true],
  ];
  for (const [error, reason, retryable] of cases) {
    const h = harness({ start: [error], polls: [null] });
    assert.deepEqual(await runWorkspaceFlow(h.deps, h.emit), { phase: 'failed', reason, retryable }, error.code);
  }
});

test('a few dropped polls are ridden out; many in a row end the wait', async () => {
  const drop = { status: 0, code: 'network_unavailable' };
  const ok = harness({ start: [session('spawning', {}, 'create')], polls: [drop, drop, session('ready', { url: URL_ })] });
  assert.equal((await runWorkspaceFlow(ok.deps, ok.emit)).phase, 'ready');

  const bad = harness({ start: [session('spawning', {}, 'create')], polls: [drop] });
  assert.deepEqual(await runWorkspaceFlow(bad.deps, bad.emit), { phase: 'failed', reason: 'network', retryable: true });
  assert.equal(bad.calls.filter((c) => c === 'GET').length, MAX_POLL_FAILURES);
});

test('a session that ends while the page watches says so', async () => {
  const h = harness({ start: [session('queued', { position: 1 })], polls: [session('ended')] });
  assert.deepEqual(await runWorkspaceFlow(h.deps, h.emit), { phase: 'failed', reason: 'ended', retryable: true });
});

test('a ready answer with an unsafe URL is never followed', async () => {
  for (const url of ['javascript:alert(1)', 'http://4100-abc.instabox.tech', 'https://user:pw@evil.test', undefined]) {
    const h = harness({ start: [session('ready', { url })], polls: [null] });
    assert.equal((await runWorkspaceFlow(h.deps, h.emit)).phase, 'failed', String(url));
    assert.equal(h.probed.length, 0);
  }
  assert.equal(safeWorkspaceUrl('http://127.0.0.1:3512/'), 'http://127.0.0.1:3512', 'a local engine under test');
});

test('aborting stops the flow without emitting anything more', async () => {
  const controller = new AbortController();
  const h = harness({ start: [session('spawning', {}, 'create')], polls: [session('spawning', {}, 'start')] });
  const states: WorkspaceFlow[] = [];
  const running = runWorkspaceFlow(
    { ...h.deps, sleep: async () => controller.abort() },
    (s) => states.push(s),
    controller.signal,
  );
  await running;
  assert.deepEqual(phases(states), ['requesting', 'spawning']);
});

test('health verdict: ok is required, and sync.state must be ready when present', () => {
  assert.equal(healthVerdict(healthy), 'ready', 'an engine without a sync field is ready once ok');
  assert.equal(healthVerdict({ status: 200, body: { ok: true, sync: { state: 'ready' } } }), 'ready');
  assert.equal(healthVerdict({ status: 200, body: { ok: true, sync: { state: 'restoring' } } }), 'restoring');
  assert.equal(healthVerdict({ status: 200, body: { ok: true, sync: { state: 'error' } } }), 'sync_error');
  assert.equal(healthVerdict({ status: 200, body: { ok: true, sync: {} } }), 'restoring', 'an unknown sync state is not ready');
  assert.equal(healthVerdict({ status: 200, body: { ok: false } }), 'down');
  assert.equal(healthVerdict({ status: 502, body: null }), 'down');
  assert.equal(healthVerdict(null), 'down');
});

test('the hand-off waits through restoring, then leaves; a sync error or silence fails it', async () => {
  const restoring = { status: 200, body: { ok: true, sync: { state: 'restoring' } } };
  const h = harness({
    start: [session('ready', { url: URL_ })],
    polls: [null],
    health: [null, { status: 502, body: null }, restoring, restoring, { status: 200, body: { ok: true, sync: { state: 'ready' } } }],
  });
  assert.equal((await runWorkspaceFlow(h.deps, h.emit)).phase, 'ready');
  const restoringFlags = h.states.flatMap((s) => (s.phase === 'connecting' ? [s.restoring] : []));
  assert.deepEqual(restoringFlags, [false, true], '"Restoring your notes" shows while the engine restores');

  const broken = harness({ start: [session('ready', { url: URL_ })], polls: [null], health: [{ status: 200, body: { ok: true, sync: { state: 'error' } } }] });
  assert.deepEqual(await runWorkspaceFlow(broken.deps, broken.emit), { phase: 'failed', reason: 'sync_error', retryable: true });

  const silent = harness({ start: [session('ready', { url: URL_ })], polls: [null], health: [null] });
  assert.equal(await waitForWorkspace(URL_, silent.deps, () => {}), 'unreachable');
  assert.ok(silent.elapsed() >= HANDOFF_TIMEOUT_MS && silent.elapsed() < HANDOFF_TIMEOUT_MS + 2_000);
});

const failedError = { code: 'spawn_failed', message: 'Your workspace could not start.', retryable: true, reason: 'The engine could not restore the vault.' };

test('a failed spawn shows the reason the university gave and does not ask again', async () => {
  const h = harness({ start: [session('spawning', {}, 'health')], polls: [session('failed', { error: failedError }, 'health')] });
  assert.deepEqual(await runWorkspaceFlow(h.deps, h.emit), { phase: 'failed', reason: 'spawn_failed', retryable: true, detail: 'The engine could not restore the vault.' });
  assert.equal(h.calls.filter((c) => c === 'POST').length, 1);
});

test('a spawn being torn down after failing is reported at once, not waited out and retried', async () => {
  const h = harness({ start: [session('spawning', {}, 'create')], polls: [session('stopping', { error: failedError }, 'health')] });
  const final = await runWorkspaceFlow(h.deps, h.emit);
  assert.equal(final.phase === 'failed' && final.reason, 'spawn_failed');
  assert.deepEqual(h.calls, ['POST', 'GET']);
});

test('every spawn failing never loops: at most one automatic new request', async () => {
  // Tonight: POST, stopping (old session), ended, POST, stopping, failed, POST ... for ever.
  const h = harness({
    start: [session('stopping'), session('spawning', {}, 'create')],
    polls: [session('ended'), session('stopping'), session('failed', { error: failedError })],
  });
  const final = await runWorkspaceFlow(h.deps, h.emit);
  assert.equal(final.phase === 'failed' && final.reason, 'spawn_failed');
  assert.ok(h.calls.filter((c) => c === 'POST').length <= 2, `POSTs: ${h.calls.join(',')}`);
  assert.ok(h.calls.length < 10, 'the flow terminated');
});

test('a second previous-session stop does not trigger a second automatic restart', async () => {
  const h = harness({ start: [session('stopping'), session('stopping')], polls: [session('ended')] });
  const final = await runWorkspaceFlow(h.deps, h.emit);
  assert.deepEqual(final, { phase: 'failed', reason: 'ended', retryable: true });
  assert.equal(h.calls.filter((c) => c === 'POST').length, 2);
});

test('the hand-off goes to the web app with the workspace in ?workspace= when VITE_APP_URL is set, else to the VM', () => {
  const vm = 'https://4100-m1abc.instabox.tech';
  assert.equal(handoffUrl(vm, 'https://sef.vercel.app'), 'https://sef.vercel.app/?workspace=https%3A%2F%2F4100-m1abc.instabox.tech');
  assert.equal(handoffUrl(vm, 'https://sef.vercel.app/'), 'https://sef.vercel.app/?workspace=https%3A%2F%2F4100-m1abc.instabox.tech');
  assert.equal(new URL(handoffUrl(vm, 'https://sef.vercel.app')).searchParams.get('workspace'), vm, 'the app reads back exactly the VM url');
  for (const unset of [undefined, '', '  ']) assert.equal(handoffUrl(vm, unset), vm, 'unset: the VM serves its own UI, as before');
});

test('the hand-off carries the demo persona only when one is given', () => {
  const vm = 'https://4100-m1abc.instabox.tech';
  assert.equal(handoffUrl(vm, 'https://sef.vercel.app', 'ananya'), 'https://sef.vercel.app/?workspace=https%3A%2F%2F4100-m1abc.instabox.tech&demo=ananya');
  assert.equal(handoffUrl(vm, undefined, 'ananya'), vm);
});
