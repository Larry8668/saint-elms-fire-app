import { Hono, type Context } from 'hono';
import { streamSSE } from 'hono/streaming';
import { ConversationHandoffSchema, ConversationTurnSchema, CONTRACT_VERSION, IdentifierSchema, RestorePageRequestSchema, SourceReceiptSchema, TEACHER_IDS, type ChatRequest, type ChatStreamEvent, type TeacherId } from '@sef/shared';
import { z } from 'zod';
import { ConversationRefused, ConversationRegistry, refusalCopy, serverTranscript } from '../../agents/conversation';
import { runChatTurn } from '../../agents/harness';
import { SourceRejection } from '../../brain/sources/ingest';
import { VaultConflictError } from '../../brain/vault-errors';
import { errorFields, log } from '../../config';
import { requireProfile, type EngineDeps, type EngineEnv } from '../context';
import { friendlyError } from '../errors';

/** Which refusal gets which status. Every one of them is a refusal, none of them is a crash. */
const REFUSAL_STATUS = {
  unknown_session: 404,
  session_owner_mismatch: 403,
  teacher_mismatch: 409,
  replayed_turn: 409,
  concurrent_turn: 409,
  session_closed: 409,
  capability_denied: 403,
  anchor_required: 409,
} as const;

function refuseResponse(c: Context<EngineEnv>, error: unknown, profileId: string) {
  if (!(error instanceof ConversationRefused)) throw error;
  log.warn('chat_turn_refused', { profileId, code: error.rejection });
  return c.json({ error: refusalCopy(error.rejection), code: error.rejection }, REFUSAL_STATUS[error.rejection]);
}

/** Everything scoped to the signed-in student: courses, chat, brain, quizzes. */
export function studentRoutes(deps: EngineDeps, conversations: ConversationRegistry = new ConversationRegistry({})) {
  const app = new Hono<EngineEnv>();
  const guard = requireProfile(deps, { approved: true });

  // Legacy, identity-free data is only copied after an explicit backup and claim.
  app.get('/anonymous-data', guard, async (c) => c.json(await deps.anonymousData.preview()));
  app.post('/anonymous-data/backup', guard, async (c) => c.json(await deps.anonymousData.backup()));
  app.post('/anonymous-data/claim', guard, async (c) => {
    const body = z.strictObject({ backupId: z.string().uuid() }).safeParse(await c.req.json().catch(() => null));
    if (!body.success) return c.json({ error: 'Create a backup and send its backupId to claim anonymous data.' }, 400);
    const ws = c.get('ws');
    return c.json(await deps.anonymousData.claim(c.get('me').profile, ws.paths, body.data.backupId));
  });

  // Courseware sync
  app.get('/sync/status', guard, async (c) => c.json(await c.get('ws').sync.status()));

  /**
   * The full programme manifest for an approved student. Behind `approved: true`, because
   * the curriculum is not theirs to read before admission.
   */
  app.get('/programme', guard, async (c) => {
    const programme = await c.get('ws').sync.programme().catch((error: unknown) => {
      log.warn('programme_unavailable', { profileId: c.get('me').profile.id, ...errorFields(error) });
      return null;
    });
    if (!programme) return c.json({ error: 'programme_unavailable' }, 503);
    return c.json(programme);
  });
  app.post('/sync/install/:courseId', guard, async (c) => c.json(await c.get('ws').sync.install(c.req.param('courseId'))));
  app.post('/sync/install-all', guard, async (c) => {
    const { sync } = c.get('ws');
    const status = await sync.status();
    const results = [];
    for (const course of status.courses.filter((x) => x.state === 'available' || x.state === 'update')) {
      results.push(await sync.install(course.id));
    }
    return c.json({ installed: results });
  });

  // Library
  app.get('/library', guard, async (c) => {
    const { content } = c.get('ws');
    const [courses, lessons] = await Promise.all([content.installed(), content.allLessons()]);
    return c.json({
      courses: Object.values(courses).sort((a, b) => a.semesterNumber - b.semesterNumber || a.title.localeCompare(b.title)),
      lessons: lessons.map(({ markdown: _body, ...meta }) => meta),
    });
  });
  app.get('/lessons/:id', guard, async (c) => {
    const lesson = await c.get('ws').content.lesson(c.req.param('id'));
    return lesson ? c.json(lesson) : c.json({ error: 'Lesson not found' }, 404);
  });

  /**
   * Conversations the server issues, bound to this student and one teacher. The transcript lives
   * in the server's session store, so a turn carries a message and a message id — never history.
   */
  app.post('/chat/sessions', guard, async (c) => {
    const body = z.strictObject({ teacher: z.enum(TEACHER_IDS) }).safeParse(await c.req.json().catch(() => null));
    if (!body.success) return c.json({ error: 'Choose a teacher to start a conversation', issues: body.error.issues }, 400);
    const ws = c.get('ws');
    const session = await conversations.open({ profileId: ws.profile.id, teacher: body.data.teacher });
    log.info('conversation_opened', { profileId: ws.profile.id, teacher: session.teacher });
    return c.json({ sessionId: session.id, teacher: session.teacher, profileId: session.profileId, createdAt: session.createdAt, turnCount: 0 });
  });

  /** An explicit hand-off: a new conversation for the new teacher, never an edited one. */
  app.post('/chat/sessions/:id/handoff', guard, async (c) => {
    const raw = await c.req.json().catch(() => null);
    const body = ConversationHandoffSchema.safeParse({ ...(raw && typeof raw === 'object' ? raw : {}), sessionId: c.req.param('id') });
    if (!body.success) return c.json({ error: 'A hand-off needs a teacher and a reason', issues: body.error.issues }, 400);
    const ws = c.get('ws');
    try {
      const next = await conversations.handoff({ sessionId: body.data.sessionId, profileId: ws.profile.id, to: body.data.to, reason: body.data.reason });
      return c.json({ sessionId: next.id, teacher: next.teacher, profileId: next.profileId, createdAt: next.createdAt, turnCount: 0 });
    } catch (error) {
      return refuseResponse(c, error, ws.profile.id);
    }
  });

  app.post('/chat/turn', guard, async (c) => {
    const parsed = ConversationTurnSchema.safeParse(await c.req.json().catch(() => null));
    if (!parsed.success) return c.json({ error: 'Invalid turn', issues: parsed.error.issues }, 400);
    const turn = parsed.data;
    const ws = c.get('ws');

    let admitted;
    try {
      admitted = await conversations.admit({ sessionId: turn.sessionId, profileId: ws.profile.id, teacher: turn.teacher, clientMessageId: turn.clientMessageId });
    } catch (error) {
      return refuseResponse(c, error, ws.profile.id);
    }

    const stored = await ws.sessions.get(turn.sessionId);
    const req: ChatRequest = {
      teacher: turn.teacher,
      sessionId: turn.sessionId,
      messages: serverTranscript(stored, { role: 'user', content: turn.message, attachments: turn.attachments }),
      consent: turn.consent,
    };
    const harness = { settings: ws.settings, content: ws.content, brain: ws.brain, sessions: ws.sessions, studentName: ws.profile.name, claims: ws.wiki, wiki: ws.wiki, logistics: ws.logistics };
    return streamSSE(c, async (stream) => {
      const emit = (event: ChatStreamEvent) => void stream.writeSSE({ data: JSON.stringify(event) });
      try {
        await runChatTurn(req, harness, emit);
        await conversations.complete(admitted);
      } catch (error) {
        conversations.release(turn.sessionId);
        log.error('chat_turn_failed', { teacher: turn.teacher, profileId: ws.profile.id, sessionId: turn.sessionId, ...errorFields(error) });
        emit({ type: 'error', message: friendlyError(error) });
      }
    });
  });

  // Chat history (per student, on this device)
  app.get('/sessions', guard, async (c) => {
    const teacher = c.req.query('teacher');
    if (teacher && !(TEACHER_IDS as readonly string[]).includes(teacher)) return c.json({ error: 'Unknown teacher' }, 400);
    return c.json(await c.get('ws').sessions.list({ teacher: teacher as TeacherId | undefined, limit: Number(c.req.query('limit') ?? 30) }));
  });
  app.get('/sessions/:id', guard, async (c) => {
    const session = await c.get('ws').sessions.get(c.req.param('id'));
    if (!session) return c.json({ error: 'Session not found' }, 404);
    const { lessonIds: _l, sources: _s, ...detail } = session;
    return c.json(detail);
  });
  app.delete('/sessions/:id', guard, async (c) => {
    const ws = c.get('ws');
    // Deleting the transcript also retires the conversation: a session that no longer shows up
    // in history must not keep admitting turns.
    const [removed, closed] = await Promise.all([
      ws.sessions.remove(c.req.param('id')),
      conversations.close({ sessionId: c.req.param('id'), profileId: ws.profile.id }),
    ]);
    if (!removed && !closed) return c.json({ error: 'Session not found' }, 404);
    log.info('session_deleted', { profileId: ws.profile.id, sessionId: c.req.param('id'), conversationClosed: closed });
    return c.json({ ok: true });
  });

  // Brain
  app.get('/graph', guard, async (c) => c.json(await c.get('ws').brain.graph()));
  app.get('/brain/pages', guard, async (c) => c.json(await c.get('ws').brain.pages()));
  app.get('/brain/pages/:key', guard, async (c) => {
    const page = await c.get('ws').brain.page(c.req.param('key'));
    return page ? c.json(page) : c.json({ error: 'No page for this concept yet' }, 404);
  });
  /** Every committed revision of one page — the student's own history, readable back. */
  app.get('/brain/pages/:key/revisions', guard, async (c) => {
    const key = IdentifierSchema.safeParse(c.req.param('key'));
    if (!key.success) return c.json({ error: 'No page for this concept yet' }, 404);
    const list = await c.get('ws').wiki.pageRevisions(key.data);
    return list ? c.json(list) : c.json({ error: 'No page for this concept yet' }, 404);
  });
  app.get('/brain/pages/:key/revisions/:rev', guard, async (c) => {
    const key = IdentifierSchema.safeParse(c.req.param('key'));
    if (!key.success) return c.json({ error: 'No page for this concept yet' }, 404);
    const revision = await c.get('ws').wiki.readPageRevision(key.data, c.req.param('rev'));
    return revision ? c.json(revision) : c.json({ error: 'Revision not found' }, 404);
  });
  /**
   * Restore-as-new-revision: the old revision's content is proposed on top of the page
   * the caller read, through the same journaled proposal write path everything else uses.
   * A stale baseRevision answers 409 rather than silently overwriting someone's newer work.
   */
  app.post('/brain/pages/:key/restore', guard, async (c) => {
    const key = IdentifierSchema.safeParse(c.req.param('key'));
    if (!key.success) return c.json({ error: 'No page for this concept yet', code: 'not_found' }, 404);
    const body = RestorePageRequestSchema.safeParse(await c.req.json().catch(() => null));
    if (!body.success) return c.json({ error: 'Send the revision to restore and the baseRevision you read', code: 'invalid_request' }, 400);
    try {
      return c.json(await c.get('ws').brain.restorePageRevision(key.data, body.data.revision, body.data.baseRevision));
    } catch (error) {
      if (error instanceof SourceRejection) return c.json({ error: error.message, code: error.code }, error.status);
      if (error instanceof VaultConflictError) return c.json({ error: error.message, code: 'stale_revision', details: error.details }, 409);
      throw error;
    }
  });
  app.get('/brain/log', guard, async (c) => c.json(await c.get('ws').brain.log(Number(c.req.query('limit') ?? 50))));
  app.get('/brain/lint', guard, async (c) => c.json(await c.get('ws').brain.lint()));

  /** Every vault page in list form — concepts, syntheses, questions — so personal pages are findable. */
  app.get('/brain/records', guard, async (c) => c.json(await c.get('ws').brain.records()));
  /** The growth ledger, or one page's slice of it: attributable events, oldest first. */
  app.get('/brain/events', guard, async (c) => c.json(await c.get('ws').brain.events(c.req.query('pageId'))));
  /** One vault page in full — the detail view for any kind, not only concepts. */
  app.get('/brain/pages/:id/record', guard, async (c) => {
    const id = IdentifierSchema.safeParse(c.req.param('id'));
    if (!id.success) return c.json({ error: 'No page with this id' }, 404);
    const record = await c.get('ws').brain.pageRecord(id.data);
    return record ? c.json(record) : c.json({ error: 'No page with this id' }, 404);
  });

  /**
   * Wiki maintenance: the deterministic checks run on every read, the semantic review only
   * when the student asks for it, and repairs always travel as proposals — these routes
   * never touch a page directly.
   */
  app.get('/brain/maintenance', guard, async (c) => c.json(await c.get('ws').maintenance.report()));

  /** The bounded model pass; the vault is read-only throughout and findings are persisted. */
  app.post('/brain/maintenance/review', guard, async (c) => {
    try {
      return c.json(await c.get('ws').maintenance.review());
    } catch (error) {
      log.warn('semantic_review_failed', { profileId: c.get('me').profile.id, ...errorFields(error) });
      return c.json({ error: friendlyError(error), code: 'review_failed' }, 502);
    }
  });

  /** Files the selected actionable findings as one ordinary proposal for review. */
  app.post('/brain/maintenance/proposals', guard, async (c) => {
    const body = z.strictObject({ findingIds: z.array(IdentifierSchema).min(1).max(64) }).safeParse(await c.req.json().catch(() => null));
    if (!body.success) return c.json({ error: 'Send the findingIds to propose repairs for', code: 'invalid_request' }, 400);
    return c.json(await c.get('ws').maintenance.fileProposal(body.data.findingIds));
  });

  /** A wrong or unwanted suggestion stays dismissed; nothing about the vault changes. */
  app.post('/brain/maintenance/findings/:id/dismiss', guard, async (c) => {
    const id = IdentifierSchema.safeParse(c.req.param('id'));
    if (!id.success) return c.json({ error: 'Unknown finding', code: 'not_found' }, 404);
    const body = z.strictObject({ note: z.string().max(300).optional() }).safeParse(await c.req.json().catch(() => ({})));
    if (!body.success) return c.json({ error: 'Send an optional note', code: 'invalid_request' }, 400);
    return c.json(await c.get('ws').maintenance.dismiss(id.data, body.data.note));
  });

  /** Rebuilds index.md and the manifest page map from the files on disk — the only repair that does not need a page proposal. */
  app.post('/brain/maintenance/catalogue', guard, async (c) => c.json(await c.get('ws').maintenance.repairCatalogue()));

  /**
   * Reflect freezes the session's fresh turns as a kept source and stops — the turns stay
   * pending until the student accepts the proposal a later compile files. The checkpoint
   * itself lives in the proposal accept route, which writes it only on a real commit.
   */
  app.post('/brain/ingest/:sessionId', guard, async (c) => {
    const body = z.strictObject({ review: z.boolean().optional() }).safeParse(await c.req.json().catch(() => ({})));
    if (!body.success) return c.json({ error: 'Send an optional review flag' }, 400);
    const { sessions, brain } = c.get('ws');
    const session = await sessions.get(c.req.param('sessionId'));
    if (!session) return c.json({ error: 'Session not found' }, 404);
    if (session.turns.length <= session.ingestedTurns) return c.json({ error: 'Nothing new in this session to reflect on' }, 409);
    const result = await brain.freezeSession(session);
    const extraction = result.extraction
      ? { method: result.extraction.method, text: result.extraction.text, partial: result.extraction.partial, ...(result.extraction.note ? { note: result.extraction.note } : {}) }
      : null;
    return c.json(SourceReceiptSchema.parse({ schemaVersion: CONTRACT_VERSION, source: result.source, extraction, jobId: result.jobId, reused: result.reused }), 201);
  });

  app.post('/quiz/:key', guard, async (c) => c.json(await c.get('ws').brain.createQuiz(c.req.param('key'))));
  app.post('/quiz/:id/submit', guard, async (c) => {
    const body = z.object({ answers: z.array(z.number().int()), attemptId: z.string().max(80).optional() }).safeParse(await c.req.json().catch(() => null));
    if (!body.success) return c.json({ error: 'answers must be an array of option indexes' }, 400);
    return c.json(await c.get('ws').brain.submitQuiz(c.req.param('id'), body.data.answers, body.data.attemptId));
  });

  return app;
}
