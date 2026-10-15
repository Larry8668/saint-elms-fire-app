import { Hono } from 'hono';
import { streamSSE } from 'hono/streaming';
import { TEACHER_IDS, type ChatRequest, type ChatStreamEvent, type TeacherId } from '@sef/shared';
import { z } from 'zod';
import { runChatTurn } from '../../agents/harness';
import { errorFields, log } from '../../config';
import { requireProfile, type EngineDeps, type EngineEnv } from '../context';
import { friendlyError } from '../errors';

const AttachmentSchema = z.object({
  kind: z.literal('image'),
  mimeType: z.string().regex(/^image\//),
  data: z.string().max(12_000_000),
  name: z.string().optional(),
});

const ChatRequestSchema = z.object({
  teacher: z.enum(TEACHER_IDS),
  sessionId: z.string().min(1).max(80),
  messages: z
    .array(z.object({ role: z.enum(['user', 'assistant']), content: z.string().max(8000), attachments: z.array(AttachmentSchema).max(2).optional() }))
    .min(1)
    .max(40),
});

/** Everything scoped to the signed-in student: courses, chat, brain, quizzes. */
export function studentRoutes(deps: EngineDeps) {
  const app = new Hono<EngineEnv>();
  const guard = requireProfile(deps);

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

  // Chat (server-sent events)
  app.post('/chat', guard, async (c) => {
    const parsed = ChatRequestSchema.safeParse(await c.req.json().catch(() => null));
    if (!parsed.success) return c.json({ error: 'Invalid chat request', issues: parsed.error.issues }, 400);
    const req = parsed.data as ChatRequest;
    const ws = c.get('ws');
    const harness = { settings: ws.settings, content: ws.content, brain: ws.brain, sessions: ws.sessions, studentName: ws.profile.name };
    return streamSSE(c, async (stream) => {
      const emit = (event: ChatStreamEvent) => void stream.writeSSE({ data: JSON.stringify(event) });
      try {
        await runChatTurn(req, harness, emit);
      } catch (error) {
        log.error('chat_turn_failed', { teacher: req.teacher, profileId: ws.profile.id, ...errorFields(error) });
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
    const removed = await ws.sessions.remove(c.req.param('id'));
    if (!removed) return c.json({ error: 'Session not found' }, 404);
    log.info('session_deleted', { profileId: ws.profile.id, sessionId: c.req.param('id') });
    return c.json({ ok: true });
  });

  // Brain
  app.get('/graph', guard, async (c) => c.json(await c.get('ws').brain.graph()));
  app.get('/brain/pages', guard, async (c) => c.json(await c.get('ws').brain.pages()));
  app.get('/brain/pages/:key', guard, async (c) => {
    const page = await c.get('ws').brain.page(c.req.param('key'));
    return page ? c.json(page) : c.json({ error: 'No page for this concept yet' }, 404);
  });
  app.get('/brain/log', guard, async (c) => c.json(await c.get('ws').brain.log(Number(c.req.query('limit') ?? 50))));
  app.get('/brain/lint', guard, async (c) => c.json(await c.get('ws').brain.lint()));

  app.post('/brain/ingest/:sessionId', guard, async (c) => {
    const { sessions, brain } = c.get('ws');
    const session = await sessions.get(c.req.param('sessionId'));
    if (!session) return c.json({ error: 'Session not found' }, 404);
    if (session.turns.length <= session.ingestedTurns) return c.json({ error: 'Nothing new in this session to reflect on' }, 409);
    const result = await brain.ingestSession(session);
    await sessions.markIngested(session);
    return c.json(result);
  });

  app.post('/brain/capture', guard, async (c) => {
    const body = z.object({ image: AttachmentSchema, note: z.string().max(500).optional() }).safeParse(await c.req.json().catch(() => null));
    if (!body.success) return c.json({ error: 'Send an image (base64) and an optional note' }, 400);
    return c.json(await c.get('ws').brain.capture(body.data.image, body.data.note));
  });

  app.post('/quiz/:key', guard, async (c) => c.json(await c.get('ws').brain.createQuiz(c.req.param('key'))));
  app.post('/quiz/:id/submit', guard, async (c) => {
    const body = z.object({ answers: z.array(z.number().int()) }).safeParse(await c.req.json().catch(() => null));
    if (!body.success) return c.json({ error: 'answers must be an array of option indexes' }, 400);
    return c.json(await c.get('ws').brain.submitQuiz(c.req.param('id'), body.data.answers));
  });

  return app;
}
