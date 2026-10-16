import { Hono } from 'hono';
import type { ContentfulStatusCode } from 'hono/utils/http-status';
import { z } from 'zod';
import {
  CONTRACT_VERSION,
  IdentifierSchema,
  LogisticsListSchema,
  LogisticsRecordResultSchema,
  LogisticsWriteSchema,
} from '@sef/shared';
import { errorFields, log } from '../../config';
import { extractLogistics } from '../../logistics/extract';
import { LogisticsNotFound, LogisticsStateError } from '../../logistics/store';
import { resolveModel } from '../../models/registry';
import { requireProfile, type EngineDeps, type EngineEnv } from '../context';
import { friendlyError } from '../errors';

/**
 * The student's private logistics, behind the same profile guard as everything else in
 * their workspace — `c.get('ws')` scopes every read and write to the signed-in student.
 * Proposals can only be confirmed or dismissed by the student; nothing here publishes.
 */
export function logisticsRoutes(deps: EngineDeps) {
  const app = new Hono<EngineEnv>();
  const guard = requireProfile(deps, { approved: true });

  const handled = (error: unknown, fallbackCode: string): { body: { error: string; code: string }; status: ContentfulStatusCode } => {
    if (error instanceof LogisticsNotFound) return { body: { error: error.message, code: 'not_found' }, status: 404 };
    if (error instanceof LogisticsStateError) return { body: { error: error.message, code: 'logistics_state' }, status: 409 };
    return { body: { error: friendlyError(error), code: fallbackCode }, status: 500 };
  };

  app.get('/logistics', guard, async (c) => {
    const items = await c.get('ws').logistics.list();
    return c.json(LogisticsListSchema.parse({ schemaVersion: CONTRACT_VERSION, items }));
  });

  /** A typed record is the student's own statement — it is confirmed at birth. */
  app.post('/logistics', guard, async (c) => {
    const body = LogisticsWriteSchema.safeParse(await c.req.json().catch(() => null));
    if (!body.success) return c.json({ error: 'Send title, kind, dueAt, allDay, timeZone and details', code: 'invalid_request', issues: body.error.issues }, 400);
    const record = await c.get('ws').logistics.create(body.data, { kind: 'manual' });
    log.info('logistics_created', { profileId: c.get('me').profile.id, recordId: record.id });
    return c.json(LogisticsRecordResultSchema.parse({ schemaVersion: CONTRACT_VERSION, record }), 201);
  });

  app.put('/logistics/:id', guard, async (c) => {
    const id = IdentifierSchema.safeParse(c.req.param('id'));
    if (!id.success) return c.json({ error: 'Record not found', code: 'not_found' }, 404);
    const body = LogisticsWriteSchema.partial().safeParse(await c.req.json().catch(() => null));
    if (!body.success) return c.json({ error: 'Send the fields to update', code: 'invalid_request', issues: body.error.issues }, 400);
    try {
      const record = await c.get('ws').logistics.update(id.data, body.data);
      return c.json(LogisticsRecordResultSchema.parse({ schemaVersion: CONTRACT_VERSION, record }));
    } catch (error) {
      const { body: b, status } = handled(error, 'update_failed');
      return c.json(b, status);
    }
  });

  /** Confirmation is the student's alone; edits may ride along so one click fixes and files. */
  app.post('/logistics/:id/confirm', guard, async (c) => {
    const id = IdentifierSchema.safeParse(c.req.param('id'));
    if (!id.success) return c.json({ error: 'Record not found', code: 'not_found' }, 404);
    const body = LogisticsWriteSchema.partial().safeParse(await c.req.json().catch(() => ({})));
    if (!body.success) return c.json({ error: 'Send optional field edits alongside the confirmation', code: 'invalid_request', issues: body.error.issues }, 400);
    try {
      const record = await c.get('ws').logistics.confirm(id.data, body.data);
      log.info('logistics_confirmed', { profileId: c.get('me').profile.id, recordId: record.id });
      return c.json(LogisticsRecordResultSchema.parse({ schemaVersion: CONTRACT_VERSION, record }));
    } catch (error) {
      const { body: b, status } = handled(error, 'confirm_failed');
      return c.json(b, status);
    }
  });

  app.post('/logistics/:id/dismiss', guard, async (c) => {
    const id = IdentifierSchema.safeParse(c.req.param('id'));
    if (!id.success) return c.json({ error: 'Record not found', code: 'not_found' }, 404);
    try {
      const record = await c.get('ws').logistics.dismiss(id.data);
      return c.json(LogisticsRecordResultSchema.parse({ schemaVersion: CONTRACT_VERSION, record }));
    } catch (error) {
      const { body: b, status } = handled(error, 'dismiss_failed');
      return c.json(b, status);
    }
  });

  app.delete('/logistics/:id', guard, async (c) => {
    const id = IdentifierSchema.safeParse(c.req.param('id'));
    if (!id.success) return c.json({ error: 'Record not found', code: 'not_found' }, 404);
    if (!(await c.get('ws').logistics.remove(id.data))) return c.json({ error: 'Record not found', code: 'not_found' }, 404);
    return c.body(null, 204);
  });

  /**
   * The standalone entry to the same pipeline the Friend runs on image turns: a notice
   * photo becomes proposed records — never confirmed ones. The model's failure, a
   * privacy verdict or an empty read all answer honestly; nothing is invented.
   */
  app.post('/logistics/extract', guard, async (c) => {
    const body = z
      .strictObject({
        image: z.strictObject({ mimeType: z.enum(['image/png', 'image/jpeg']), data: z.string().min(1).max(12000000) }),
        note: z.string().max(300).optional(),
      })
      .safeParse(await c.req.json().catch(() => null));
    if (!body.success) return c.json({ error: 'Send an image (png/jpeg) as base64', code: 'invalid_request' }, 400);
    const ws = c.get('ws');
    try {
      const resolved = resolveModel(await ws.settings.get(), 'vision');
      const outcome = await extractLogistics({ kind: 'image', ...body.data.image }, resolved, ws.logistics, { note: body.data.note });
      if (!outcome.ok) {
        log.warn('logistics_extract_route_failed', { profileId: ws.profile.id, reason: outcome.reason });
        return c.json({ error: outcome.message, code: outcome.reason === 'privacy' ? 'privacy' : 'extraction_failed' }, outcome.reason === 'privacy' ? 422 : 503);
      }
      log.info('logistics_extract_route_done', { profileId: ws.profile.id, proposed: outcome.proposed.length });
      return c.json(LogisticsListSchema.parse({ schemaVersion: CONTRACT_VERSION, items: outcome.proposed }), 201);
    } catch (error) {
      const { body: b, status } = handled(error, 'extraction_failed');
      return c.json(b, status);
    }
  });

  return app;
}
