import { Hono } from 'hono';
import {
  CONTRACT_VERSION,
  PublishShareRequestSchema,
  type ShareFeedPage,
} from '@sef/shared';
import { requireAdmission, type AppEnv } from '../authorization';
import { config } from '../config';
import type { UniDeps } from '../deps';
import { log } from '../logger';
import {
  decodeShareCursor,
  getPublishedShare,
  listPublishedShares,
  publishShare,
  rowToPublishedShare,
  ShareError,
  withdrawShare,
} from '../shares';

const FEED_DEFAULT_LIMIT = 20;
const FEED_MAX_LIMIT = 50;

const parseLimit = (raw: string | undefined): number =>
  Math.min(FEED_MAX_LIMIT, Math.max(1, Number(raw) || FEED_DEFAULT_LIMIT));

export const shareErrorStatus = (code: ShareError['code']): 400 | 403 | 404 | 409 | 429 => {
  switch (code) {
    case 'quota_exceeded':
      return 429;
    case 'idempotency_conflict':
    case 'not_published':
      return 409;
    case 'invalid_cursor':
      return 400;
    case 'not_author':
      return 403;
    default:
      return 404;
  }
};

/**
 * Cohort sharing for admitted students. Sender, programme and cohort are stamped
 * from the caller's live approved enrolment — the body can only describe content.
 * Legacy sef1 tokens never reach these handlers — except, under SEED_DEMO, a demo
 * persona's own student token, which resolves to that persona's seeded admission rows
 * (demo-admission.ts). Either way a share can never outlive its author's admission record.
 */
export function shareRoutes(deps: UniDeps) {
  const app = new Hono<AppEnv>();
  const approved = requireAdmission(deps, { approved: true, demoLegacy: true });

  app.post('/shares', approved, async (c) => {
    const parsed = PublishShareRequestSchema.safeParse(await c.req.json().catch(() => null));
    if (!parsed.success) return c.json({ error: 'invalid_share', issues: parsed.error.issues }, 400);
    const { programmeId, idempotencyKey, payload } = parsed.data;
    const admission = c.get('admission');
    const enrolment = admission.enrolment!;
    if (programmeId !== enrolment.programme_code) return c.json({ error: 'programme_mismatch' }, 403);
    const markdownBytes = Buffer.byteLength(payload.markdown, 'utf8');
    if (markdownBytes > config.shareMaxBytes) return c.json({ error: 'share_too_large' }, 413);
    const oversized = payload.attachments.find((attachment) => attachment.bytes > config.shareAttachmentMaxBytes);
    if (oversized) return c.json({ error: 'attachment_too_large' }, 400);

    const profile = admission.profile!;
    const senderName = (profile.preferred_name ?? profile.legal_name).slice(0, 80);
    try {
      const { row, replayed } = await publishShare(deps.pool!, {
        profileId: profile.id,
        senderName,
        programmeCode: enrolment.programme_code,
        cohortCode: enrolment.cohort_code!,
        idempotencyKey,
        payload,
        payloadBytes: Buffer.byteLength(JSON.stringify(payload), 'utf8'),
        perDay: config.sharesPerDay,
        actor: c.get('principal').userId,
      });
      if (!replayed) log.info('share_published', { cohortId: row.cohort_code });
      return c.json(rowToPublishedShare(row), replayed ? 200 : 201);
    } catch (error) {
      if (error instanceof ShareError) return c.json({ error: error.code }, shareErrorStatus(error.code));
      throw error;
    }
  });

  app.get('/shares', approved, async (c) => {
    const limit = parseLimit(c.req.query('limit'));
    let cursor = null;
    try {
      cursor = decodeShareCursor(c.req.query('cursor'));
    } catch (error) {
      if (error instanceof ShareError) return c.json({ error: error.code }, 400);
      throw error;
    }
    const { rows, nextCursor } = await listPublishedShares(deps.pool!, {
      cohortCode: c.get('admission').enrolment!.cohort_code!,
      cursor,
      limit,
    });
    const body: ShareFeedPage = {
      schemaVersion: CONTRACT_VERSION,
      items: rows.map(rowToPublishedShare),
      nextCursor,
    };
    return c.json(body);
  });

  app.get('/shares/:id', approved, async (c) => {
    const share = await getPublishedShare(deps.pool!, c.req.param('id'));
    const admission = c.get('admission');
    // Cross-cohort and unknown ids look identical: peers cannot probe share existence.
    if (!share || share.cohort_code !== admission.enrolment!.cohort_code) {
      return c.json({ error: 'not_found' }, 404);
    }
    if (share.state !== 'published' && share.student_profile_id !== admission.profile!.id) {
      return c.json({ error: 'not_found' }, 404);
    }
    return c.json(rowToPublishedShare(share));
  });

  app.post('/shares/:id/withdraw', approved, async (c) => {
    try {
      const row = await withdrawShare(deps.pool!, {
        shareId: c.req.param('id'),
        profileId: c.get('admission').profile!.id,
        actor: c.get('principal').userId,
      });
      log.info('share_withdrawn', { cohortId: row.cohort_code });
      return c.json(rowToPublishedShare(row));
    } catch (error) {
      if (error instanceof ShareError) {
        // A foreign share id and a missing one are indistinguishable to the caller.
        const status = error.code === 'not_author' ? 404 : shareErrorStatus(error.code);
        return c.json({ error: error.code === 'not_author' ? 'not_found' : error.code }, status);
      }
      throw error;
    }
  });

  return app;
}
