import path from 'node:path';
import { Hono } from 'hono';
import { z } from 'zod';
import { JobConflictError, JobStateError, SourceIngestor, SourceRejection } from '../../brain/sources/ingest';
import { requireProfile, type EngineDeps, type EngineEnv } from '../context';
import { friendlyError } from '../errors';
import type { ProfileIdentity } from '@sef/shared';
import type { Workspace } from '../../profiles/workspace';

/**
 * Source ingestion over HTTP. Every route sits behind the signed-in profile guard and
 * resolves its workspace from `c.get('ws')`, so nothing here can reach another student's
 * vault.
 */

const ingestBody = z
  .object({
    kind: z.enum(['note', 'document', 'image']),
    title: z.string().min(1).max(300),
    mediaType: z.string().min(1).max(120),
    // Ceiling on the envelope only; the real limit is enforced on the decoded bytes.
    data: z.string().min(1).max(44 * 1024 * 1024),
  })
  .strict();

/**
 * The identity a source is filed under, taken from the workspace rather than the request so
 * a client cannot file someone else's material.
 *
 * `DeviceProfile` carries no programme id of its own — it has the cohort the student is in,
 * which is what the engine can honestly assert. That is a real gap against
 * `ProfileIdentity.programmeId`, and it is named here rather than papered over.
 */
const identityOf = (ws: Workspace, uniServerUrl: string): ProfileIdentity => ({
  issuer: uniServerUrl,
  studentId: ws.profile.id,
  programmeId: ws.profile.cohortId,
});

export function sourceRoutes(deps: EngineDeps) {
  const app = new Hono<EngineEnv>();
  const guard = requireProfile(deps);

  const ingestorFor = async (ws: Workspace): Promise<SourceIngestor> => {
    const { uniServerUrl } = await ws.settings.get();
    return new SourceIngestor(ws.wiki, path.join(ws.paths.brain, 'jobs'), async () => identityOf(ws, uniServerUrl));
  };

  app.get('/sources', guard, async (c) => c.json(await (await ingestorFor(c.get('ws'))).list()));

  /**
   * Accepts a source as a JSON envelope with base64 bytes rather than a multipart upload.
   * That keeps the size limit enforceable in exactly one place, and matches how the chat
   * route already carries images.
   */
  app.post('/sources', guard, async (c) => {
    const parsed = ingestBody.safeParse(await c.req.json().catch(() => null));
    if (!parsed.success) return c.json({ error: 'Send a kind, title, mediaType and base64 data', code: 'invalid_request' }, 400);

    const { kind, title, mediaType, data } = parsed.data;
    let bytes: Uint8Array;
    try {
      const buffer = Buffer.from(data, 'base64');
      // Base64 decodes permissively, so confirm the round trip rather than trusting it.
      if (buffer.toString('base64').replace(/=+$/, '') !== data.replace(/=+$/, '').replace(/\s+/g, '')) {
        return c.json({ error: 'That file could not be decoded', code: 'undecodable' }, 400);
      }
      bytes = new Uint8Array(buffer);
    } catch {
      return c.json({ error: 'That file could not be decoded', code: 'undecodable' }, 400);
    }

    try {
      const result = await (await ingestorFor(c.get('ws'))).ingest({ kind, title, mediaType, bytes });
      return c.json(result, 201);
    } catch (error) {
      if (error instanceof SourceRejection) return c.json({ error: error.message, code: error.code }, error.status);
      if (error instanceof JobConflictError) return c.json({ error: error.message, code: 'job_conflict' }, 404);
      if (error instanceof JobStateError) return c.json({ error: error.message, code: 'job_state' }, 409);
      return c.json({ error: friendlyError(error), code: 'ingest_failed' }, 500);
    }
  });

  app.post('/sources/:jobId/cancel', guard, async (c) => {
    try {
      await (await ingestorFor(c.get('ws'))).cancel(c.req.param('jobId'));
      return c.body(null, 204);
    } catch (error) {
      if (error instanceof JobConflictError) return c.json({ error: error.message, code: 'job_conflict' }, 404);
      if (error instanceof JobStateError) return c.json({ error: error.message, code: 'job_state' }, 409);
      return c.json({ error: friendlyError(error), code: 'cancel_failed' }, 500);
    }
  });

  app.post('/sources/:jobId/retry', guard, async (c) => {
    try {
      await (await ingestorFor(c.get('ws'))).retry(c.req.param('jobId'));
      return c.body(null, 202);
    } catch (error) {
      if (error instanceof JobConflictError) return c.json({ error: error.message, code: 'job_conflict' }, 404);
      if (error instanceof JobStateError) return c.json({ error: error.message, code: 'job_state' }, 409);
      return c.json({ error: friendlyError(error), code: 'retry_failed' }, 500);
    }
  });

  return app;
}
