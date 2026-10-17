import { CONTRACT_VERSION } from '@sef/shared';
import type {
  AnchorCandidate,
  AnchorCatalog,
  AnchorMatchResult,
  BrainLogEntry,
  CatalogueRepairResult,
  ChatStreamEvent,
  CompileResult,
  ConceptPage,
  ContributeBody,
  CourseSummary,
  DeviceProfile,
  DevicePollResult,
  DeviceSignInStart,
  EngineLoginResponse,
  EngineMe,
  EngineSettings,
  GraphResponse,
  AttentionResponse,
  DeviceCapability,
  HealthResponse,
  IngestResult,
  JobList,
  LearningEvent,
  Lesson,
  LessonMeta,
  LintFinding,
  LogisticsList,
  LogisticsRecord,
  LogisticsRecordResult,
  LogisticsWriteInput,
  MaintenanceProposalResult,
  MaintenanceReport,
  OwnSharesResponse,
  PageRecordSummary,
  PageRecordView,
  PageRevisionContent,
  PageRevisionList,
  PeerFeedResponse,
  ProgrammeManifestResponse,
  ProposalAcceptance,
  ProposalList,
  ProposalPreview,
  PublishedShare,
  PublishShareRequest,
  PublishShareResult,
  RestorePageRequest,
  SaveAnswerRequest,
  SemanticReviewResult,
  SessionDetail,
  SessionSummary,
  ShareablePageList,
  ShareDraftRequest,
  ShareDraftResponse,
  ShareImportResult,
  SourceDependents,
  SourceDetail,
  SourceEraseResult,
  SourceReadResult,
  SourceReceipt,
  SyncStatus,
  SuggestionsResponse,
  TeacherId,
  Feed,
  FeedsResponse,
  VaultExport,
  VaultImportPreview,
  VaultImportResult,
  VideoPreview,
  WebPreview,
  WikiIndex,
  WikiPageView,
  WikiProposalRecord,
} from '@sef/shared';
import { log } from './log';

export const ENGINE_URL = (import.meta.env?.VITE_ENGINE_URL as string | undefined) ?? 'http://127.0.0.1:4100';

export class EngineError extends Error {
  constructor(
    message: string,
    readonly status: number,
    /** The engine's typed code, when it sent one — never rendered raw; map it to copy. */
    readonly code?: string,
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
    throw new EngineError(body.error ?? `Request failed (${res.status})`, res.status, body.code);
  }
  return body;
}

const post = <T>(path: string, body?: unknown) => request<T>(path, { method: 'POST', body: body ? JSON.stringify(body) : undefined });

/** Binary responses bypass the JSON path — the raw file goes to an <img> or a download. */
async function requestBlob(path: string): Promise<Blob> {
  let res: Response;
  try {
    res = await fetch(`${ENGINE_URL}${path}`, { headers: authHeaders() });
  } catch (error) {
    log.error('engine_unreachable', { path, error: String(error) });
    throw new EngineError('The local engine is not running. Start it with "pnpm dev".', 0);
  }
  if (!res.ok) {
    const body = (await res.json().catch(() => ({}))) as { error?: string };
    throw new EngineError(body.error ?? `Request failed (${res.status})`, res.status);
  }
  return res.blob();
}

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
  /** True when this submit replayed an already-recorded attempt — no duplicate evidence was written. */
  replayed: boolean;
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
  capability: () => request<DeviceCapability>('/api/system/capability'),

  attention: () => request<AttentionResponse>('/api/attention'),
  evaluateAttention: () => post<AttentionResponse>('/api/attention/evaluate'),
  markAttentionSeen: (keys: string[]) => post<{ updated: number }>('/api/attention/seen', { keys }),
  dismissAttention: (key: string) => post<{ ok: true }>(`/api/attention/${encodeURIComponent(key)}/dismiss`),
  snoozeAttention: (key: string, hours: number) => post<{ ok: true }>(`/api/attention/${encodeURIComponent(key)}/snooze`, { hours }),
  suggestions: (teacher: TeacherId) => request<SuggestionsResponse>(`/api/teachers/${teacher}/suggestions`),
  feeds: () => request<FeedsResponse>('/api/feeds'),
  addFeed: (body: { url: string; title?: string }) => post<Feed>('/api/feeds', body),
  setFeedConsent: (id: string, enabled: boolean) => post<Feed>(`/api/feeds/${encodeURIComponent(id)}/consent`, { enabled }),
  removeFeed: (id: string) => request<{ ok: true }>(`/api/feeds/${encodeURIComponent(id)}`, { method: 'DELETE' }),

  syncStatus: () => request<SyncStatus>('/api/sync/status'),
  /** The full published curriculum for an approved student; refusals arrive as typed errors. */
  programme: () => request<ProgrammeManifestResponse>('/api/programme'),
  install: (courseId: string) => post<{ courseId: string; version: string }>(`/api/sync/install/${encodeURIComponent(courseId)}`),
  installAll: () => post<{ installed: unknown[] }>('/api/sync/install-all'),

  library: () => request<Library>('/api/library'),
  lesson: (id: string) => request<Lesson>(`/api/lessons/${encodeURIComponent(id)}`),

  graph: () => request<GraphResponse>('/api/graph'),
  pages: () => request<ConceptPage[]>('/api/brain/pages'),
  page: (key: string) => request<ConceptPage>(`/api/brain/pages/${encodeURIComponent(key)}`),
  pageRevisions: (key: string) => request<PageRevisionList>(`/api/brain/pages/${encodeURIComponent(key)}/revisions`),
  pageRevision: (key: string, revision: string) => request<PageRevisionContent>(`/api/brain/pages/${encodeURIComponent(key)}/revisions/${encodeURIComponent(revision)}`),
  /** Writes the named revision back as a new one, on top of what the caller read. 409 = stale base. */
  restorePage: (key: string, body: RestorePageRequest) => post<ProposalAcceptance>(`/api/brain/pages/${encodeURIComponent(key)}/restore`, body),

  // The compiled wiki: catalogue, one page's permitted view, and save-an-answer.
  wikiIndex: () => request<WikiIndex>('/api/wiki/pages'),
  wikiPage: (id: string) => request<WikiPageView>(`/api/wiki/pages/${encodeURIComponent(id)}`),
  /** Freezes one answer turn as a model-provenance source and queues its compile job. */
  saveAnswer: (body: SaveAnswerRequest) => post<SourceReceipt>('/api/wiki/save', body),
  brainLog: () => request<BrainLogEntry[]>('/api/brain/log'),
  lint: () => request<LintFinding[]>('/api/brain/lint'),
  /** Every vault page in list form — all kinds, so personal pages show up too. */
  records: () => request<PageRecordSummary[]>('/api/brain/records'),
  /** The growth ledger; pass a page id for one page's trail. */
  events: (pageId?: string) => request<LearningEvent[]>(`/api/brain/events${pageId ? `?pageId=${encodeURIComponent(pageId)}` : ''}`),
  /** One page in full — works for concepts, syntheses, questions and legacy pages alike. */
  pageRecord: (id: string) => request<PageRecordView>(`/api/brain/pages/${encodeURIComponent(id)}/record`),

  // The Philosopher's starting points: the committed, course-linked pages of this student's wiki.
  anchors: () => request<AnchorCatalog>('/api/anchors'),
  /** Free text against the catalogue — 'ambiguous' returns the candidates to choose between. */
  anchorMatch: (q: string) => request<AnchorMatchResult>(`/api/anchors/match?q=${encodeURIComponent(q)}`),
  /** What consenting to the web this turn would send: a topic-only query, derived in code. */
  anchorWebPreview: (pageId: string) => request<WebPreview>(`/api/anchors/${encodeURIComponent(pageId)}/web-preview`),

  // Wiki maintenance: reads and suggestions only — repairs file as ordinary proposals.
  maintenance: () => request<MaintenanceReport>('/api/brain/maintenance'),
  runMaintenanceReview: () => post<SemanticReviewResult>('/api/brain/maintenance/review'),
  proposeMaintenance: (findingIds: string[]) => post<MaintenanceProposalResult>('/api/brain/maintenance/proposals', { findingIds }),
  dismissFinding: (id: string, note?: string) => post<MaintenanceReport>(`/api/brain/maintenance/findings/${encodeURIComponent(id)}/dismiss`, { note }),
  repairCatalogue: () => post<CatalogueRepairResult>('/api/brain/maintenance/catalogue'),
  /** Freeze a session's fresh turns as a source and stop — the compile and the decision are the student's. */
  reflectReview: (sessionId: string) => post<SourceReceipt>(`/api/brain/ingest/${encodeURIComponent(sessionId)}`, { review: true }),
  sessions: (teacher?: TeacherId) => request<SessionSummary[]>(`/api/sessions${teacher ? `?teacher=${teacher}` : ''}`),
  session: (id: string) => request<SessionDetail>(`/api/sessions/${encodeURIComponent(id)}`),
  deleteSession: (id: string) => request<{ ok: true }>(`/api/sessions/${encodeURIComponent(id)}`, { method: 'DELETE' }),

  // Contribute → job → proposal → review. No write happens without an accept.
  jobBoard: () => request<JobList>('/api/sources'),
  contribute: (body: ContributeBody) => post<SourceReceipt>('/api/sources', body),
  // Video links are two calls: metadata for the consent card, then the consented fetch.
  videoPreview: (url: string) => post<VideoPreview>('/api/sources/video-preview', { url }),
  videoIngest: (url: string) => post<SourceReceipt>('/api/sources/video', { url }),
  source: (id: string) => request<SourceDetail>(`/api/sources/${encodeURIComponent(id)}`),
  sourceBytes: (id: string) => requestBlob(`/api/sources/${encodeURIComponent(id)}/raw`),
  correctExtraction: (id: string, text: string) => request<SourceDetail>(`/api/sources/${encodeURIComponent(id)}/extraction`, { method: 'PUT', body: JSON.stringify({ text }) }),
  readSource: (id: string) => post<SourceReadResult>(`/api/sources/${encodeURIComponent(id)}/read`),
  compileJob: (jobId: string) => post<CompileResult>(`/api/sources/${encodeURIComponent(jobId)}/compile`),
  cancelJob: (jobId: string) => post<void>(`/api/sources/${encodeURIComponent(jobId)}/cancel`),
  retryJob: (jobId: string) => post<void>(`/api/sources/${encodeURIComponent(jobId)}/retry`),
  proposals: () => request<ProposalList>('/api/proposals'),
  proposalPreview: (id: string) => request<ProposalPreview>(`/api/proposals/${encodeURIComponent(id)}`),
  acceptProposal: (id: string, only?: { pageIds: string[] }) => post<ProposalAcceptance>(`/api/proposals/${encodeURIComponent(id)}/accept`, only ?? {}),
  rejectProposal: (id: string, note?: string) => post<WikiProposalRecord>(`/api/proposals/${encodeURIComponent(id)}/reject`, { note }),

  createQuiz: (key: string) => post<QuizPayload>(`/api/quiz/${encodeURIComponent(key)}`),
  submitQuiz: (id: string, answers: number[], attemptId: string) => post<QuizResult>(`/api/quiz/${encodeURIComponent(id)}/submit`, { answers, attemptId }),


  // Cohort sharing — the engine relays to the university share API on this profile's uni session.
  sharePages: () => request<ShareablePageList>('/api/shares/pages'),
  prepareShare: (input: ShareDraftRequest) => post<ShareDraftResponse>('/api/shares/prepare', input),
  publishShare: (request: PublishShareRequest) => post<PublishShareResult>('/api/shares/publish', request),
  peerFeed: (cursor?: string) => request<PeerFeedResponse>(`/api/shares/feed${cursor ? `?cursor=${encodeURIComponent(cursor)}` : ''}`),
  ownShares: () => request<OwnSharesResponse>('/api/shares/mine'),
  withdrawShare: (id: string) => post<PublishedShare>(`/api/shares/${encodeURIComponent(id)}/withdraw`),
  ignoreShare: (id: string, ignored: boolean) => post<void>(`/api/shares/${encodeURIComponent(id)}/ignore`, { ignored }),
  importShare: (id: string) => post<ShareImportResult>(`/api/shares/${encodeURIComponent(id)}/import`),

  // Personal logistics — private to this profile; proposals move only by the student's own click.
  logistics: () => request<LogisticsList>('/api/logistics'),
  createLogistics: (body: LogisticsWriteInput) => post<LogisticsRecordResult>('/api/logistics', body),
  updateLogistics: (id: string, patch: Partial<LogisticsWriteInput>) =>
    request<LogisticsRecordResult>(`/api/logistics/${encodeURIComponent(id)}`, { method: 'PUT', body: JSON.stringify(patch) }),
  confirmLogistics: (id: string, patch?: Partial<LogisticsWriteInput>) => post<LogisticsRecordResult>(`/api/logistics/${encodeURIComponent(id)}/confirm`, patch ?? {}),
  dismissLogistics: (id: string) => post<LogisticsRecordResult>(`/api/logistics/${encodeURIComponent(id)}/dismiss`, {}),
  deleteLogistics: (id: string) => request<void>(`/api/logistics/${encodeURIComponent(id)}`, { method: 'DELETE' }),
  /** A notice photo becomes proposed records — never confirmed; a failure answers honestly. */
  extractLogistics: (image: { mimeType: 'image/png' | 'image/jpeg'; data: string }, note?: string) =>
    post<LogisticsList>('/api/logistics/extract', { image, note }),

  // Vault portability — the student's own knowledge, exportable behind the local sign-in.
  exportVault: () => post<VaultExport>('/api/vault/export', {}),
  previewVaultImport: (archive: unknown) => post<VaultImportPreview>('/api/vault/import/preview', { archive }),
  restoreVault: (archive: unknown, overwritePageIds: string[]) => post<VaultImportResult>('/api/vault/import', { archive, overwritePageIds }),
  /** What still cites a source — shown before an erase, and part of the erase answer. */
  sourceDependents: (id: string) => request<SourceDependents>(`/api/sources/${encodeURIComponent(id)}/dependents`),
  eraseSource: (id: string, expectedRevision?: string) => post<SourceEraseResult>(`/api/sources/${encodeURIComponent(id)}/erase`, { expectedRevision }),
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
    /** Anchor candidates a 409 'anchor_ambiguous' refusal returned for the student to pick from. */
    readonly anchors?: AnchorCandidate[],
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
  /** The committed wiki page to explore from, with the catalogue revision it was picked at. */
  anchorPageId?: string;
  anchorRevision?: string;
  /** Free text naming a page — the engine resolves it; an ambiguous answer is a 409, never a guess. */
  anchorQuery?: string;
  /** A released syllabus concept offered as a start — resolves to the student's own page only. */
  syllabusConceptKey?: string;
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
    const body = (await res.json().catch(() => ({}))) as { error?: string; code?: string; anchors?: AnchorCandidate[] };
    if (body.code) throw new TurnRefused(body.code, body.error ?? `Turn refused (${res.status})`, res.status, body.anchors);
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

export function fileToBase64(file: File, mimeType?: string): Promise<{ mimeType: string; data: string; preview: string }> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => {
      const url = String(reader.result);
      resolve({ mimeType: mimeType ?? (file.type || 'image/png'), data: url.slice(url.indexOf(',') + 1), preview: url });
    };
    reader.onerror = () => reject(reader.error);
    reader.readAsDataURL(file);
  });
}
