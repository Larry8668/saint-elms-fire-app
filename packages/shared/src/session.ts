/**
 * Ephemeral study sessions (PR-42): the uni server leases one Instabox VM per signed-in
 * student, spawns it from the golden snapshot and tears it down when they go idle.
 * These are the shapes the "Starting your workspace…" client (PR-45) reads.
 */

/**
 * `queued`: holding the lease, waiting for a free machine slot.
 * `spawning` → `ready` → `stopping` → `ended`; `failed` when the spawn could not finish
 * (its machine is deleted before the row says so).
 */
export const SESSION_STATES = ['queued', 'spawning', 'ready', 'stopping', 'ended', 'failed'] as const;
export type SessionState = (typeof SESSION_STATES)[number];

/** States that hold the student's one lease. A new session can start only when none is live. */
export const LIVE_SESSION_STATES = ['queued', 'spawning', 'ready', 'stopping'] as const satisfies readonly SessionState[];

/** The spawn sequence, in order. Each finished step is persisted before the next starts. */
export const SESSION_STEPS = ['create', 'start', 'publish', 'session_start', 'health'] as const;
export type SessionStep = (typeof SESSION_STEPS)[number];

/** What the progress screen shows for each step. */
export const SESSION_STEP_LABELS: Record<SessionStep, string> = {
  create: 'Creating your workspace',
  start: 'Starting it up',
  publish: 'Giving it an address',
  session_start: 'Starting your study engine',
  health: 'Restoring your vault',
};

export interface SessionStepStatus {
  name: SessionStep;
  label: string;
  status: 'pending' | 'active' | 'done' | 'failed';
}

/** POST/GET /v1/session. `url` appears only once the engine is ready; `position` only while queued (1 = next). */
export interface StudentSessionStatus {
  id: string;
  state: SessionState;
  step: SessionStep | null;
  steps: SessionStepStatus[];
  url?: string;
  position?: number;
  /** Set while the spawn waits for Instabox capacity, or after a failure. Never holds internals. */
  /** `reason` (spawn_failed only) is a fixed, student-safe sentence on why; never an id, URL or raw output. */
  error?: { code: string; message: string; retryable: boolean; reason?: string };
  createdAt: string;
  readyAt?: string;
}

/** One row of GET /v1/admin/sessions. No URL, token or key: staff see that a session exists, not how to reach it. */
export interface AdminSessionRow {
  id: string;
  accountId: string;
  accountKind: 'legacy' | 'user';
  state: SessionState;
  step: SessionStep | null;
  machineId: string | null;
  heartbeatAt: string;
  leaseExpiresAt: string;
  createdAt: string;
  readyAt: string | null;
  lastError: string | null;
}
