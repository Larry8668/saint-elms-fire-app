import { Hono } from 'hono';
import type { ContentfulStatusCode } from 'hono/utils/http-status';
import { z } from 'zod';
import {
  CompileResultSchema,
  CONTRACT_VERSION,
  HttpUrlSchema,
  IdentifierSchema,
  SourceDetailSchema,
  SourceReadResultSchema,
  SourceReceiptSchema,
  VideoPreviewSchema,
} from '@sef/shared';
import { JobConflictError, JobStateError, SourceRejection } from '../../brain/sources/ingest';
import { ProposalStateError } from '../../brain/compiler/compile';
import { VaultConflictError } from '../../brain/vault-errors';
import { baseMediaType, INGEST_LIMITS, isVideoMedia, safeSourceFilename, sanitiseTitle } from '../../brain/sources/limits';
import { YouTubeError } from '../../media/youtube';
import { requireProfile, type EngineDeps, type EngineEnv } from '../context';
import { friendlyError } from '../errors';

/**
 * Source ingestion and the wiki proposal pipeline over HTTP. Every route sits behind the
 * signed-in profile guard and resolves its workspace from `c.get('ws')`, so nothing here
 * can reach another student's vault.
 */

// Base64 carries 3 bytes in 4 characters; the envelope cap derives from the largest
// decoded-byte limit (audio or video) with slack for the whitespace and padding some clients fold in.
export const MAX_ENVELOPE_CHARS = Math.ceil(Math.max(INGEST_LIMITS.maxAudioBytes, INGEST_LIMITS.maxVideoBytes) / 3) * 4 + 4 + 64 * 1024;

const ingestBody = z
  .object({
    // 'video' here is an uploaded file; a fetched link goes through /sources/video instead.
    kind: z.enum(['note', 'document', 'image', 'audio', 'video']),
    title: z.string().min(1).max(300),
    mediaType: z.string().min(1).max(120),
    // Ceiling on the envelope only; the real limit is enforced on the decoded bytes.
    data: z.string().min(1).max(MAX_ENVELOPE_CHARS),
    origin: z.enum(['student', 'external']).optional(),
    attribution: z.strictObject({ creator: z.string().trim().min(1).max(300).optional(), url: HttpUrlSchema.optional() }).optional(),
  })
  .strict();

const correctionBody = z.object({ text: z.string().min(1).max(INGEST_LIMITS.maxExtractedChars + 1) }).strict();

/** A pasted video link — the engine's allowlist names exactly why a link is refused. */
const videoBody = z.strictObject({ url: z.string().trim().min(1).max(2000) });

/** How each named video failure reaches the client. */
const VIDEO_STATUS: Record<YouTubeError['code'], ContentfulStatusCode> = {
  unsupported_url: 400,
  unsupported_host: 400,
  video_too_long: 413,
  video_too_large: 413,
  age_gated: 422,
  geo_blocked: 422,
  video_unavailable: 422,
  no_audio_stream: 422,
  video_unreachable: 502,
  preview_failed: 502,
  fetch_failed: 502,
  ytdlp_missing: 503,
  ffmpeg_missing: 503,
};

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
    if (error instanceof YouTubeError) return { body: { error: error.message, code: error.code }, status: VIDEO_STATUS[error.code] };
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

    const { kind, title, mediaType, data, origin, attribution } = parsed.data;
    const bytes = decodeSourceBytes(data);
    if (!bytes) return c.json({ error: 'That file could not be decoded', code: 'undecodable' }, 400);

    try {
      const result = await c.get('ws').sources.ingest({ kind, title, mediaType, bytes, origin, attribution });
      const extraction = result.extraction
        ? { method: result.extraction.method, text: result.extraction.text, partial: result.extraction.partial, ...(result.extraction.note ? { note: result.extraction.note } : {}) }
        : null;
      return c.json(SourceReceiptSchema.parse({ schemaVersion: CONTRACT_VERSION, source: result.source, extraction, jobId: result.jobId, reused: result.reused }), 201);
    } catch (error) {
      const { body, status } = handled(error, 'ingest_failed');
      return c.json(body, status);
    }
  });

  /**
   * The video lane's first phase: metadata only. yt-dlp dumps what a link *is* — title,
   * length, channel, thumbnail — and no media bytes move. The consent card the client
   * renders from this is what stands between a pasted URL and a download.
   */
  app.post('/sources/video-preview', guard, async (c) => {
    const parsed = videoBody.safeParse(await c.req.json().catch(() => null));
    if (!parsed.success) return c.json({ error: 'Send the video link as url', code: 'invalid_request' }, 400);
    try {
      const preview = await c.get('ws').youtube.preview(parsed.data.url);
      return c.json(VideoPreviewSchema.parse({ schemaVersion: CONTRACT_VERSION, ...preview }));
    } catch (error) {
      const { body, status } = handled(error, 'preview_failed');
      return c.json(body, status);
    }
  });

  /**
   * The second, consented phase — only ever called from the preview card's explicit
   * action: yt-dlp extracts the audio track, then the ordinary ingest path freezes those
   * bytes as a 'video' source and transcribes them like any other audio.
   */
  app.post('/sources/video', guard, async (c) => {
    const parsed = videoBody.safeParse(await c.req.json().catch(() => null));
    if (!parsed.success) return c.json({ error: 'Send the video link as url', code: 'invalid_request' }, 400);
    try {
      const fetched = await c.get('ws').youtube.fetchAudio(parsed.data.url);
      const result = await c.get('ws').sources.ingest({
        kind: 'video',
        title: sanitiseTitle(fetched.title),
        mediaType: fetched.mediaType,
        bytes: fetched.bytes,
        origin: 'external',
        attribution: { ...(fetched.uploader ? { creator: fetched.uploader } : {}), url: fetched.link.url },
        link: fetched.link,
      });
      const extraction = result.extraction
        ? { method: result.extraction.method, text: result.extraction.text, partial: result.extraction.partial, ...(result.extraction.note ? { note: result.extraction.note } : {}) }
        : null;
      return c.json(SourceReceiptSchema.parse({ schemaVersion: CONTRACT_VERSION, source: result.source, extraction, jobId: result.jobId, reused: result.reused }), 201);
    } catch (error) {
      const { body, status } = handled(error, 'ingest_failed');
      return c.json(body, status);
    }
  });

  /** The retained record, latest extraction text and covering job — a foreign id answers 404. */
  app.get('/sources/:id', guard, async (c) => {
    const id = IdentifierSchema.safeParse(c.req.param('id'));
    if (!id.success) return c.json({ error: 'Source not found', code: 'not_found' }, 404);
    try {
      const detail = await c.get('ws').sources.detail(id.data);
      if (!detail) return c.json({ error: 'Source not found', code: 'not_found' }, 404);
      return c.json(SourceDetailSchema.parse({ schemaVersion: CONTRACT_VERSION, ...detail }));
    } catch (error) {
      const { body, status } = handled(error, 'source_failed');
      return c.json(body, status);
    }
  });

  /** The original bytes — e.g. the photo shown beside its transcription while correcting it. */
  app.get('/sources/:id/raw', guard, async (c) => {
    const id = IdentifierSchema.safeParse(c.req.param('id'));
    if (!id.success) return c.json({ error: 'Source not found', code: 'not_found' }, 404);
    try {
      const raw = await c.get('ws').sources.rawBytes(id.data);
      if (!raw) return c.json({ error: 'Source not found', code: 'not_found' }, 404);
      // Preview types render inside this origin: the two image types, audio and the
      // accepted video containers, which the student replays beside their transcript.
      // Everything else — including a stored type a vault restore once planted — downloads
      // as opaque bytes, with nosniff so the declared type cannot be re-read by the browser.
      const mediaType = baseMediaType(raw.mediaType);
      const headers: Record<string, string> = { 'x-content-type-options': 'nosniff' };
      if (mediaType === 'image/png' || mediaType === 'image/jpeg' || mediaType.startsWith('audio/') || isVideoMedia(mediaType)) {
        headers['content-type'] = mediaType;
      } else {
        headers['content-type'] = 'application/octet-stream';
        headers['content-disposition'] = `attachment; filename="${safeSourceFilename(id.data, mediaType)}"`;
      }
      // A fresh copy: the pooled buffer is not transferable, and Hono's body types want
      // a Uint8Array over a plain ArrayBuffer.
      return c.body(new Uint8Array(raw.bytes), 200, headers);
    } catch (error) {
      const { body, status } = handled(error, 'source_failed');
      return c.json(body, status);
    }
  });

  /**
   * The student's own pass over the extracted text — fixing OCR, a transcription, a paste.
   * Recorded as a new ledger entry; the original bytes under raw/ never move.
   */
  app.put('/sources/:id/extraction', guard, async (c) => {
    const id = IdentifierSchema.safeParse(c.req.param('id'));
    if (!id.success) return c.json({ error: 'Source not found', code: 'not_found' }, 404);
    const parsed = correctionBody.safeParse(await c.req.json().catch(() => null));
    if (!parsed.success) return c.json({ error: 'Send the corrected text', code: 'invalid_request' }, 400);
    try {
      const detail = await c.get('ws').sources.correct(id.data, parsed.data.text);
      return c.json(SourceDetailSchema.parse({ schemaVersion: CONTRACT_VERSION, ...detail }));
    } catch (error) {
      const { body, status } = handled(error, 'correction_failed');
      return c.json(body, status);
    }
  });

  /**
   * Runs the vision reader over a kept image and records the transcription as its
   * extraction — the honest reading the student then corrects before anything compiles it.
   */
  app.post('/sources/:id/read', guard, async (c) => {
    const id = IdentifierSchema.safeParse(c.req.param('id'));
    if (!id.success) return c.json({ error: 'Source not found', code: 'not_found' }, 404);
    try {
      const ws = c.get('ws');
      const result = await ws.brain.readImageSource(id.data);
      if (!result) return c.json({ error: 'Source not found', code: 'not_found' }, 404);
      const detail = await ws.sources.detail(id.data);
      if (!detail) return c.json({ error: 'Source not found', code: 'not_found' }, 404);
      return c.json(SourceReadResultSchema.parse({ schemaVersion: CONTRACT_VERSION, detail: { schemaVersion: CONTRACT_VERSION, ...detail }, reading: result.reading }));
    } catch (error) {
      const { body, status } = handled(error, 'read_failed');
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
      return c.json(CompileResultSchema.parse({ schemaVersion: CONTRACT_VERSION, ...result }), 200);
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
    const body = z.strictObject({ pageIds: z.array(IdentifierSchema).min(1).optional() }).safeParse(await c.req.json().catch(() => ({})));
    if (!body.success) return c.json({ error: 'Send an optional pageIds selection', code: 'invalid_request' }, 400);
    try {
      const ws = c.get('ws');
      const { record, report } = await ws.compiler.accept(c.req.param('id'), 'student', { only: body.data.pageIds });
      // A session source only checkpoints its turn range once its proposal is accepted —
      // a frozen-but-rejected reflection leaves the turns pending for the next attempt.
      for (const sourceId of record.proposal.sourceIds) {
        const source = await ws.wiki.readSource(sourceId).catch(() => null);
        if (source?.kind !== 'session') continue;
        const session = await ws.sessions.get(source.session.sessionId).catch(() => null);
        if (session) await ws.sessions.markIngested(session, source.session.lastTurn + 1);
      }
      const diff = await ws.brain.pageDiffs(report.pages);
      return c.json({ record, report, diff });
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
