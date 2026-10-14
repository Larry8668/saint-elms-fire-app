import type {
  BrainLogEntry,
  ChatRequest,
  ChatStreamEvent,
  ConceptPage,
  CourseSummary,
  EngineSettings,
  GraphResponse,
  HealthResponse,
  IngestResult,
  Lesson,
  LessonMeta,
  LintFinding,
  SyncStatus,
} from '@sef/shared';
import { log } from './log';

export const ENGINE_URL = (import.meta.env.VITE_ENGINE_URL as string | undefined) ?? 'http://127.0.0.1:4100';

export class EngineError extends Error {
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message);
  }
}

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  let res: Response;
  try {
    res = await fetch(`${ENGINE_URL}${path}`, {
      ...init,
      headers: { 'content-type': 'application/json', ...init?.headers },
    });
  } catch (error) {
    log.error('engine_unreachable', { path, error: String(error) });
    throw new EngineError('The local engine is not running. Start it with "pnpm dev".', 0);
  }
  const body = (await res.json().catch(() => ({}))) as T & { error?: string };
  if (!res.ok) {
    log.warn('engine_request_failed', { path, status: res.status, error: body.error });
    throw new EngineError(body.error ?? `Request failed (${res.status})`, res.status);
  }
  return body;
}

const post = <T>(path: string, body?: unknown) => request<T>(path, { method: 'POST', body: body ? JSON.stringify(body) : undefined });

export interface InstalledCourse extends CourseSummary {
  installedAt: string;
}
export interface Library {
  courses: InstalledCourse[];
  lessons: LessonMeta[];
}
export interface StoredSettings extends EngineSettings {
  cohortId: string;
}
export interface QuizPayload {
  id: string;
  key: string;
  concept: string;
  model: string;
  questions: Array<{ question: string; options: string[] }>;
}
export interface QuizResult {
  score: number;
  outOf: number;
  review: Array<{ correct: number; chosen: number; explanation: string }>;
  diff: IngestResult['diff'];
}
export interface CaptureResult extends IngestResult {
  reading: { topic: string; transcription: string; concepts: string[] };
}
export interface SessionSummary {
  id: string;
  teacher: ChatRequest['teacher'];
  startedAt: string;
  updatedAt: string;
  turns: number;
  pending: number;
  preview: string;
}

export const api = {
  health: () => request<HealthResponse>('/api/health'),
  settings: () => request<StoredSettings>('/api/settings'),
  saveSettings: (patch: Partial<StoredSettings>) => request<StoredSettings>('/api/settings', { method: 'PUT', body: JSON.stringify(patch) }),
  providerModels: (id: string) => request<{ models: string[]; error?: string }>(`/api/providers/${encodeURIComponent(id)}/models`),

  syncStatus: () => request<SyncStatus>('/api/sync/status'),
  install: (courseId: string) => post<{ courseId: string; version: string }>(`/api/sync/install/${encodeURIComponent(courseId)}`),
  installAll: () => post<{ installed: unknown[] }>('/api/sync/install-all'),

  library: () => request<Library>('/api/library'),
  lesson: (id: string) => request<Lesson>(`/api/lessons/${encodeURIComponent(id)}`),

  graph: () => request<GraphResponse>('/api/graph'),
  pages: () => request<ConceptPage[]>('/api/brain/pages'),
  page: (key: string) => request<ConceptPage>(`/api/brain/pages/${encodeURIComponent(key)}`),
  brainLog: () => request<BrainLogEntry[]>('/api/brain/log'),
  lint: () => request<LintFinding[]>('/api/brain/lint'),
  ingest: (sessionId: string) => post<IngestResult>(`/api/brain/ingest/${encodeURIComponent(sessionId)}`),
  capture: (image: { mimeType: string; data: string }, note?: string) => post<CaptureResult>('/api/brain/capture', { image: { kind: 'image', ...image }, note }),
  sessions: () => request<SessionSummary[]>('/api/sessions'),

  createQuiz: (key: string) => post<QuizPayload>(`/api/quiz/${encodeURIComponent(key)}`),
  submitQuiz: (id: string, answers: number[]) => post<QuizResult>(`/api/quiz/${encodeURIComponent(id)}/submit`, { answers }),
};

/** Streams a chat turn over SSE, calling `onEvent` for each parsed event. */
export async function streamChat(req: ChatRequest, onEvent: (event: ChatStreamEvent) => void, signal?: AbortSignal): Promise<void> {
  let res: Response;
  try {
    res = await fetch(`${ENGINE_URL}/api/chat`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(req),
      signal,
    });
  } catch (error) {
    if ((error as Error).name === 'AbortError') return;
    onEvent({ type: 'error', message: 'The local engine is not running. Start it with "pnpm dev".' });
    return;
  }
  if (!res.ok || !res.body) {
    const body = (await res.json().catch(() => ({}))) as { error?: string };
    onEvent({ type: 'error', message: body.error ?? `Chat failed (${res.status})` });
    return;
  }
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    let boundary: number;
    while ((boundary = buffer.indexOf('\n\n')) >= 0) {
      const frame = buffer.slice(0, boundary);
      buffer = buffer.slice(boundary + 2);
      const data = frame
        .split('\n')
        .filter((line) => line.startsWith('data:'))
        .map((line) => line.slice(5).trimStart())
        .join('\n');
      if (!data) continue;
      try {
        onEvent(JSON.parse(data) as ChatStreamEvent);
      } catch (error) {
        log.warn('chat_frame_unparseable', { error: String(error) });
      }
    }
  }
}

export function fileToBase64(file: File): Promise<{ mimeType: string; data: string; preview: string }> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => {
      const url = String(reader.result);
      resolve({ mimeType: file.type || 'image/png', data: url.slice(url.indexOf(',') + 1), preview: url });
    };
    reader.onerror = () => reject(reader.error);
    reader.readAsDataURL(file);
  });
}
