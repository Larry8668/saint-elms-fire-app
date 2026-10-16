import { Hono } from 'hono';
import type { ContentfulStatusCode } from 'hono/utils/http-status';
import { z } from 'zod';
import { JobConflictError, JobStateError, SourceRejection } from '../../brain/sources/ingest';
import { ProposalStateError } from '../../brain/compiler/compile';
import { VaultConflictError } from '../../brain/vault-errors';
import { INGEST_LIMITS } from '../../brain/sources/limits';
import { requireProfile, type EngineDeps, type EngineEnv } from '../context';
import { friendlyError } from '../errors';

/**
 * Source ingestion and the wiki proposal pipeline over HTTP. Every route sits behind the
 * signed-in profile guard and resolves its workspace from `c.get('ws')`, so nothing here
 * can reach another student's vault.
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

const rejectBody = z.object({ note: z.string().max(500).optional() }).strict();

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

  const handled = (error: unknown, fallbackCode: string): { body: { error: string; code: string; details?: unknown }; status: ContentfulStatusCode } => {
    if (error instanceof SourceRejection) return { body: { error: error.message, code: error.code }, status: error.status };
    if (error instanceof JobConflictError) return { body: { error: error.message, code: 'job_conflict' }, status: 404 };
    if (error instanceof JobStateError) return { body: { error: error.message, code: 'job_state' }, status: 409 };
    if (error instanceof ProposalStateError) return { body: { error: error.message, code: 'proposal_state' }, status: 409 };
    if (error instanceof VaultConflictError) return { body: { error: error.message, code: 'stale_proposal', details: error.details }, status: 409 };
    return { body: { error: friendlyError(error), code: fallbackCode }, status: 500 };
  };

  app.get('/sources', guard, async (c) => {
    try {
      return c.json(await c.get('ws').sources.list());
    } catch (error) {
      const { body, status } = handled(error, 'list_failed');
      return c.json(body, status);
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
      const result = await c.get('ws').sources.ingest({ kind, title, mediaType, bytes });
      return c.json(result, 201);
    } catch (error) {
      const { body, status } = handled(error, 'ingest_failed');
      return c.json(body, status);
    }
  });

  /**
   * Runs the compile stage: keeper draft → normalized proposal → awaiting review. Stays
   * synchronous so a caller gets the proposal id or an honest no_changes/failed answer.
   */
  app.post('/sources/:jobId/compile', guard, async (c) => {
    try {
      const result = await c.get('ws').compiler.compileJob(c.req.param('jobId'));
      return c.json(result, 200);
    } catch (error) {
      const { body, status } = handled(error, 'compile_failed');
      return c.json(body, status);
    }
  });

  app.post('/sources/:jobId/cancel', guard, async (c) => {
    try {
      await c.get('ws').sources.cancel(c.req.param('jobId'));
      return c.body(null, 204);
    } catch (error) {
      const { body, status } = handled(error, 'cancel_failed');
      return c.json(body, status);
    }
  });

  app.post('/sources/:jobId/retry', guard, async (c) => {
    try {
      await c.get('ws').sources.retry(c.req.param('jobId'));
      return c.body(null, 202);
    } catch (error) {
      const { body, status } = handled(error, 'retry_failed');
      return c.json(body, status);
    }
  });

  app.get('/proposals', guard, async (c) => {
    try {
      return c.json(await c.get('ws').compiler.listProposals());
    } catch (error) {
      const { body, status } = handled(error, 'proposals_failed');
      return c.json(body, status);
    }
  });

  app.get('/proposals/:id', guard, async (c) => {
    try {
      const preview = await c.get('ws').compiler.preview(c.req.param('id'));
      if (!preview) return c.json({ error: 'Proposal not found', code: 'not_found' }, 404);
      return c.json(preview);
    } catch (error) {
      const { body, status } = handled(error, 'proposal_failed');
      return c.json(body, status);
    }
  });

  /** Accept applies the proposal through the journal; a stale proposal answers 409. */
  app.post('/proposals/:id/accept', guard, async (c) => {
    try {
      const { record, report } = await c.get('ws').compiler.accept(c.req.param('id'));
      return c.json({ record, report });
    } catch (error) {
      const { body, status } = handled(error, 'accept_failed');
      return c.json(body, status);
    }
  });

  app.post('/proposals/:id/reject', guard, async (c) => {
    const parsed = rejectBody.safeParse(await c.req.json().catch(() => ({})));
    if (!parsed.success) return c.json({ error: 'Send an optional note', code: 'invalid_request' }, 400);
    try {
      return c.json(await c.get('ws').compiler.reject(c.req.param('id'), parsed.data.note));
    } catch (error) {
      const { body, status } = handled(error, 'reject_failed');
      return c.json(body, status);
    }
  });

  return app;
}
