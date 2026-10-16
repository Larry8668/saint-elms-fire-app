import { CONTRACT_VERSION } from '@sef/shared';
import type {
  BrainLogEntry,
  ChatStreamEvent,
  ConceptPage,
  CourseSummary,
  DeviceProfile,
  DevicePollResult,
  DeviceSignInStart,
  EngineLoginResponse,
  EngineMe,
  EngineSettings,
  GraphResponse,
  HealthResponse,
  IngestResult,
  JobList,
  Lesson,
  LessonMeta,
  LintFinding,
  OwnSharesResponse,
  PeerFeedResponse,
  ProposalPreview,
  PublishShareRequest,
  PublishShareResult,
  SessionDetail,
  SessionSummary,
  ShareablePageList,
  ShareDraftRequest,
  ShareDraftResponse,
  ShareImportResult,
  PublishedShare,
  SyncStatus,
  TeacherId,
} from '@sef/shared';
import { log } from './log';

export const ENGINE_URL = (import.meta.env?.VITE_ENGINE_URL as string | undefined) ?? 'http://127.0.0.1:4100';

export class EngineError extends Error {
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message);
  }
}

let sessionToken: string | null = null;
let onUnauthenticated: (() => void) | null = null;

/** Set by the session provider. Every engine call after sign-in carries this token. */
export function setEngineSession(token: string | null, onExpired?: () => void) {
  sessionToken = token;
  onUnauthenticated = onExpired ?? null;
}

const authHeaders = (): Record<string, string> => (sessionToken ? { authorization: `Bearer ${sessionToken}` } : {});

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  let res: Response;
  try {
    res = await fetch(`${ENGINE_URL}${path}`, {
      ...init,
      headers: { 'content-type': 'application/json', ...authHeaders(), ...init?.headers },
    });
  } catch (error) {
    log.error('engine_unreachable', { path, error: String(error) });
    throw new EngineError('The local engine is not running. Start it with "pnpm dev".', 0);
  }
  if (res.status === 204) return undefined as T;
  const body = (await res.json().catch(() => ({}))) as T & { error?: string; code?: string };
  if (!res.ok) {
    log.warn('engine_request_failed', { path, status: res.status, error: body.error });
    if (res.status === 401 && body.code === 'unauthenticated' && sessionToken) onUnauthenticated?.();
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
export type StoredSettings = EngineSettings;
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
export type { SessionDetail, SessionSummary };

export const api = {
  health: () => request<HealthResponse>('/api/health'),
  profiles: () => request<DeviceProfile[]>('/api/auth/profiles'),
  login: (email: string, password: string) => post<EngineLoginResponse>('/api/auth/login', { email, password }),
  me: () => request<EngineMe>('/api/auth/me'),
  logout: () => post<void>('/api/auth/logout'),

  /** First-time sign-in: the engine asks the university for a device grant to show. */
  startDeviceSignIn: () => post<DeviceSignInStart>('/api/auth/device/start'),
  /** One poll of the in-flight grant; repeat on the interval the server returned. */
  pollDeviceSignIn: () => post<DevicePollResult>('/api/auth/device/poll'),
  /** Offline entry for a profile that has already signed in online on this device. */
  offlineLogin: (profileId: string) => post<Extract<EngineLoginResponse, { role: 'student' }>>('/api/auth/offline-login', { profileId }),

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
  sessions: (teacher?: TeacherId) => request<SessionSummary[]>(`/api/sessions${teacher ? `?teacher=${teacher}` : ''}`),
  session: (id: string) => request<SessionDetail>(`/api/sessions/${encodeURIComponent(id)}`),
  deleteSession: (id: string) => request<{ ok: true }>(`/api/sessions/${encodeURIComponent(id)}`, { method: 'DELETE' }),

  createQuiz: (key: string) => post<QuizPayload>(`/api/quiz/${encodeURIComponent(key)}`),
  submitQuiz: (id: string, answers: number[]) => post<QuizResult>(`/api/quiz/${encodeURIComponent(id)}/submit`, { answers }),

  /** Source records + ingestion jobs (bodies stay in the vault; the list carries descriptors only). */
  sources: () => request<JobList>('/api/sources'),

  // Cohort sharing — the engine relays to the university share API on this profile's uni session.
  sharePages: () => request<ShareablePageList>('/api/shares/pages'),
  prepareShare: (input: ShareDraftRequest) => post<ShareDraftResponse>('/api/shares/prepare', input),
  publishShare: (request: PublishShareRequest) => post<PublishShareResult>('/api/shares/publish', request),
  peerFeed: (cursor?: string) => request<PeerFeedResponse>(`/api/shares/feed${cursor ? `?cursor=${encodeURIComponent(cursor)}` : ''}`),
  ownShares: () => request<OwnSharesResponse>('/api/shares/mine'),
  withdrawShare: (id: string) => post<PublishedShare>(`/api/shares/${encodeURIComponent(id)}/withdraw`),
  ignoreShare: (id: string, ignored: boolean) => post<void>(`/api/shares/${encodeURIComponent(id)}/ignore`, { ignored }),
  importShare: (id: string) => post<ShareImportResult>(`/api/shares/${encodeURIComponent(id)}/import`),

  // Wiki proposals — the review affordance an imported share lands in.
  proposal: (id: string) => request<ProposalPreview>(`/api/proposals/${encodeURIComponent(id)}`),
  acceptProposal: (id: string) => post<{ record: unknown; report: unknown }>(`/api/proposals/${encodeURIComponent(id)}/accept`),
  rejectProposal: (id: string, note?: string) => post<unknown>(`/api/proposals/${encodeURIComponent(id)}/reject`, { note }),
};

export interface ConversationHandle {
  sessionId: string;
  teacher: TeacherId;
  createdAt: string;
}

/** The conversation registry refused the turn before any model was reached. */
export class TurnRefused extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly status: number,
  ) {
    super(message);
    this.name = 'TurnRefused';
  }
}

export const conversationApi = {
  open: (teacher: TeacherId) => post<ConversationHandle>('/api/chat/sessions', { teacher }),
  handoff: (sessionId: string, to: TeacherId, reason: string) =>
    post<ConversationHandle>(`/api/chat/sessions/${encodeURIComponent(sessionId)}/handoff`, { sessionId, to, reason }),
};

export interface TurnPayload {
  sessionId: string;
  teacher: TeacherId;
  clientMessageId: string;
  message: string;
  attachments?: Array<{ kind: 'image'; mimeType: string; data: string; name?: string; altText?: string }>;
  consent?: { web: boolean };
}

/**
 * Streams one admitted turn over SSE. The server owns the transcript, so a turn carries the
 * new message only — never a client-built history.
 *
 * A refusal before streaming (unknown session, replay, concurrency, policy) arrives as a
 * non-SSE JSON response and is thrown as TurnRefused so the caller can reopen or surface it.
 */
export async function streamTurn(turn: TurnPayload, onEvent: (event: ChatStreamEvent) => void, signal?: AbortSignal): Promise<void> {
  let res: Response;
  try {
    res = await fetch(`${ENGINE_URL}/api/chat/turn`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...authHeaders() },
      body: JSON.stringify({ schemaVersion: CONTRACT_VERSION, ...turn }),
      signal,
    });
  } catch (error) {
    if ((error as Error).name === 'AbortError') return;
    onEvent({ type: 'error', message: 'The local engine is not running. Start it with "pnpm dev".' });
    return;
  }
  if (!res.ok || !res.body) {
    const body = (await res.json().catch(() => ({}))) as { error?: string; code?: string };
    if (body.code) throw new TurnRefused(body.code, body.error ?? `Turn refused (${res.status})`, res.status);
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
