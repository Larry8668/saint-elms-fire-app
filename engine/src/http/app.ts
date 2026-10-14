import { Hono } from 'hono';
import { cors } from 'hono/cors';
import { streamSSE } from 'hono/streaming';
import { TEACHER_IDS, type ChatRequest, type ChatStreamEvent, type HealthResponse } from '@sef/shared';
import { z } from 'zod';
import { runChatTurn } from '../agents/harness';
import type { BrainService } from '../brain/service';
import { config, errorFields, log } from '../config';
import type { ContentStore } from '../content/store';
import type { ContentSync } from '../content/sync';
import { checkRoles, listProviderModels } from '../models/health';
import { ModelConfigError } from '../models/registry';
import type { SessionStore } from '../sessions/store';
import { SettingsStore } from '../settings/store';
import { webReachable } from '../web/searxng';

export interface EngineDeps {
  settings: SettingsStore;
  content: ContentStore;
  sync: ContentSync;
  brain: BrainService;
  sessions: SessionStore;
}

const AttachmentSchema = z.object({ kind: z.literal('image'), mimeType: z.string().regex(/^image\//), data: z.string().max(12_000_000), name: z.string().optional() });

const ChatRequestSchema = z.object({
  teacher: z.enum(TEACHER_IDS),
  sessionId: z.string().min(1).max(80),
  messages: z
    .array(z.object({ role: z.enum(['user', 'assistant']), content: z.string().max(8000), attachments: z.array(AttachmentSchema).max(2).optional() }))
    .min(1)
    .max(40),
});

/** Turns known error types into friendly messages the UI can show as-is. */
function friendlyError(error: unknown): string {
  const message = (error as Error)?.message ?? String(error);
  if (error instanceof ModelConfigError) return message;
  if (/ECONNREFUSED|fetch failed|connect/i.test(message)) return 'Could not reach the model. Is Ollama running? Check Settings → Models.';
  if (/not found|pull/i.test(message)) return `Model not available: ${message}. Try "ollama pull" or pick another model in Settings.`;
  return message;
}

export function createApp(deps: EngineDeps) {
  const app = new Hono();
  app.use('*', cors());

  app.use('/api/*', async (c, next) => {
    const started = Date.now();
    await next();
    if (c.req.path !== '/api/health') log.info('request', { method: c.req.method, path: c.req.path, status: c.res.status, ms: Date.now() - started });
  });

  app.onError((error, c) => {
    log.error('request_failed', { path: c.req.path, ...errorFields(error) });
    return c.json({ error: friendlyError(error) }, error instanceof ModelConfigError ? 400 : 500);
  });

  app.get('/api/health', async (c) => {
    const settings = await deps.settings.get();
    const [catalogue, models, web] = await Promise.all([deps.sync.catalogue(), checkRoles(settings), webReachable(settings.searxngUrl)]);
    const body: HealthResponse = {
      ok: true,
      engine: config.version,
      uni: { reachable: Boolean(catalogue), url: settings.uniServerUrl },
      models,
      web: { reachable: web },
    };
    return c.json(body);
  });

  // Settings & models
  app.get('/api/settings', async (c) => c.json(SettingsStore.redact(await deps.settings.get())));
  app.put('/api/settings', async (c) => c.json(SettingsStore.redact(await deps.settings.update(await c.req.json()))));
  app.get('/api/providers/:id/models', async (c) => {
    const provider = (await deps.settings.get()).providers.find((p) => p.id === c.req.param('id'));
    if (!provider) return c.json({ error: 'Unknown provider' }, 404);
    try {
      return c.json({ models: await listProviderModels(provider) });
    } catch (error) {
      return c.json({ models: [], error: friendlyError(error) });
    }
  });

  // Courseware sync
  app.get('/api/sync/status', async (c) => c.json(await deps.sync.status()));
  app.post('/api/sync/install/:courseId', async (c) => c.json(await deps.sync.install(c.req.param('courseId'))));
  app.post('/api/sync/install-all', async (c) => {
    const status = await deps.sync.status();
    const results = [];
    for (const course of status.courses.filter((x) => x.state === 'available' || x.state === 'update')) {
      results.push(await deps.sync.install(course.id));
    }
    return c.json({ installed: results });
  });

  // Library
  app.get('/api/library', async (c) => {
    const [courses, lessons] = await Promise.all([deps.content.installed(), deps.content.allLessons()]);
    return c.json({
      courses: Object.values(courses).sort((a, b) => a.semesterNumber - b.semesterNumber || a.title.localeCompare(b.title)),
      lessons: lessons.map(({ markdown: _body, ...meta }) => meta),
    });
  });
  app.get('/api/lessons/:id', async (c) => {
    const lesson = await deps.content.lesson(c.req.param('id'));
    return lesson ? c.json(lesson) : c.json({ error: 'Lesson not found' }, 404);
  });

  // Chat (server-sent events)
  app.post('/api/chat', async (c) => {
    const parsed = ChatRequestSchema.safeParse(await c.req.json().catch(() => null));
    if (!parsed.success) return c.json({ error: 'Invalid chat request', issues: parsed.error.issues }, 400);
    const req = parsed.data as ChatRequest;
    return streamSSE(c, async (stream) => {
      const emit = (event: ChatStreamEvent) => void stream.writeSSE({ data: JSON.stringify(event) });
      try {
        await runChatTurn(req, deps, emit);
      } catch (error) {
        log.error('chat_turn_failed', { teacher: req.teacher, ...errorFields(error) });
        emit({ type: 'error', message: friendlyError(error) });
      }
    });
  });

  app.get('/api/sessions', async (c) => c.json(await deps.sessions.list()));
  app.get('/api/sessions/:id', async (c) => {
    const session = await deps.sessions.get(c.req.param('id'));
    return session ? c.json(session) : c.json({ error: 'Session not found' }, 404);
  });

  // Brain
  app.get('/api/graph', async (c) => c.json(await deps.brain.graph()));
  app.get('/api/brain/pages', async (c) => c.json(await deps.brain.pages()));
  app.get('/api/brain/pages/:key', async (c) => {
    const page = await deps.brain.page(c.req.param('key'));
    return page ? c.json(page) : c.json({ error: 'No page for this concept yet' }, 404);
  });
  app.get('/api/brain/log', async (c) => c.json(await deps.brain.log(Number(c.req.query('limit') ?? 50))));
  app.get('/api/brain/lint', async (c) => c.json(await deps.brain.lint()));

  app.post('/api/brain/ingest/:sessionId', async (c) => {
    const session = await deps.sessions.get(c.req.param('sessionId'));
    if (!session) return c.json({ error: 'Session not found' }, 404);
    if (session.turns.length <= session.ingestedTurns) return c.json({ error: 'Nothing new in this session to reflect on' }, 409);
    const result = await deps.brain.ingestSession(session);
    await deps.sessions.markIngested(session);
    return c.json(result);
  });

  app.post('/api/brain/capture', async (c) => {
    const body = z.object({ image: AttachmentSchema, note: z.string().max(500).optional() }).safeParse(await c.req.json().catch(() => null));
    if (!body.success) return c.json({ error: 'Send an image (base64) and an optional note' }, 400);
    return c.json(await deps.brain.capture(body.data.image, body.data.note));
  });

  app.post('/api/quiz/:key', async (c) => c.json(await deps.brain.createQuiz(c.req.param('key'))));
  app.post('/api/quiz/:id/submit', async (c) => {
    const body = z.object({ answers: z.array(z.number().int()) }).safeParse(await c.req.json().catch(() => null));
    if (!body.success) return c.json({ error: 'answers must be an array of option indexes' }, 400);
    return c.json(await deps.brain.submitQuiz(c.req.param('id'), body.data.answers));
  });

  return app;
}
