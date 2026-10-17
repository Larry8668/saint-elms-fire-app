import { randomBytes, randomUUID } from 'node:crypto';
import type { Pool, PoolClient } from 'pg';
import { LIVE_SESSION_STATES, type SessionState, type SessionStep } from '@sef/shared';
import { withTransaction } from '../db';

/** States whose session holds (or is about to hold) an Instabox machine: they count to capacity. */
export const MACHINE_STATES: readonly SessionState[] = ['spawning', 'ready', 'stopping'];
/** Serialises lease decisions (insert/queue/promote) so capacity is never over-committed. */
const CAPACITY_LOCK = 0x5ef42;

export interface SessionRow {
  id: string;
  account_id: string;
  account_kind: 'legacy' | 'user';
  state: SessionState;
  step: SessionStep | null;
  machine_name: string;
  machine_id: string | null;
  url: string | null;
  create_idempotency_key: string;
  flush_token: string;
  lease_expires_at: Date;
  heartbeat_at: Date;
  next_attempt_at: Date | null;
  attempts: number;
  last_error: string | null;
  end_reason: string | null;
  created_at: Date;
  updated_at: Date;
  ready_at: Date | null;
  ended_at: Date | null;
}

export interface Account {
  id: string;
  kind: 'legacy' | 'user';
}

type Writable = Pick<SessionRow,
  'state' | 'step' | 'machine_id' | 'url' | 'create_idempotency_key' | 'lease_expires_at' | 'heartbeat_at'
  | 'next_attempt_at' | 'attempts' | 'last_error' | 'end_reason' | 'ready_at' | 'ended_at'>;
const WRITABLE = new Set<keyof Writable>(['state', 'step', 'machine_id', 'url', 'create_idempotency_key', 'lease_expires_at',
  'heartbeat_at', 'next_attempt_at', 'attempts', 'last_error', 'end_reason', 'ready_at', 'ended_at']);

const LIVE = [...LIVE_SESSION_STATES];

export const newIdempotencyKey = (sessionId: string, purpose: string) => `sef-${purpose}-${sessionId}-${randomBytes(6).toString('hex')}`;

/** Instabox names are unique per account and at most 63 chars; the session id makes them unique here. */
const machineName = (id: string) => `sef-session-${id.replaceAll('-', '').slice(0, 20)}`;

const minutesFromNow = (minutes: number) => new Date(Date.now() + minutes * 60_000);

export interface LeaseResult {
  row: SessionRow;
  created: boolean;
}

/**
 * Takes the student's one lease, or returns the live row they already hold (renewing its
 * heartbeat). A new row starts `spawning` when a machine slot is free and nobody is queued
 * ahead, otherwise `queued`. The partial unique index makes a second live row impossible
 * even if two uni processes race; the advisory lock keeps the capacity count honest.
 */
export async function acquireLease(pool: Pool, account: Account, options: { maxConcurrent: number; idleMinutes: number }): Promise<LeaseResult> {
  try {
    return await withTransaction(pool, async (client) => {
      await client.query('SELECT pg_advisory_xact_lock($1)', [CAPACITY_LOCK]);
      const existing = await liveFor(client, account.id, true);
      if (existing) return { row: (await touch(client, existing.id, options.idleMinutes)) ?? existing, created: false };
      const counts = await client.query<{ holding: string; queued: string }>(
        `SELECT count(*) FILTER (WHERE state = ANY($1)) AS holding, count(*) FILTER (WHERE state = 'queued') AS queued
           FROM student_sessions WHERE state = ANY($2)`,
        [MACHINE_STATES, LIVE],
      );
      const holding = Number(counts.rows[0]!.holding);
      const queued = Number(counts.rows[0]!.queued);
      const state: SessionState = holding < options.maxConcurrent && queued === 0 ? 'spawning' : 'queued';
      const id = randomUUID();
      const inserted = await client.query<SessionRow>(
        `INSERT INTO student_sessions (id, account_id, account_kind, state, step, machine_name, create_idempotency_key, flush_token, lease_expires_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9) RETURNING *`,
        [id, account.id, account.kind, state, state === 'spawning' ? 'create' : null, machineName(id),
          newIdempotencyKey(id, 'create'), randomBytes(32).toString('base64url'), minutesFromNow(options.idleMinutes)],
      );
      return { row: inserted.rows[0]!, created: true };
    });
  } catch (error) {
    // Another process inserted between our check and insert: theirs is the lease.
    if ((error as { code?: string }).code !== '23505') throw error;
    const row = await liveSession(pool, account.id);
    if (!row) throw error;
    return { row, created: false };
  }
}

async function liveFor(client: Pool | PoolClient, accountId: string, lock = false): Promise<SessionRow | null> {
  const result = await client.query<SessionRow>(
    `SELECT * FROM student_sessions WHERE account_id = $1 AND state = ANY($2)${lock ? ' FOR UPDATE' : ''}`,
    [accountId, LIVE],
  );
  return result.rows[0] ?? null;
}

export const liveSession = (pool: Pool, accountId: string) => liveFor(pool, accountId);

/** The most recent session of the account, live or not: GET shows how the last one ended. */
export async function latestSession(pool: Pool, accountId: string): Promise<SessionRow | null> {
  const live = await liveFor(pool, accountId);
  if (live) return live;
  const result = await pool.query<SessionRow>('SELECT * FROM student_sessions WHERE account_id = $1 ORDER BY created_at DESC LIMIT 1', [accountId]);
  return result.rows[0] ?? null;
}

export async function sessionById(pool: Pool, id: string): Promise<SessionRow | null> {
  if (!/^[0-9a-f-]{36}$/.test(id)) return null;
  const result = await pool.query<SessionRow>('SELECT * FROM student_sessions WHERE id = $1', [id]);
  return result.rows[0] ?? null;
}

async function touch(client: Pool | PoolClient, id: string, idleMinutes: number): Promise<SessionRow | null> {
  const result = await client.query<SessionRow>(
    `UPDATE student_sessions SET heartbeat_at = now(), lease_expires_at = $2, updated_at = now()
      WHERE id = $1 AND state IN ('queued', 'spawning', 'ready') RETURNING *`,
    [id, minutesFromNow(idleMinutes)],
  );
  return result.rows[0] ?? null;
}

/** Extends the lease of the account's live session. Null when there is none (or it is already stopping). */
export async function heartbeat(pool: Pool, accountId: string, idleMinutes: number): Promise<SessionRow | null> {
  const live = await liveFor(pool, accountId);
  return live ? touch(pool, live.id, idleMinutes) : null;
}

/**
 * Writes `fields` only while the row is still in one of `from` (when given). Null means the
 * row moved on (a logout, a force-end) and the caller must stop driving it.
 */
export async function updateSession(pool: Pool, id: string, fields: Partial<Writable>, from?: readonly SessionState[]): Promise<SessionRow | null> {
  const entries = Object.entries(fields).filter(([key]) => WRITABLE.has(key as keyof Writable));
  const sets = entries.map(([key], index) => `${key} = $${index + 2}`);
  const params: unknown[] = [id, ...entries.map(([, value]) => value)];
  let where = 'id = $1';
  if (from) {
    params.push([...from]);
    where += ` AND state = ANY($${params.length})`;
  }
  const result = await pool.query<SessionRow>(
    `UPDATE student_sessions SET ${[...sets, 'updated_at = now()'].join(', ')} WHERE ${where} RETURNING *`,
    params,
  );
  return result.rows[0] ?? null;
}

/** 1-based place in the queue (oldest first). */
export async function queuePosition(pool: Pool, row: SessionRow): Promise<number> {
  const result = await pool.query<{ ahead: string }>(
    "SELECT count(*) AS ahead FROM student_sessions WHERE state = 'queued' AND (created_at, id) < ($1, $2)",
    [row.created_at, row.id],
  );
  return Number(result.rows[0]!.ahead) + 1;
}

/** Moves the oldest queued sessions into `spawning` while machine slots are free. Returns their ids. */
export async function promoteQueued(pool: Pool, maxConcurrent: number): Promise<string[]> {
  return withTransaction(pool, async (client) => {
    await client.query('SELECT pg_advisory_xact_lock($1)', [CAPACITY_LOCK]);
    const holding = await client.query<{ n: string }>('SELECT count(*) AS n FROM student_sessions WHERE state = ANY($1)', [MACHINE_STATES]);
    const free = maxConcurrent - Number(holding.rows[0]!.n);
    if (free <= 0) return [];
    const promoted = await client.query<{ id: string }>(
      `UPDATE student_sessions SET state = 'spawning', step = 'create', updated_at = now()
        WHERE id IN (SELECT id FROM student_sessions WHERE state = 'queued' ORDER BY created_at, id LIMIT $1 FOR UPDATE)
        RETURNING id`,
      [free],
    );
    return promoted.rows.map((r) => r.id);
  });
}

export async function sessionsInState(pool: Pool, states: readonly SessionState[]): Promise<SessionRow[]> {
  const result = await pool.query<SessionRow>('SELECT * FROM student_sessions WHERE state = ANY($1) ORDER BY created_at, id', [[...states]]);
  return result.rows;
}

/**
 * Ready (or queued) sessions whose heartbeat is older than the idle window, or whose lease ran
 * out. A spawning row is left to its own per-step timeouts; once ready, the same rule applies.
 */
export async function idleSessions(pool: Pool, idleMinutes: number): Promise<SessionRow[]> {
  const result = await pool.query<SessionRow>(
    `SELECT * FROM student_sessions
      WHERE state IN ('queued', 'ready')
        AND (heartbeat_at < now() - make_interval(mins => $1) OR lease_expires_at < now())
      ORDER BY created_at`,
    [idleMinutes],
  );
  return result.rows;
}

/** Does the orchestrator's table exist? The uni does not migrate on boot, so check before running. */
export async function sessionsTableReady(pool: Pool): Promise<boolean> {
  const result = await pool.query<{ ok: boolean }>("SELECT to_regclass('student_sessions') IS NOT NULL AS ok");
  return Boolean(result.rows[0]?.ok);
}
