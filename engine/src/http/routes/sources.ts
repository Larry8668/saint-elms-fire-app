import path from 'node:path';
import { Hono } from 'hono';
import { z } from 'zod';
import { JobConflictError, JobStateError, SourceIngestor, SourceRejection } from '../../brain/sources/ingest';
import { INGEST_LIMITS } from '../../brain/sources/limits';
import { requireProfile, type EngineDeps, type EngineEnv } from '../context';
import { friendlyError } from '../errors';
import type { ProfileIdentity } from '@sef/shared';
import type { Workspace } from '../../profiles/workspace';

/**
 * Source ingestion over HTTP. Every route sits behind the signed-in profile guard and
 * resolves its workspace from `c.get('ws')`, so nothing here can reach another student's
 * vault.
 */

// Base64 carries 3 bytes in 4 characters; the envelope cap derives from the decoded-byte
// limit with slack for the whitespace and padding some clients fold in.
const MAX_ENVELOPE_CHARS = Math.ceil(INGEST_LIMITS.maxSourceBytes / 3) * 4 + 4 + 64 * 1024;

const ingestBody = z
  .object({
    kind: z.enum(['note', 'document', 'image']),
    title: z.string().min(1).max(300),
    mediaType: z.string().min(1).max(120),
    // Ceiling on the envelope only; the real limit is enforced on the decoded bytes.
    data: z.string().min(1).max(MAX_ENVELOPE_CHARS),
  })
  .strict();

/**
 * The identity a source is filed under, taken from the workspace rather than the request so
 * a client cannot file someone else's material.
 *
 * `DeviceProfile.programmeId` is learned at device sign-in from the enrolment. Profiles
 * created before that field existed fall back to the cohort — the honest scope the engine
 * can assert — and a profile with neither is refused rather than filed under a fake id.
 */
const identityOf = (ws: Workspace, uniServerUrl: string): ProfileIdentity => {
  const programmeId = ws.profile.programmeId ?? (ws.profile.cohortId || undefined);
  if (!programmeId) {
    throw new SourceRejection('This profile is not linked to a programme yet. Sign in online once more first.', 'no_programme', 409);
  }
  return { issuer: uniServerUrl, studentId: ws.profile.id, programmeId };
};

/**
 * Decodes a base64 envelope — standard or URL-safe alphabet, whitespace tolerated.
 * `Buffer.from` decodes permissively, so the input is confirmed by a round trip rather
 * than trusted; anything that cannot re-encode to itself is refused.
 */
export function decodeSourceBytes(data: string): Uint8Array | null {
  try {
    const canonical = data.replace(/\s+/g, '').replace(/-/g, '+').replace(/_/g, '/');
    const buffer = Buffer.from(canonical, 'base64');
    if (buffer.toString('base64').replace(/=+$/, '') !== canonical.replace(/=+$/, '')) return null;
    return new Uint8Array(buffer);
  } catch {
    return null;
  }
}

export function sourceRoutes(deps: EngineDeps) {
  const app = new Hono<EngineEnv>();
  // Workspace features are for admitted students: a pending applicant can sign in but
  // cannot file material into a vault.
  const guard = requireProfile(deps, { approved: true });

  const ingestorFor = async (ws: Workspace): Promise<SourceIngestor> => {
    const { uniServerUrl } = await ws.settings.get();
    return new SourceIngestor(ws.wiki, path.join(ws.paths.brain, 'jobs'), async () => identityOf(ws, uniServerUrl));
  };

  app.get('/sources', guard, async (c) => {
    try {
      return c.json(await (await ingestorFor(c.get('ws'))).list());
    } catch (error) {
      if (error instanceof SourceRejection) return c.json({ error: error.message, code: error.code }, error.status);
      throw error;
    }
  });

  /**
   * Accepts a source as a JSON envelope with base64 bytes rather than a multipart upload.
   * That keeps the size limit enforceable in exactly one place, and matches how the chat
   * route already carries images.
   */
  app.post('/sources', guard, async (c) => {
    const parsed = ingestBody.safeParse(await c.req.json().catch(() => null));
    if (!parsed.success) return c.json({ error: 'Send a kind, title, mediaType and base64 data', code: 'invalid_request' }, 400);

    const { kind, title, mediaType, data } = parsed.data;
    const bytes = decodeSourceBytes(data);
    if (!bytes) return c.json({ error: 'That file could not be decoded', code: 'undecodable' }, 400);

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
