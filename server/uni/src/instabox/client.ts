/**
 * A typed Instabox client for the session orchestrator (PR-42), ported from PR-38's Rust
 * seat client. The operator key is held only inside this object, sent only as `X-API-Key`
 * to the configured API base, and never logged, returned or put in an error message.
 *
 * Wire facts this relies on (docs/internal/CLOUD_SEAT_NOTES.md §4):
 *  - only machine lifecycle calls (create/start/resume/stop/delete) are async Operations and
 *    take an Idempotency-Key; exec and publish-port take none;
 *  - exec is blocking and NOT idempotent, and is cut at about 60 s in practice;
 *  - a create that fails `no_capacity` is removed by Instabox and does not count to quota.
 */

export const INSTABOX_API_BASE = 'https://api.instabox.sh';
/** The operation long poll is capped at 30 s server side. */
const OPERATION_WAIT_SECONDS = 25;
/** Exec is cut at about 60 s whatever timeoutSeconds says (§8). */
export const EXEC_PRACTICAL_CAP_SECONDS = 58;
const LIST_PAGE_LIMIT = 20;

export type MachineState =
  | 'creating' | 'starting' | 'running' | 'stopping' | 'stopped' | 'suspending'
  | 'suspended' | 'resuming' | 'deleting' | 'deleted' | 'error';

export interface Machine {
  id: string;
  name: string;
  state: MachineState;
  runtime?: { ready?: boolean };
  metadata?: Record<string, string>;
  autoSuspendedAt?: string | null;
  operationId?: string | null;
  createdAt?: string;
}

export interface Operation {
  id: string;
  type: string;
  state: 'queued' | 'running' | 'succeeded' | 'failed';
  machineId?: string | null;
  phase?: string | null;
  error?: { code: string; message?: string; retryable?: boolean } | null;
}

export interface ExecResult {
  stdout: string;
  stderr: string;
  exitCode: number;
  timedOut?: boolean;
  truncated?: boolean;
}

export interface PublishedPort {
  port: number;
  url: string;
}

export interface CreateMachineInput {
  name: string;
  snapshotId: string;
  metadata: Record<string, string>;
  autoSuspendAfterSeconds?: number;
}

/**
 * Instabox's own error code when it sent one (`quota_exceeded`, `no_capacity`,
 * `machine_not_running`, `operation_conflict`, `idempotency_conflict`, `not_found`, ...),
 * otherwise ours: `network` (no answer: the outcome is unknown), `unexpected_response`,
 * `invalid_input`, `operation_failed`, `timeout`.
 */
export class InstaboxError extends Error {
  constructor(
    readonly code: string,
    message: string,
    /** HTTP status, 0 when no response arrived. */
    readonly status = 0,
    /**
     * True when the SAME request may succeed later. For a create that means the same
     * Idempotency-Key: an unknown outcome (network, timeout, a 5xx without a body) must be
     * replayed with its key, never retried under a new one.
     */
    readonly retryable = false,
    readonly operationId: string | null = null,
  ) {
    super(message);
    this.name = 'InstaboxError';
  }
}

/** Codes Instabox marks retryable regardless of what the body says. */
const ALWAYS_RETRYABLE = new Set(['no_capacity', 'host_unavailable', 'network']);

const MACHINE_ID = /^m_[a-z0-9]{26}$/;
const OPERATION_ID = /^op_[a-z0-9]{26}$/;
const IDEMPOTENCY_KEY = /^[\x21-\x7e]{1,200}$/;
const MACHINE_NAME = /^[a-z][a-z0-9-]{0,62}$/;
const SNAPSHOT_ID = /^(sn|im)_[a-z0-9]{1,64}$/;
const METADATA_KEY = /^[A-Za-z0-9_.-]{1,64}$/;

function check(ok: boolean, what: string): void {
  if (!ok) throw new InstaboxError('invalid_input', `That is not a valid ${what}.`);
}

export const isMachineId = (id: string) => MACHINE_ID.test(id);

export interface InstaboxClientOptions {
  apiKey: string;
  baseUrl?: string;
  fetch?: typeof fetch;
  /** Per-request ceiling; the long poll and a near-60 s exec fit inside the default. */
  requestTimeoutMs?: number;
}

export class InstaboxClient {
  readonly #key: string;
  private readonly base: string;
  private readonly fetchImpl: typeof fetch;
  private readonly timeoutMs: number;

  constructor(options: InstaboxClientOptions) {
    if (!options.apiKey) throw new InstaboxError('key_missing', 'INSTABOX_API_KEY is not set.');
    this.#key = options.apiKey;
    this.base = (options.baseUrl ?? INSTABOX_API_BASE).replace(/\/+$/, '');
    this.fetchImpl = options.fetch ?? fetch;
    this.timeoutMs = options.requestTimeoutMs ?? 75_000;
  }

  /** Keeps the key out of `console.log(client)` and JSON dumps. */
  toJSON() {
    return { base: this.base };
  }

  private async send<T>(method: string, path: string, options: { body?: unknown; idempotencyKey?: string; timeoutMs?: number } = {}): Promise<T> {
    const headers: Record<string, string> = { 'X-API-Key': this.#key, accept: 'application/json' };
    if (options.body !== undefined) headers['content-type'] = 'application/json';
    if (options.idempotencyKey !== undefined) {
      check(IDEMPOTENCY_KEY.test(options.idempotencyKey), 'idempotency key');
      headers['Idempotency-Key'] = options.idempotencyKey;
    }
    let response: Response;
    try {
      response = await this.fetchImpl(`${this.base}${path}`, {
        method,
        headers,
        body: options.body === undefined ? undefined : JSON.stringify(options.body),
        signal: AbortSignal.timeout(options.timeoutMs ?? this.timeoutMs),
      });
    } catch (error) {
      const timedOut = (error as Error).name === 'TimeoutError';
      // Only the error's name: fetch messages can carry the URL, never headers, but stay terse.
      throw new InstaboxError('network', timedOut ? 'Instabox did not answer in time.' : 'Could not reach Instabox.', 0, true);
    }
    const text = await response.text().catch(() => '');
    if (response.ok) {
      if (response.status === 204 || text === '') return undefined as T;
      try {
        return JSON.parse(text) as T;
      } catch {
        throw new InstaboxError('unexpected_response', 'Instabox sent a response this server does not understand.', response.status);
      }
    }
    throw apiError(response.status, text);
  }

  async listMachines(metadata: Record<string, string>): Promise<Machine[]> {
    const machines: Machine[] = [];
    let cursor: string | null = null;
    for (let page = 0; page < LIST_PAGE_LIMIT; page += 1) {
      const query = new URLSearchParams();
      for (const [key, value] of Object.entries(metadata)) {
        check(METADATA_KEY.test(key), 'metadata key');
        query.append('metadata', `${key}:${value}`);
      }
      if (cursor) query.set('cursor', cursor);
      const result: { machines: Machine[]; nextCursor?: string | null } = await this.send('GET', `/v1/machines?${query}`);
      machines.push(...result.machines);
      cursor = result.nextCursor ?? null;
      if (!cursor) break;
    }
    // The filter is the server's; the caller re-checks every label it acts on.
    return machines;
  }

  /** Create from a snapshot. Never touches the operator's Vault (`vault:false`). */
  async createMachine(input: CreateMachineInput, idempotencyKey: string): Promise<Operation> {
    check(MACHINE_NAME.test(input.name), 'machine name');
    check(SNAPSHOT_ID.test(input.snapshotId), 'snapshot id');
    for (const key of Object.keys(input.metadata)) check(METADATA_KEY.test(key), 'metadata key');
    const body: Record<string, unknown> = { name: input.name, snapshotId: input.snapshotId, vault: false, metadata: input.metadata };
    if (input.autoSuspendAfterSeconds !== undefined) body.autoSuspendAfterSeconds = input.autoSuspendAfterSeconds;
    return this.send('POST', '/v1/machines', { body, idempotencyKey });
  }

  /** The machine, or null once it is gone (404). */
  async getMachine(id: string): Promise<Machine | null> {
    check(isMachineId(id), 'machine id');
    try {
      return await this.send<Machine>('GET', `/v1/machines/${id}`);
    } catch (error) {
      if (error instanceof InstaboxError && error.status === 404) return null;
      throw error;
    }
  }

  /** One long poll (up to 25 s); returns early when the operation finishes. */
  async getOperation(id: string, waitSeconds = OPERATION_WAIT_SECONDS): Promise<Operation> {
    check(OPERATION_ID.test(id), 'operation id');
    const wait = Math.max(0, Math.min(OPERATION_WAIT_SECONDS, Math.floor(waitSeconds)));
    return this.send('GET', `/v1/operations/${id}?wait=${wait}s`, { timeoutMs: (wait + 15) * 1000 });
  }

  /**
   * Polls until the operation is terminal or `deadline` (epoch ms) passes. A failed operation
   * throws with the operation's own error code (`no_capacity` on a create, for instance).
   */
  async waitOperation(operation: Operation, deadline: number, now: () => number = Date.now): Promise<Operation> {
    let current = operation;
    while (current.state !== 'succeeded') {
      if (current.state === 'failed') {
        const code = current.error?.code ?? 'operation_failed';
        throw new InstaboxError(code, current.error?.message || `The ${current.type} operation failed.`, 0, ALWAYS_RETRYABLE.has(code) || Boolean(current.error?.retryable), current.id);
      }
      const left = deadline - now();
      if (left <= 0) throw new InstaboxError('timeout', `The ${current.type} operation did not finish in time.`, 0, true, current.id);
      current = await this.getOperation(current.id, Math.min(OPERATION_WAIT_SECONDS, Math.ceil(left / 1000)));
    }
    return current;
  }

  async start(id: string, idempotencyKey: string): Promise<Operation> {
    check(isMachineId(id), 'machine id');
    return this.send('POST', `/v1/machines/${id}/start`, { body: {}, idempotencyKey });
  }

  async resume(id: string, idempotencyKey: string): Promise<Operation> {
    check(isMachineId(id), 'machine id');
    return this.send('POST', `/v1/machines/${id}/resume`, { body: {}, idempotencyKey });
  }

  /**
   * Blocking and NOT idempotent: a retry runs the command again, so callers only send
   * commands that are safe to repeat. Values go in `envs`, never in `cmd` (the command line
   * is visible in the box's process list and in Instabox's request logs).
   */
  async exec(id: string, input: { cmd: string; envs?: Record<string, string>; timeoutSeconds?: number }): Promise<ExecResult> {
    check(isMachineId(id), 'machine id');
    const timeoutSeconds = Math.max(1, Math.min(Math.floor(input.timeoutSeconds ?? 50), EXEC_PRACTICAL_CAP_SECONDS));
    return this.send('POST', `/v1/machines/${id}/exec`, {
      body: { cmd: input.cmd, envs: input.envs ?? {}, timeoutSeconds },
      timeoutMs: (timeoutSeconds + 15) * 1000,
    });
  }

  /** Idempotent by nature (200 with the same URL when it exists); takes no Idempotency-Key. */
  async createPort(id: string, port: number, name: string): Promise<PublishedPort> {
    check(isMachineId(id), 'machine id');
    const published = await this.send<PublishedPort>('POST', `/v1/machines/${id}/ports`, { body: { port, name } });
    if (!published?.url) throw new InstaboxError('ports_unavailable', 'Instabox has public ports switched off, so the session cannot get a URL.');
    return published;
  }

  /** Deletes the machine. Null when it was already gone (404), so a retried teardown is safe. */
  async deleteMachine(id: string, idempotencyKey: string): Promise<Operation | null> {
    check(isMachineId(id), 'machine id');
    try {
      return await this.send<Operation>('DELETE', `/v1/machines/${id}`, { idempotencyKey });
    } catch (error) {
      if (error instanceof InstaboxError && error.status === 404) return null;
      throw error;
    }
  }
}

function apiError(status: number, text: string): InstaboxError {
  try {
    const body = JSON.parse(text) as { error?: { code?: string; message?: string; retryable?: boolean; operationId?: string | null } };
    if (body.error?.code) {
      const { code } = body.error;
      return new InstaboxError(code, body.error.message || `Instabox refused the request (${code}).`, status, ALWAYS_RETRYABLE.has(code) || Boolean(body.error.retryable), body.error.operationId ?? null);
    }
  } catch {
    // Not JSON: fall through to the status-only mapping.
  }
  return status >= 500
    ? new InstaboxError('host_unavailable', `Instabox answered ${status} without an error body.`, status, true)
    : new InstaboxError('unexpected_response', `Instabox answered ${status} without an error body.`, status);
}
