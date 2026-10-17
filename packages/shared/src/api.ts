import type { BrainDiffEntry, ConceptStatus, EdgeOrigin, EdgeType, IngestResult, SkyNodeKind } from './brain';
import type { AnchorCandidate } from './teacher-policy';
import type { TeacherId } from './teachers';
import type { CourseConceptRef, ProposalReport, WikiClaim, WikiLink, WikiProposalRecord } from './wiki';

/** Engine HTTP contract shared by the desktop app and the engine. */

export interface ChatAttachment {
  kind: 'image';
  mimeType: string;
  /** Base64 without the data: prefix. */
  data: string;
  name?: string;
  /**
   * Text the client says describes the image. Untrusted input: it is classified by the same
   * privacy check as a typed message and never widens what a teacher may reach.
   */
  altText?: string;
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
  /** Per-turn consent. The Philosopher reaches the web only with it, never by default. */
  consent?: { web: boolean };
  /** Page the Philosopher is asked to explore from. Unverified until the anchor seam resolves it. */
  anchorPageId?: string;
  /** The catalogue revision the client anchored to. A mismatch against the page on disk is a stale anchor. */
  anchorRevision?: string;
  /** A released syllabus concept offered as a starting point. Resolves to the student's own page for it, if one exists. */
  syllabusConceptKey?: string;
}

export interface SourceRef {
  kind: 'lesson' | 'brain' | 'web' | 'support' | 'logistics';
  id: string;
  title: string;
  url?: string;
  /** Lesson sources: course the lesson belongs to. */
  courseName?: string;
  /** Lesson sources: the heading of the section that best matches the answer, and its position among the lesson's headings. */
  section?: { heading: string; index: number };
  /** Short passage from the source that the answer most overlaps with. */
  excerpt?: string;
  /**
   * Whether the answer measurably drew on this source (deterministic term overlap), as opposed to it
   * merely being retrieved. Undefined for sources that are not attributed (brain, web).
   */
  cited?: boolean;
}

export interface VerificationCheck {
  id: string;
  label: string;
  passed: boolean;
  detail?: string;
}

/** What one served statement in a teacher's answer is, decided by code — never by the model. */
export type AnswerSegmentKind = 'fact' | 'belief' | 'deduction' | 'uncertainty' | 'question' | 'other';

export interface AnswerSegment {
  kind: AnswerSegmentKind;
  text: string;
  /**
   * 'supported' — verified against a permitted source (a resolving citation or measured overlap).
   * 'attributed' — a real, permitted source was named but its support was not measured.
   * 'not_required' — questions, honest uncertainty and connective text need no evidence.
   * Segments whose evidence checks fail are withheld before display and never reach this list.
   */
  support: 'supported' | 'attributed' | 'not_required';
  /** Permitted evidence ids this segment was verified against. */
  sources?: string[];
}

export interface Verification {
  model: string;
  provider: string;
  sources: SourceRef[];
  checks: VerificationCheck[];
  toolCalls: Array<{ tool: string; summary: string }>;
  handoff?: { to: TeacherId; reason: string };
  lane?: 'answered' | 'redirected' | 'refused';
  /** Provider class that served the answer, so the UI can disclose local vs hosted plainly. */
  providerKind?: ProviderConfig['kind'];
  /** The served answer split into what each statement is and what could be backed. */
  segments?: AnswerSegment[];
  /** Statements the evidence checks withheld before display. The count is honest; the text is not kept. */
  withheld?: number;
  /** The committed wiki page an exploring turn was anchored to, resolved from disk this turn. */
  anchor?: AnchorCandidate;
}

/** A persisted chat turn. Assistant turns keep the verification they were served with. */
export interface StoredTurn {
  role: ChatTurn['role'];
  content: string;
  /** Number of images sent with a user turn; the images themselves are never stored. */
  images?: number;
  at: string;
  verification?: Verification;
}

export interface SessionSummary {
  id: string;
  teacher: TeacherId;
  startedAt: string;
  updatedAt: string;
  turns: number;
  /** Turns not yet reflected into the brain. */
  pending: number;
  preview: string;
}

export interface SessionDetail {
  id: string;
  teacher: TeacherId;
  startedAt: string;
  updatedAt: string;
  turns: StoredTurn[];
  ingestedTurns: number;
  /** The exploration origin of an anchored session — the page it was last served under. */
  anchor?: AnchorCandidate;
}

/** Server-sent events emitted by POST /api/chat/turn. */
export type ChatStreamEvent =
  | { type: 'status'; message: string }
  | { type: 'delta'; text: string }
  | { type: 'tool'; tool: string; summary: string }
  | { type: 'done'; text: string; verification: Verification }
  | { type: 'error'; message: string };

export interface GraphNode {
  id: string;
  kind: SkyNodeKind;
  label: string;
  /**
   * 'course' = official syllabus star. 'student'/'peer' = a personal-sky page node; 'peer'
   * means the page's material came from an accepted peer share, never the student's own work.
   */
  origin: 'course' | 'student' | 'peer';
  courseId: string;
  courseName: string;
  subjectId: string;
  semesterNumber: number;
  lessonId?: string;
  /** Concept key in the student's brain, if this node is a concept. */
  key?: string;
  /** Vault page behind this node — the stable anchor for deep links and the brain view. */
  pageId?: string;
  /** Last committed update of that page. */
  updated?: string;
  status: ConceptStatus;
  misconceptions: number;
  peer: boolean;
  /** Growth events on this page: collected material vs understanding the student demonstrated. */
  collected?: number;
  demonstrated?: number;
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
  stats: {
    courseConcepts: number;
    lit: number;
    shaky: number;
    solid: number;
    studentLinks: number;
    /** Personal-sky nodes (own concepts, syntheses, open questions) outside the released syllabus. */
    personalPages: number;
    /** Growth events that only record collected material — never mastery. */
    collected: number;
    /** Growth events where the student demonstrated understanding. */
    demonstrated: number;
  };
}

/** One vault page in list form — any kind, not only concepts. */
export interface PageRecordSummary {
  id: string;
  kind: 'concept' | 'source_summary' | 'synthesis' | 'question';
  title: string;
  summary: string;
  updatedAt: string;
  revision: string;
  /** 'legacy' = adopted from the earlier concept vault; 'peer' = built from a peer share. */
  origin: 'student' | 'peer' | 'legacy';
  /** Concept pages only: computed status and open misconception count. */
  status?: ConceptStatus;
  openMisconceptions?: number;
}

/** One vault page in full, for the detail sheet — works for every page kind. */
export interface PageRecordView extends PageRecordSummary {
  markdown: string;
  courseRefs: CourseConceptRef[];
  claims: WikiClaim[];
  links: WikiLink[];
  learner: { inMyWords: string; stuck: string; connections: string; evidenceIds: string[] } | null;
  sourceIds: string[];
}

export interface ModelRoleConfig {
  provider: string;
  model: string;
}

export type ModelRole = 'tutor' | 'brain' | 'vision' | 'embed';

export interface ProviderConfig {
  id: string;
  kind: 'ollama' | 'openai-compatible' | 'openai' | 'anthropic';
  label: string;
  baseUrl?: string;
  /** Present only as a flag in responses; the key itself never leaves the engine. */
  hasApiKey?: boolean;
  apiKey?: string;
}

/** Combined engine settings: device server endpoints plus profile-local model choices and provider credentials. */
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
    /**
     * False when the installed manifest predates signed academic metadata. The file hashes
     * were verified; the metadata was not covered by the signature until the next sync.
     */
    signedMetadata?: boolean;
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

/** POST /api/sources body: raw bytes base64-encoded, with the student's own provenance claim. */
export interface ContributeBody {
  kind: 'note' | 'document' | 'image' | 'audio';
  title: string;
  mediaType: string;
  /** Base64 without the data: prefix. */
  data: string;
  /** 'student' = own understanding; 'external' = filed under its real attribution. Kinds restrict the choice. */
  origin?: 'student' | 'external';
  attribution?: { creator?: string; url?: string };
}

/** POST /api/proposals/:id/accept — the decided record, the journaled report, and a fresh page diff. */
export interface ProposalAcceptance {
  record: WikiProposalRecord;
  report: ProposalReport;
  diff: BrainDiffEntry[];
}
