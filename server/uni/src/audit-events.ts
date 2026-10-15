import type { Pool, PoolClient } from 'pg';
import { log } from './logger';

export interface AuditEventInput {
  /** Account subject or service actor; never an email or free-form identity claim. */
  actor: string;
  /** Dotted event name, e.g. 'enrolment.approved'. */
  event: string;
  subjectType: string;
  subjectId: string;
  details?: Record<string, unknown>;
}

export interface AuditEventRow {
  id: string;
  actor_subject: string;
  event_type: string;
  subject_type: string;
  subject_id: string;
  details: Record<string, unknown>;
  occurred_at: Date;
}

/**
 * Append-only audit trail inside the same transaction as the change it describes —
 * a decision and its record can never diverge. Details must not carry secrets or
 * PII beyond identifiers; the actor is a subject id, not an email.
 */
export async function recordAuditEvent(client: Pool | PoolClient, input: AuditEventInput): Promise<void> {
  await client.query(
    `INSERT INTO audit_events (actor_subject, event_type, subject_type, subject_id, details)
     VALUES ($1, $2, $3, $4, $5::jsonb)`,
    [input.actor, input.event, input.subjectType, input.subjectId, JSON.stringify(input.details ?? {})],
  );
  log.info('audit_event', { event: input.event, subjectType: input.subjectType, subjectId: input.subjectId });
}

export async function recentAuditEvents(pool: Pool, limit: number): Promise<AuditEventRow[]> {
  const n = Number.isFinite(limit) ? Math.min(500, Math.max(1, Math.floor(limit))) : 50;
  const result = await pool.query<AuditEventRow>(
    'SELECT id, actor_subject, event_type, subject_type, subject_id, details, occurred_at FROM audit_events ORDER BY occurred_at DESC LIMIT $1',
    [n],
  );
  return result.rows;
}
