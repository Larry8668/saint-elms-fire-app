import { isDeepStrictEqual } from 'node:util';
import type { Pool, PoolClient } from 'pg';
import {
  CONTRACT_VERSION,
  SharePayloadSchema,
  type AdminShareView,
  type PublishedShare,
  type ShareModerationView,
  type SharePayload,
} from '@sef/shared';
import { recordAuditEvent } from './audit-events';

export class ShareError extends Error {
  readonly code: 'quota_exceeded' | 'idempotency_conflict' | 'not_found' | 'not_author' | 'not_published' | 'invalid_cursor';
  constructor(code: ShareError['code'], message: string) {
    super(message);
    this.name = 'ShareError';
    this.code = code;
  }
}

export interface PublishedShareRow {
  id: string;
  student_profile_id: string;
  programme_code: string;
  cohort_code: string;
  sender_name: string;
  idempotency_key: string;
  state: 'published' | 'withdrawn';
  payload: unknown;
  payload_bytes: number;
  revision: number;
  created_at: Date;
  updated_at: Date;
  withdrawn_at: Date | null;
}

interface ShareCursor {
  createdAt: Date;
  id: string;
}

export function decodeShareCursor(raw: string | undefined): ShareCursor | null {
  if (!raw) return null;
  try {
    const parsed = JSON.parse(Buffer.from(raw, 'base64url').toString('utf8')) as { t?: unknown; i?: unknown };
    if (typeof parsed?.t !== 'string' || typeof parsed?.i !== 'string') throw new ShareError('invalid_cursor', 'Malformed cursor');
    const millis = Date.parse(parsed.t);
    if (!Number.isFinite(millis) || !/^[0-9a-f-]{36}$/.test(parsed.i)) throw new ShareError('invalid_cursor', 'Malformed cursor');
    return { createdAt: new Date(millis), id: parsed.i };
  } catch (error) {
    if (error instanceof ShareError) throw error;
    throw new ShareError('invalid_cursor', 'Malformed cursor');
  }
}

const encodeShareCursor = (row: PublishedShareRow): string =>
  Buffer.from(JSON.stringify({ t: row.created_at.toISOString(), i: row.id }), 'utf8').toString('base64url');

export function rowToPublishedShare(row: PublishedShareRow): PublishedShare {
  return {
    schemaVersion: CONTRACT_VERSION,
    id: row.id,
    revision: String(row.revision),
    senderId: row.student_profile_id,
    senderName: row.sender_name,
    programmeId: row.programme_code,
    cohortId: row.cohort_code,
    createdAt: row.created_at.toISOString(),
    state: row.state,
    payload: SharePayloadSchema.parse(row.payload),
  };
}

/**
 * Publishes a share stamped from the caller's approved enrolment. The advisory
 * lock serializes a student's publishes so the rolling-24h quota holds under
 * concurrent retries; the (profile, key) unique index makes retries replay the
 * original record instead of duplicating it. A key reused with a different
 * payload or authority claim conflicts rather than silently diverging.
 */
export async function publishShare(
  pool: Pool,
  input: {
    profileId: string;
    senderName: string;
    programmeCode: string;
    cohortCode: string;
    idempotencyKey: string;
    payload: SharePayload;
    payloadBytes: number;
    perDay: number;
    actor: string;
  },
): Promise<{ row: PublishedShareRow; replayed: boolean }> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query('SELECT pg_advisory_xact_lock(hashtext($1))', [input.profileId]);

    const existing = await client.query<PublishedShareRow>(
      'SELECT * FROM published_shares WHERE student_profile_id = $1 AND idempotency_key = $2',
      [input.profileId, input.idempotencyKey],
    );
    const replay = existing.rows[0];
    if (replay) {
      const same =
        replay.programme_code === input.programmeCode &&
        replay.cohort_code === input.cohortCode &&
        isDeepStrictEqual(replay.payload, input.payload);
      if (!same) {
        throw new ShareError('idempotency_conflict', 'Idempotency key was already used with a different payload');
      }
      await client.query('COMMIT');
      return { row: replay, replayed: true };
    }

    const quota = await client.query<{ count: number }>(
      `SELECT count(*)::int AS count FROM published_shares
       WHERE student_profile_id = $1 AND created_at > now() - interval '24 hours'`,
      [input.profileId],
    );
    if (quota.rows[0]!.count >= input.perDay) {
      throw new ShareError('quota_exceeded', `Share quota of ${input.perDay} per 24h reached`);
    }

    const inserted = await client.query<PublishedShareRow>(
      `INSERT INTO published_shares
         (student_profile_id, programme_code, cohort_code, sender_name, idempotency_key, payload, payload_bytes)
       VALUES ($1, $2, $3, $4, $5, $6, $7)
       RETURNING *`,
      [input.profileId, input.programmeCode, input.cohortCode, input.senderName,
       input.idempotencyKey, JSON.stringify(input.payload), input.payloadBytes],
    );
    const row = inserted.rows[0]!;
    await recordAuditEvent(client, {
      actor: input.actor,
      event: 'share.published',
      subjectType: 'published_share',
      subjectId: row.id,
      details: { programme: input.programmeCode, cohort: input.cohortCode },
    });
    await client.query('COMMIT');
    return { row, replayed: false };
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
}

export interface SharePage {
  rows: PublishedShareRow[];
  nextCursor: string | null;
}

const pageOf = (rows: PublishedShareRow[], limit: number): SharePage => ({
  rows: rows.slice(0, limit),
  nextCursor: rows.length > limit ? encodeShareCursor(rows[limit - 1]!) : null,
});

export async function listPublishedShares(
  pool: Pool,
  input: { cohortCode: string; cursor: ShareCursor | null; limit: number },
): Promise<SharePage> {
  const params: unknown[] = [input.cohortCode];
  let clause = '';
  if (input.cursor) {
    params.push(input.cursor.createdAt.toISOString(), input.cursor.id);
    clause = 'AND (created_at, id) < ($2::timestamptz, $3::uuid)';
  }
  params.push(input.limit + 1);
  const result = await pool.query<PublishedShareRow>(
    `SELECT * FROM published_shares
     WHERE cohort_code = $1 AND state = 'published' ${clause}
     ORDER BY created_at DESC, id DESC
     LIMIT $${params.length}`,
    params,
  );
  return pageOf(result.rows, input.limit);
}

export async function getPublishedShare(pool: Pool | PoolClient, id: string): Promise<PublishedShareRow | null> {
  const result = await pool.query<PublishedShareRow>('SELECT * FROM published_shares WHERE id = $1', [id]);
  return result.rows[0] ?? null;
}

/** The author's own withdrawal: state-flips, bumps the revision and journals the event. */
export async function withdrawShare(
  pool: Pool,
  input: { shareId: string; profileId: string; actor: string },
): Promise<PublishedShareRow> {
  return transitionShare(pool, { shareId: input.shareId, action: 'withdraw', actor: input.actor, note: null }, input.profileId);
}

/** Staff removal of a published share — audited, and only valid on live items. */
export async function removeShare(
  pool: Pool,
  input: { shareId: string; actor: string; note: string | null },
): Promise<PublishedShareRow> {
  return transitionShare(pool, { shareId: input.shareId, action: 'remove', actor: input.actor, note: input.note }, null);
}

async function transitionShare(
  pool: Pool,
  input: { shareId: string; action: 'withdraw' | 'remove'; actor: string; note: string | null },
  authorOnly: string | null,
): Promise<PublishedShareRow> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const found = await client.query<PublishedShareRow>(
      'SELECT * FROM published_shares WHERE id = $1 FOR UPDATE',
      [input.shareId],
    );
    const share = found.rows[0];
    if (!share) throw new ShareError('not_found', 'Share not found');
    if (authorOnly !== null && share.student_profile_id !== authorOnly) {
      throw new ShareError('not_author', 'Only the author can withdraw a share');
    }
    if (input.action === 'remove' && share.state !== 'published') {
      throw new ShareError('not_published', 'Only published shares can be removed');
    }
    if (share.state === 'withdrawn') {
      await client.query('COMMIT');
      return share;
    }
    const updated = await client.query<PublishedShareRow>(
      `UPDATE published_shares
       SET state = 'withdrawn', withdrawn_at = now(), revision = revision + 1, updated_at = now()
       WHERE id = $1
       RETURNING *`,
      [share.id],
    );
    const row = updated.rows[0]!;
    await client.query(
      `INSERT INTO share_moderation_events (share_id, action, actor_subject, note) VALUES ($1, $2, $3, $4)`,
      [share.id, input.action, input.actor, input.note],
    );
    await recordAuditEvent(client, {
      actor: input.actor,
      event: input.action === 'remove' ? 'share.removed' : 'share.withdrawn',
      subjectType: 'published_share',
      subjectId: share.id,
      details: { cohort: share.cohort_code },
    });
    await client.query('COMMIT');
    return row;
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
}

export interface ModeratedShareRow extends PublishedShareRow {
  mod_action: 'withdraw' | 'remove' | null;
  mod_actor: string | null;
  mod_note: string | null;
  mod_occurred_at: Date | null;
}

export async function listSharesForModeration(
  pool: Pool,
  input: { cohortCode?: string; state?: 'published' | 'withdrawn'; cursor: ShareCursor | null; limit: number },
): Promise<{ rows: ModeratedShareRow[]; nextCursor: string | null }> {
  const params: unknown[] = [];
  const clauses: string[] = [];
  if (input.cohortCode) {
    params.push(input.cohortCode);
    clauses.push(`s.cohort_code = $${params.length}`);
  }
  if (input.state) {
    params.push(input.state);
    clauses.push(`s.state = $${params.length}`);
  }
  if (input.cursor) {
    params.push(input.cursor.createdAt.toISOString(), input.cursor.id);
    clauses.push(`(s.created_at, s.id) < ($${params.length - 1}::timestamptz, $${params.length}::uuid)`);
  }
  params.push(input.limit + 1);
  const where = clauses.length > 0 ? `WHERE ${clauses.join(' AND ')}` : '';
  const result = await pool.query<ModeratedShareRow>(
    `SELECT s.*, m.action AS mod_action, m.actor_subject AS mod_actor, m.note AS mod_note, m.occurred_at AS mod_occurred_at
     FROM published_shares s
     LEFT JOIN LATERAL (
       SELECT action, actor_subject, note, occurred_at
       FROM share_moderation_events
       WHERE share_id = s.id
       ORDER BY occurred_at DESC
       LIMIT 1
     ) m ON true
     ${where}
     ORDER BY s.created_at DESC, s.id DESC
     LIMIT $${params.length}`,
    params,
  );
  const page = pageOf(result.rows, input.limit);
  return { rows: page.rows as ModeratedShareRow[], nextCursor: page.nextCursor };
}

export async function listShareEvents(pool: Pool | PoolClient, shareId: string): Promise<ShareModerationView[]> {
  const result = await pool.query<{
    action: 'withdraw' | 'remove';
    actor_subject: string;
    note: string | null;
    occurred_at: Date;
  }>(
    `SELECT action, actor_subject, note, occurred_at FROM share_moderation_events
     WHERE share_id = $1 ORDER BY occurred_at`,
    [shareId],
  );
  return result.rows.map((row) => ({
    action: row.action,
    actorSubject: row.actor_subject,
    note: row.note,
    occurredAt: row.occurred_at.toISOString(),
  }));
}

export function rowToAdminShareView(row: ModeratedShareRow): AdminShareView {
  return {
    ...rowToPublishedShare(row),
    lastModeration: row.mod_action
      ? {
          action: row.mod_action,
          actorSubject: row.mod_actor!,
          note: row.mod_note,
          occurredAt: row.mod_occurred_at!.toISOString(),
        }
      : null,
  };
}

export async function countPublishedSharesSince(pool: Pool, since: Date): Promise<number> {
  const result = await pool.query<{ count: number }>(
    'SELECT count(*)::int AS count FROM published_shares WHERE created_at > $1',
    [since],
  );
  return result.rows[0]!.count;
}
