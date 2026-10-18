import type { Pool } from 'pg';
import { SESSION_STEP_LABELS, SESSION_STEPS, type AdminSessionRow, type SessionStep, type StudentSessionStatus } from '@sef/shared';
import { mintGatewayToken } from '@sef/shared/node';
import { InstaboxError, isMachineId, type InstaboxClient, type Machine } from '../instabox/client';
import { errorFields, log } from '../logger';
import type { SessionConfig } from './config';
import {
  acquireLease,
  latestSession,
  liveSession,
  newIdempotencyKey,
  promoteQueued,
  queuePosition,
  sessionById,
  sessionsInState,
  updateSession,
  heartbeat as touchHeartbeat,
  type Account,
  type SessionRow,
} from './store';

/** The label every session VM carries. The reaper and the orphan sweep act on nothing else. */
export const SESSION_APP_LABEL = 'sef-session';
export const ENGINE_PORT = 4100;
const CAPACITY_CODES = new Set(['no_capacity', 'quota_exceeded']);

export interface HealthProbe {
  status: number;
  body: unknown;
}

export interface OrchestratorDeps {
  pool: Pool;
  client: InstaboxClient;
  config: SessionConfig;
  /** GET <session url>/api/health; tests point it at the fake. */
  probeHealth?: (url: string) => Promise<HealthProbe>;
  sleep?: (ms: number) => Promise<void>;
  /** Poll spacing inside a step (machine state, health). */
  pollMs?: number;
}

/** The row moved on (a logout or a force-end) while a spawn was driving it: stop quietly. */
class Superseded extends Error {}

/** A spawn failure with a code safe to show a student and a detail for staff and logs. */
class SpawnError extends Error {
  constructor(readonly code: string, message: string) {
    super(message);
  }
}

const describe = (error: unknown): string => {
  if (error instanceof InstaboxError || error instanceof SpawnError) return `${error.code}: ${error.message}`.slice(0, 500);
  return `internal: ${(error as Error)?.name ?? 'Error'}`;
};

async function defaultProbe(url: string): Promise<HealthProbe> {
  const response = await fetch(`${url}/api/health`, { signal: AbortSignal.timeout(10_000), redirect: 'error' });
  const text = await response.text();
  let body: unknown = null;
  try {
    body = JSON.parse(text);
  } catch {
    // The edge answers 502/503 with HTML or text while the engine is not up.
  }
  return { status: response.status, body };
}

const FLUSH_RETRYABLE = new Set(['push_failed', 'timeout']);

/** The `error` of the last JSON line session-stop.sh printed, when it is a known short code. */
export function flushErrorCode(stdout: string): string | null {
  const lines = stdout.trim().split('\n').reverse();
  for (const line of lines) {
    try {
      const body = JSON.parse(line) as { ok?: unknown; error?: unknown };
      if (body && body.ok === false && typeof body.error === 'string' && /^[a-z_]{1,40}$/.test(body.error)) return body.error;
      return null;
    } catch {
      // Not the JSON line: keep looking upwards.
    }
  }
  return null;
}

/** Last lines of a script's output for the log. session-start.sh/session-stop.sh print names, never values. */
const tail = (text: string | undefined, max = 600) => (text ?? '').trim().slice(-max);

/** Ready = public health answers ok, and either sync is restored or the engine predates sync (no field). */
export function healthVerdict(probe: HealthProbe): 'ready' | 'waiting' | 'sync_error' {
  if (probe.status !== 200 || typeof probe.body !== 'object' || probe.body === null) return 'waiting';
  const body = probe.body as { ok?: unknown; sync?: { state?: unknown } };
  if (body.ok !== true) return 'waiting';
  if (body.sync === undefined) return 'ready';
  if (body.sync?.state === 'ready') return 'ready';
  if (body.sync?.state === 'error') return 'sync_error';
  return 'waiting';
}

export class SessionOrchestrator {
  private readonly pool: Pool;
  private readonly client: InstaboxClient;
  readonly config: SessionConfig;
  private readonly probe: (url: string) => Promise<HealthProbe>;
  private readonly sleep: (ms: number) => Promise<void>;
  private readonly pollMs: number;
  private readonly driving = new Map<string, Promise<void>>();
  private readonly tearing = new Map<string, Promise<void>>();

  constructor(deps: OrchestratorDeps) {
    this.pool = deps.pool;
    this.client = deps.client;
    this.config = deps.config;
    this.probe = deps.probeHealth ?? defaultProbe;
    this.sleep = deps.sleep ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
    this.pollMs = deps.pollMs ?? 1000;
  }

  // ---- student-facing ------------------------------------------------------------------

  /** POST /v1/session: the live session, or a new lease whose spawn starts in the background. */
  async request(account: Account): Promise<StudentSessionStatus> {
    const { row, created } = await acquireLease(this.pool, account, { maxConcurrent: this.config.maxConcurrent, idleMinutes: this.config.idleMinutes });
    if (created) log.info('session_lease_taken', { sessionId: row.id, accountId: account.id, state: row.state });
    if (row.state === 'queued') {
      // A slot may have opened since this row queued (or since a restart): try now.
      await this.promoteAndDrive();
      return this.statusOf((await sessionById(this.pool, row.id)) ?? row);
    }
    if (row.state === 'spawning') void this.drive(row.id);
    return this.statusOf(row);
  }

  /** GET /v1/session: the live session, else how the last one ended. Null when there never was one. */
  async status(account: Account): Promise<StudentSessionStatus | null> {
    const row = await latestSession(this.pool, account.id);
    return row ? this.statusOf(row) : null;
  }

  async heartbeat(account: Account): Promise<StudentSessionStatus | null> {
    const row = await touchHeartbeat(this.pool, account.id, this.config.idleMinutes);
    return row ? this.statusOf(row) : null;
  }

  /**
   * DELETE /v1/session (logout): a queued lease just ends; a spawning or ready one is torn down.
   * A pinned account keeps its workspace instead (see keepPinned).
   */
  async end(account: Account, reason = 'logout'): Promise<StudentSessionStatus | null> {
    const row = await liveSession(this.pool, account.id);
    if (!row) return null;
    if (reason === 'logout' && this.config.pinnedAccounts.includes(account.id)) return this.keepPinned(row);
    return this.endRow(row, reason);
  }

  /**
   * A pinned account's logout flushes the vault and leaves the machine and the lease alone:
   * Instabox suspends the idle box, and the next sign-in resumes it in seconds instead of
   * restoring a fresh VM. Only the student's own logout is softened this way; a staff end,
   * the idle reaper and an expired lease still go through endRow.
   */
  private async keepPinned(row: SessionRow): Promise<StudentSessionStatus> {
    if (row.state === 'ready' && row.machine_id && row.ready_at) {
      const note = await this.flush(row, row.machine_id);
      log.info('session_kept_pinned', { sessionId: row.id, accountId: row.account_id, machineId: row.machine_id, flush: note ?? 'ok' });
    } else {
      log.info('session_kept_pinned', { sessionId: row.id, accountId: row.account_id, state: row.state });
    }
    return this.statusOf((await sessionById(this.pool, row.id)) ?? row);
  }

  // ---- staff-facing --------------------------------------------------------------------

  async listActive(): Promise<AdminSessionRow[]> {
    const rows = await sessionsInState(this.pool, ['queued', 'spawning', 'ready', 'stopping']);
    return rows.map((row) => ({
      id: row.id,
      accountId: row.account_id,
      accountKind: row.account_kind,
      state: row.state,
      step: row.step,
      machineId: row.machine_id,
      heartbeatAt: row.heartbeat_at.toISOString(),
      leaseExpiresAt: row.lease_expires_at.toISOString(),
      createdAt: row.created_at.toISOString(),
      readyAt: row.ready_at?.toISOString() ?? null,
      lastError: row.last_error,
    }));
  }

  async forceEnd(id: string, reason = 'staff_ended'): Promise<StudentSessionStatus | null> {
    const row = await sessionById(this.pool, id);
    if (!row || !['queued', 'spawning', 'ready', 'stopping'].includes(row.state)) return null;
    return this.endRow(row, reason);
  }

  private async endRow(row: SessionRow, reason: string): Promise<StudentSessionStatus> {
    if (row.state === 'queued') {
      const ended = await updateSession(this.pool, row.id, { state: 'ended', end_reason: reason, ended_at: new Date(), step: null }, ['queued']);
      if (ended) {
        log.info('session_ended', { sessionId: row.id, reason, machine: false });
        return this.statusOf(ended);
      }
      row = (await sessionById(this.pool, row.id)) ?? row;
    }
    if (row.state === 'spawning' || row.state === 'ready') {
      const stopping = await updateSession(this.pool, row.id, { state: 'stopping', end_reason: reason }, ['spawning', 'ready']);
      if (stopping) log.info('session_stopping', { sessionId: row.id, reason });
      row = stopping ?? (await sessionById(this.pool, row.id)) ?? row;
    }
    if (row.state === 'stopping') void this.teardown(row.id);
    return this.statusOf(row);
  }

  // ---- worker ----------------------------------------------------------------------------

  /** After a restart: re-drive spawns, finish teardowns, and fill free slots from the queue. */
  async recover(): Promise<void> {
    for (const row of await sessionsInState(this.pool, ['spawning'])) void this.drive(row.id);
    for (const row of await sessionsInState(this.pool, ['stopping'])) void this.teardown(row.id);
    await this.promoteAndDrive();
  }

  async promoteAndDrive(): Promise<void> {
    for (const id of await promoteQueued(this.pool, this.config.maxConcurrent)) {
      log.info('session_promoted', { sessionId: id });
      void this.drive(id);
    }
  }

  /** Is this process already spawning or tearing down the session? */
  busy(id: string): boolean {
    return this.driving.has(id) || this.tearing.has(id);
  }

  /** Waits for every spawn and teardown this process is running (tests, shutdown). */
  async idle(): Promise<void> {
    while (this.driving.size + this.tearing.size > 0) await Promise.allSettled([...this.driving.values(), ...this.tearing.values()]);
  }

  /** Starts (or joins) the spawn of one session. One drive per session per process. */
  drive(id: string): Promise<void> {
    const running = this.driving.get(id);
    if (running) return running;
    const run = this.spawn(id)
      .catch((error) => log.error('session_spawn_crashed', { sessionId: id, ...errorFields(error) }))
      .finally(() => this.driving.delete(id));
    this.driving.set(id, run);
    return run;
  }

  /** Starts (or joins) the teardown of one session; waits for its spawn to notice and stop first. */
  teardown(id: string): Promise<void> {
    const running = this.tearing.get(id);
    if (running) return running;
    const run = (async () => {
      await this.driving.get(id);
      try {
        await this.stop(id);
      } finally {
        // A slot may have been freed: the next queued student starts now.
        await this.promoteAndDrive().catch((error) => log.error('session_promote_failed', errorFields(error)));
      }
    })()
      .catch((error) => log.error('session_teardown_crashed', { sessionId: id, ...errorFields(error) }))
      .finally(() => this.tearing.delete(id));
    this.tearing.set(id, run);
    return run;
  }

  private async spawn(id: string): Promise<void> {
    let row = await sessionById(this.pool, id);
    if (!row || row.state !== 'spawning') return;
    const started = Date.now();
    log.info('session_spawn', { sessionId: id, step: row.step, resumed: row.machine_id !== null });
    try {
      if (row.step === null || row.step === 'create') row = await this.stepCreate(row);
      if (row.step === 'start') row = await this.stepStart(row);
      if (row.step === 'publish') row = await this.stepPublish(row);
      if (row.step === 'session_start') row = await this.stepSessionStart(row);
      if (row.step === 'health') row = await this.stepHealth(row);
      log.info('session_ready', { sessionId: id, machineId: row.machine_id, ms: Date.now() - started });
    } catch (error) {
      if (error instanceof Superseded) {
        log.info('session_spawn_superseded', { sessionId: id });
        return;
      }
      log.error('session_spawn_failed', { sessionId: id, step: row.step, error: describe(error) });
      const stopping = await updateSession(this.pool, id, { state: 'stopping', end_reason: 'spawn_failed', last_error: describe(error) }, ['spawning']);
      if (stopping) void this.teardown(id);
    }
  }

  /** Persists the step's result and the next step, but only while the row is still spawning. */
  private async advance(row: SessionRow, fields: Parameters<typeof updateSession>[2]): Promise<SessionRow> {
    const next = await updateSession(this.pool, row.id, fields, ['spawning']);
    if (!next) throw new Superseded();
    return next;
  }

  /** Sleeps, then makes sure nobody ended the session meanwhile. */
  private async pause(row: SessionRow, ms: number): Promise<void> {
    await this.sleep(ms);
    const current = await sessionById(this.pool, row.id);
    if (current?.state !== 'spawning') throw new Superseded();
  }

  private backoff(attempt: number): number {
    const ms = Math.min(30_000, this.config.retryBaseMs * 2 ** Math.min(attempt, 8));
    return ms / 2 + Math.random() * (ms / 2);
  }

  /** Our labelled machine for this session, if one exists (adoption after a crash). */
  private async findSessionMachine(sessionId: string): Promise<Machine | null> {
    const found = await this.client.listMachines({ app: SESSION_APP_LABEL, session: sessionId });
    return found.find((m) => m.metadata?.app === SESSION_APP_LABEL && m.metadata?.session === sessionId && isMachineId(m.id)) ?? null;
  }

  private async stepCreate(row: SessionRow): Promise<SessionRow> {
    const deadline = Date.now() + this.config.timeouts.create;
    const capacityDeadline = Date.now() + this.config.capacityWaitMs;
    let attempt = 0;
    for (;;) {
      try {
        // A machine id on the row, or a machine labelled with this session, means a create
        // already went through (perhaps before a restart): adopt it, never create a second.
        let machineId = row.machine_id;
        if (machineId && !(await this.client.getMachine(machineId))) machineId = null;
        if (!machineId) machineId = (await this.findSessionMachine(row.id))?.id ?? null;
        if (machineId) return await this.advance(row, { step: 'start', machine_id: machineId, last_error: null });

        const operation = await this.client.createMachine({
          name: row.machine_name,
          snapshotId: this.config.snapshotId,
          metadata: { app: SESSION_APP_LABEL, account: row.account_id, session: row.id },
          autoSuspendAfterSeconds: this.config.autoSuspendSeconds,
        }, row.create_idempotency_key);
        if (operation.machineId && isMachineId(operation.machineId)) row = await this.advance(row, { machine_id: operation.machineId });
        await this.client.waitOperation(operation, deadline);
        log.info('session_machine_created', { sessionId: row.id, machineId: row.machine_id, attempts: attempt + 1 });
        return await this.advance(row, { step: 'start', last_error: null });
      } catch (error) {
        if (error instanceof Superseded) throw error;
        attempt += 1;
        if (error instanceof InstaboxError && CAPACITY_CODES.has(error.code)) {
          if (Date.now() > capacityDeadline) throw new SpawnError(error.code, 'Instabox had no capacity for the whole wait.');
          // A refused create did nothing (Instabox removed the sandbox), and replaying its key
          // would only replay the refusal: the next attempt gets a fresh key. A create whose
          // outcome is unknown (network) keeps its key, so a replay can never make a second VM.
          row = await this.advance(row, {
            create_idempotency_key: newIdempotencyKey(row.id, 'create'),
            machine_id: null,
            attempts: row.attempts + 1,
            last_error: `${error.code}: waiting for a free machine`,
          });
          log.warn('session_waiting_for_capacity', { sessionId: row.id, code: error.code, attempt });
          await this.pause(row, this.backoff(attempt));
          continue;
        }
        if (error instanceof InstaboxError && error.retryable && Date.now() < deadline) {
          log.warn('session_create_retry', { sessionId: row.id, code: error.code, attempt });
          await this.pause(row, this.backoff(attempt));
          continue;
        }
        throw error;
      }
    }
  }

  /**
   * Gets the machine to `running` and answering exec. A snapshot-restored box may come back
   * stopped (start it) or, after Instabox's own idle suspend, suspended (resume it).
   */
  private async ensureRunning(machineId: string, deadline: number, check: () => Promise<void>): Promise<void> {
    for (;;) {
      if (Date.now() > deadline) throw new SpawnError('start_timeout', 'The machine did not reach running in time.');
      try {
        const machine = await this.client.getMachine(machineId);
        if (!machine) throw new SpawnError('machine_gone', 'The session machine no longer exists.');
        if (machine.state === 'running' && machine.runtime?.ready !== false) {
          const probe = await this.client.exec(machineId, { cmd: 'true', timeoutSeconds: 10 });
          if (probe.exitCode === 0) return;
        } else if (machine.state === 'stopped') {
          await this.client.waitOperation(await this.client.start(machineId, newIdempotencyKey(machineId, 'start')), deadline);
          continue;
        } else if (machine.state === 'suspended') {
          await this.client.waitOperation(await this.client.resume(machineId, newIdempotencyKey(machineId, 'resume')), deadline);
          continue;
        } else if (machine.state === 'error' || machine.state === 'deleting' || machine.state === 'deleted') {
          throw new SpawnError('machine_unusable', `The session machine is ${machine.state}.`);
        }
      } catch (error) {
        const transient = error instanceof InstaboxError &&
          (error.retryable || error.code === 'machine_not_running' || error.code === 'operation_conflict');
        if (!transient) throw error;
      }
      await check();
    }
  }

  private async stepStart(row: SessionRow): Promise<SessionRow> {
    await this.ensureRunning(row.machine_id!, Date.now() + this.config.timeouts.start, () => this.pause(row, this.pollMs));
    return this.advance(row, { step: 'publish' });
  }

  private async stepPublish(row: SessionRow): Promise<SessionRow> {
    const deadline = Date.now() + this.config.timeouts.publish;
    for (let attempt = 1; ; attempt += 1) {
      try {
        const port = await this.client.createPort(row.machine_id!, ENGINE_PORT, 'engine');
        const url = port.url.replace(/\/+$/, '');
        if (!/^https?:\/\/[A-Za-z0-9.-]+(:\d{1,5})?(\/[A-Za-z0-9._~/-]*)?$/.test(url)) throw new SpawnError('bad_url', 'Instabox returned an unexpected URL.');
        return await this.advance(row, { step: 'session_start', url });
      } catch (error) {
        if (!(error instanceof InstaboxError && error.retryable && Date.now() < deadline)) throw error;
        await this.pause(row, this.backoff(attempt));
      }
    }
  }

  /** The per-session half of the engine env. Values travel only in exec `envs`. */
  private sessionEnvs(row: SessionRow): Record<string, string> {
    return sessionStartEnvs(this.config, row);
  }

  private async stepSessionStart(row: SessionRow): Promise<SessionRow> {
    const deadline = Date.now() + this.config.timeouts.sessionStart;
    // Resumed after a restart, the box may have been stopped or suspended meanwhile.
    await this.ensureRunning(row.machine_id!, Date.now() + this.config.timeouts.start, () => this.pause(row, this.pollMs));
    let lastProblem = '';
    // session-start.sh is re-runnable (it rewrites session.env and recreates the engine), so a
    // failed or lost exec may be repeated: at most twice, inside the step's deadline.
    for (let attempt = 1; attempt <= 2 && Date.now() < deadline; attempt += 1) {
      try {
        const result = await this.client.exec(row.machine_id!, {
          cmd: `bash ${this.config.seatHome}/session-start.sh`,
          envs: this.sessionEnvs(row),
          timeoutSeconds: 58,
        });
        if (result.exitCode === 0) {
          log.info('session_engine_started', { sessionId: row.id, out: tail(result.stdout, 300) });
          return await this.advance(row, { step: 'health' });
        }
        lastProblem = `session-start.sh exited ${result.exitCode}`;
        log.warn('session_start_script_failed', { sessionId: row.id, attempt, exitCode: result.exitCode, out: tail(result.stdout), err: tail(result.stderr) });
      } catch (error) {
        if (error instanceof Superseded) throw error;
        if (!(error instanceof InstaboxError && (error.retryable || error.code === 'machine_not_running'))) throw error;
        lastProblem = describe(error);
        log.warn('session_start_exec_failed', { sessionId: row.id, attempt, code: error.code });
      }
      await this.pause(row, this.backoff(attempt));
    }
    throw new SpawnError('session_start_failed', lastProblem || 'session-start.sh did not finish in time.');
  }

  private async stepHealth(row: SessionRow): Promise<SessionRow> {
    const deadline = Date.now() + this.config.timeouts.health;
    while (Date.now() < deadline) {
      try {
        const verdict = healthVerdict(await this.probe(row.url!));
        if (verdict === 'sync_error') throw new SpawnError('sync_error', 'The engine could not restore the vault.');
        if (verdict === 'ready') return await this.advance(row, { state: 'ready', step: null, ready_at: new Date(), last_error: null });
      } catch (error) {
        if (error instanceof Superseded || error instanceof SpawnError) throw error;
        // The edge answers slowly or not at all for a moment after the engine starts.
      }
      await this.pause(row, this.pollMs);
    }
    throw new SpawnError('health_timeout', 'The engine never reported ready on its public URL.');
  }

  /** Teardown: final flush (only if the student could have used it), delete, release the lease. */
  private async stop(id: string): Promise<void> {
    const row = await sessionById(this.pool, id);
    if (!row || row.state !== 'stopping') return;
    let machineId = row.machine_id;
    if (!machineId) machineId = (await this.findSessionMachine(row.id))?.id ?? null;
    let note: string | null = null;

    if (machineId) {
      const machine = await this.client.getMachine(machineId);
      if (machine && machine.metadata?.app !== SESSION_APP_LABEL) {
        // By construction this cannot happen: the id came from our own create. Refuse anyway.
        log.error('session_teardown_refused_foreign_machine', { sessionId: id, machineId });
        await updateSession(this.pool, id, { last_error: 'refused: machine is not a session machine' });
        return;
      }
      if (machine) {
        // A session that never became ready was never handed to the student: nothing to flush.
        if (row.ready_at) note = await this.flush(row, machineId);
        try {
          await this.deleteMachine(machineId);
          log.info('session_machine_deleted', { sessionId: id, machineId });
        } catch (error) {
          // Leave the row stopping: the reaper retries, and the lease stays held meanwhile.
          log.error('session_delete_failed', { sessionId: id, machineId, error: describe(error) });
          await updateSession(this.pool, id, { last_error: `delete: ${describe(error)}`, attempts: row.attempts + 1 });
          return;
        }
      }
    }
    const final = row.end_reason === 'spawn_failed' ? 'failed' : 'ended';
    const lastError = row.end_reason === 'spawn_failed' ? row.last_error : note;
    await updateSession(this.pool, id, { state: final, ended_at: new Date(), last_error: lastError }, ['stopping']);
    log.info('session_ended', { sessionId: id, state: final, reason: row.end_reason, machineId });
  }

  /**
   * Runs session-stop.sh (PR-41b) on the box: the engine pushes everything to the object store.
   * Retried once; a failure is logged loudly and the teardown carries on (the VM still goes).
   * Returns a note for the row, or null when the flush went through.
   */
  private async flush(row: SessionRow, machineId: string): Promise<string | null> {
    const home = this.config.seatHome;
    // Fixed command, no values: the token travels in envs. Exit 127 = the script is not on this image.
    const cmd = `f=${home}/session-stop.sh; [ -f "$f" ] || f=${home}/src/infra/seat/session-stop.sh; ` +
      '[ -f "$f" ] || { echo "session-stop.sh not found" >&2; exit 127; }; bash "$f"';
    const deadline = Date.now() + this.config.timeouts.flush;
    try {
      await this.ensureRunning(machineId, deadline, () => this.sleep(this.pollMs));
    } catch (error) {
      log.error('session_flush_failed', { sessionId: row.id, machineId, stage: 'wake', error: describe(error), loud: 'VAULT CHANGES SINCE THE LAST PUSH MAY BE LOST' });
      return `flush: ${describe(error)}`;
    }
    let problem = '';
    for (let attempt = 1; attempt <= 2; attempt += 1) {
      try {
        const result = await this.client.exec(machineId, { cmd, envs: { SYNC_FLUSH_TOKEN: row.flush_token }, timeoutSeconds: 58 });
        if (result.exitCode === 0) {
          log.info('session_flushed', { sessionId: row.id, attempt, out: tail(result.stdout, 300) });
          return null;
        }
        if (result.exitCode === 127) {
          log.warn('session_flush_unavailable', { sessionId: row.id, note: 'session-stop.sh is not on this image (pre PR-41b); nothing to flush', err: tail(result.stderr, 200) });
          return 'flush: session-stop.sh not found on the image';
        }
        // session-stop.sh prints the engine's answer: {ok:false, error} with error one of
        // conflict | push_failed | timeout | not_restored (PR-41b). Only push_failed and timeout
        // may succeed on a second try; an answer we cannot read is treated as transient too.
        const code = flushErrorCode(result.stdout);
        problem = code ? `engine refused the flush: ${code}` : `session-stop.sh exited ${result.exitCode}`;
        log.error('session_flush_attempt_failed', { sessionId: row.id, attempt, exitCode: result.exitCode, code, out: tail(result.stdout), err: tail(result.stderr) });
        if (code && !FLUSH_RETRYABLE.has(code)) break;
      } catch (error) {
        problem = describe(error);
        log.error('session_flush_attempt_failed', { sessionId: row.id, attempt, error: problem });
      }
    }
    log.error('session_flush_failed', { sessionId: row.id, machineId, error: problem, loud: 'VAULT CHANGES SINCE THE LAST PUSH MAY BE LOST' });
    return `flush: ${problem}`;
  }

  private async deleteMachine(machineId: string): Promise<void> {
    const deadline = Date.now() + this.config.timeouts.delete;
    for (let attempt = 1; ; attempt += 1) {
      try {
        const operation = await this.client.deleteMachine(machineId, newIdempotencyKey(machineId, 'delete'));
        if (operation) await this.client.waitOperation(operation, deadline);
        return;
      } catch (error) {
        const transient = error instanceof InstaboxError && (error.retryable || error.code === 'operation_conflict');
        if (!transient || Date.now() > deadline) throw error;
        await this.sleep(this.backoff(attempt));
      }
    }
  }

  // ---- presentation ----------------------------------------------------------------------

  async statusOf(row: SessionRow): Promise<StudentSessionStatus> {
    const stepIndex = row.step ? SESSION_STEPS.indexOf(row.step) : -1;
    const steps = SESSION_STEPS.map((name: SessionStep, index) => {
      let status: 'pending' | 'active' | 'done' | 'failed' = 'pending';
      if (row.state === 'ready' || ((row.state === 'stopping' || row.state === 'ended') && row.ready_at)) status = 'done';
      else if (row.state === 'spawning' || row.state === 'failed' || row.state === 'stopping') {
        if (index < stepIndex) status = 'done';
        else if (index === stepIndex) status = row.state === 'spawning' ? 'active' : 'failed';
      }
      return { name, label: SESSION_STEP_LABELS[name], status };
    });
    const status: StudentSessionStatus = { id: row.id, state: row.state, step: row.step, steps, createdAt: row.created_at.toISOString() };
    if (row.state === 'ready' && row.url) status.url = row.url;
    if (row.ready_at) status.readyAt = row.ready_at.toISOString();
    if (row.state === 'queued') status.position = await queuePosition(this.pool, row);
    const code = row.last_error?.split(':')[0];
    if (row.state === 'spawning' && code && CAPACITY_CODES.has(code)) {
      status.error = { code: 'no_capacity', message: 'All workspaces are busy right now; yours starts as soon as one is free.', retryable: true };
    } else if (row.state === 'failed' || (row.state === 'stopping' && row.end_reason === 'spawn_failed')) {
      status.error = { code: 'spawn_failed', message: 'Your workspace could not start. Please try again.', retryable: true };
    }
    return status;
  }
}

/** The per-session half of the engine env (session-start.sh's inputs). Values travel only in exec `envs`. */
export function sessionStartEnvs(config: SessionConfig, row: Pick<SessionRow, 'url' | 'account_id' | 'flush_token' | 'machine_id'>): Record<string, string> {
  const host = new URL(row.url!).host;
  const envs: Record<string, string> = {
    ENGINE_PUBLIC_HOST: host,
    // The id the student's own sign-in on the VM will produce: account.id for a legacy
    // login, user.id for a device (better-auth) sign-in. PR-37d pins the seat to it.
    ENGINE_SEAT_OWNER: row.account_id,
    VAULT_SYNC_ACCOUNT: row.account_id,
    UNI_SERVER_URL: config.uniPublicUrl,
    MODEL_GATEWAY_URL: config.gatewayUrl,
    SYNC_FLUSH_TOKEN: row.flush_token,
    ...config.objectStore,
    // The web app hosted apart from the VM (APP_PUBLIC_ORIGIN) calls it cross-origin.
    ...(config.appOrigin ? { ENGINE_ALLOWED_ORIGINS: config.appOrigin } : {}),
  };
  if (config.gatewaySecret) {
    // PR-43a's format (`sefgw1.`, see @sef/shared/node gateway-token): bound to this account and VM.
    envs.MODEL_GATEWAY_TOKEN = mintGatewayToken(config.gatewaySecret, { sub: row.account_id, vm: row.machine_id!, ttlSeconds: config.gatewayTokenMinutes * 60 });
  }
  return envs;
}
