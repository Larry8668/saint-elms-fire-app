import type { ConceptStatus, EdgeOrigin, EdgeType, IngestResult } from './brain';
import type { TeacherId } from './teachers';

/** Engine HTTP contract shared by the desktop app and the engine. */

export interface ChatAttachment {
  kind: 'image';
  mimeType: string;
  /** Base64 without the data: prefix. */
  data: string;
  name?: string;
}

export interface ChatTurn {
  role: 'user' | 'assistant';
  content: string;
  attachments?: ChatAttachment[];
}

export interface ChatRequest {
  teacher: TeacherId;
  sessionId: string;
  messages: ChatTurn[];
}

export interface SourceRef {
  kind: 'lesson' | 'brain' | 'web' | 'support';
  id: string;
  title: string;
  url?: string;
}

export interface VerificationCheck {
  id: string;
  label: string;
  passed: boolean;
  detail?: string;
}

export interface Verification {
  model: string;
  provider: string;
  sources: SourceRef[];
  checks: VerificationCheck[];
  toolCalls: Array<{ tool: string; summary: string }>;
  handoff?: { to: TeacherId; reason: string };
  lane?: 'answered' | 'redirected' | 'refused';
}

/** Server-sent events emitted by POST /api/chat. */
export type ChatStreamEvent =
  | { type: 'status'; message: string }
  | { type: 'delta'; text: string }
  | { type: 'tool'; tool: string; summary: string }
  | { type: 'done'; text: string; verification: Verification }
  | { type: 'error'; message: string };

export interface GraphNode {
  id: string;
  kind: 'lesson' | 'concept';
  label: string;
  courseId: string;
  courseName: string;
  subjectId: string;
  semesterNumber: number;
  lessonId?: string;
  /** Concept key in the student's brain, if this node is a concept. */
  key?: string;
  status: ConceptStatus;
  misconceptions: number;
  peer: boolean;
}

export interface GraphEdge {
  id: string;
  source: string;
  target: string;
  type: EdgeType;
  origin: EdgeOrigin;
  why?: string;
}

export interface GraphResponse {
  nodes: GraphNode[];
  edges: GraphEdge[];
  stats: { courseConcepts: number; lit: number; shaky: number; solid: number; studentLinks: number };
}

export interface ModelRoleConfig {
  provider: string;
  model: string;
}

export type ModelRole = 'tutor' | 'brain' | 'vision';

export interface ProviderConfig {
  id: string;
  kind: 'ollama' | 'openai-compatible' | 'openai' | 'anthropic';
  label: string;
  baseUrl?: string;
  /** Present only as a flag in responses; the key itself never leaves the engine. */
  hasApiKey?: boolean;
  apiKey?: string;
}

/** Device-wide settings. Who is studying comes from the signed-in profile, not from here. */
export interface EngineSettings {
  uniServerUrl: string;
  searxngUrl: string;
  providers: ProviderConfig[];
  roles: Record<ModelRole, ModelRoleConfig>;
  thinking: boolean;
}

export interface SyncStatus {
  uniReachable: boolean;
  /** The uni rejected this profile's token: sign in online again to sync. */
  authRequired?: boolean;
  cohortId: string;
  courses: Array<{
    id: string;
    title: string;
    semesterNumber: number;
    subjectId: string;
    lessonCount: number;
    remoteVersion?: string;
    localVersion?: string;
    state: 'available' | 'installed' | 'update' | 'local-only';
    support: boolean;
  }>;
}

export interface HealthResponse {
  ok: boolean;
  engine: string;
  uni: { reachable: boolean; url: string };
  models: Array<{ role: ModelRole; provider: string; model: string; reachable: boolean; detail?: string }>;
  web: { reachable: boolean };
}

export type { IngestResult };
