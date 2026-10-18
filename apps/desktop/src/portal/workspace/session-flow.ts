import type { SessionStepStatus, StudentSessionStatus } from '@sef/shared';

/**
 * "Open my workspace": POST /v1/session, poll GET /v1/session through queued and spawning, then
 * hand the browser to the VM once the browser itself can see the VM's public health say ready.
 * Pure over its dependencies, so the whole sequence runs under a fake clock in tests.
 */

export type FlowFailure =
  /** The university has no session orchestrator configured. */
  | 'unavailable'
  /** The account is not an approved, enrolled student (or the uni refused the account id). */
  | 'unapproved'
  | 'signed_out'
  /** The spawn failed on the university's side; a new request starts over. */
  | 'spawn_failed'
  /** The session ended while this page watched it (logout elsewhere, idle, staff). */
  | 'ended'
  /** The university stopped answering. */
  | 'network'
  /** The workspace came up for the university but never answered this browser. */
  | 'unreachable'
  /** The workspace answered, but restoring the notes failed. */
  | 'sync_error'
  | 'timeout';

export type WorkspaceFlow =
  | { phase: 'requesting' }
  | { phase: 'queued'; position: number | null; steps: SessionStepStatus[] }
  | { phase: 'spawning'; steps: SessionStepStatus[]; waitingForCapacity: boolean }
  /** The previous session is still doing its final save; a new one can start once it has ended. */
  | { phase: 'previous-stopping' }
  /** The university says ready; this browser is checking the VM's own health before leaving. */
  | { phase: 'connecting'; url: string; steps: SessionStepStatus[]; restoring: boolean }
  | { phase: 'ready'; url: string }
  /** `detail` is the university's short, student-safe reason for a failed spawn, when it gave one. */
  | { phase: 'failed'; reason: FlowFailure; retryable: boolean; detail?: string };

export type FlowError = { status: number; code: string };

export interface FlowDeps {
  /** POST /v1/session. Rejects with a FlowError-shaped error on a refusal. */
  start: () => Promise<StudentSessionStatus>;
  /** GET /v1/session; null when the university has no session for this account (404). */
  status: () => Promise<StudentSessionStatus | null>;
  /** GET <url>/api/health from this browser. Resolves null when nothing answered. */
  probe: (url: string) => Promise<{ status: number; body: unknown } | null>;
  sleep: (ms: number) => Promise<void>;
  now: () => number;
}

export const SPAWN_POLL_MS = 1_000;
export const QUEUE_POLL_MS = 3_000;
export const HEALTH_POLL_MS = 1_000;
/** The university already waited for health; this covers the edge catching up for this browser. */
export const HANDOFF_TIMEOUT_MS = 90_000;
/** The uni's own step timeouts end a spawn long before this; it only stops a page that would watch forever. */
export const SPAWN_TIMEOUT_MS = 10 * 60_000;
/** Consecutive status polls that may fail (network) before the page gives up. */
export const MAX_POLL_FAILURES = 5;
/** After a previous session finishes stopping, one new request is made for the student; never more. */
export const MAX_AUTO_RESTARTS = 1;

/** A failed spawn, with the reason the university gave (if any) so the student is told why. */
const spawnFailed = (status: StudentSessionStatus): WorkspaceFlow => ({
  phase: 'failed',
  reason: 'spawn_failed',
  retryable: true,
  ...(status.error?.reason ? { detail: status.error.reason } : {}),
});

const isFlowError = (error: unknown): error is FlowError =>
  typeof (error as FlowError | null)?.status === 'number' && typeof (error as FlowError | null)?.code === 'string';

function failureOf(error: unknown): WorkspaceFlow {
  if (!isFlowError(error) || error.status === 0) return { phase: 'failed', reason: 'network', retryable: true };
  if (error.status === 401) return { phase: 'failed', reason: 'signed_out', retryable: false };
  if (error.status === 403 || error.code === 'account_unsupported') return { phase: 'failed', reason: 'unapproved', retryable: false };
  if (error.code === 'session_orchestrator_unavailable') return { phase: 'failed', reason: 'unavailable', retryable: false };
  return { phase: 'failed', reason: 'network', retryable: true };
}

export type HealthVerdict = 'ready' | 'restoring' | 'sync_error' | 'down';

/**
 * Public health, as the browser sees it. `sync` comes with PR-41b/#82: when present it must say
 * `ready`; an engine without the field has no sync layer and is ready once it is `ok`.
 */
export function healthVerdict(answer: { status: number; body: unknown } | null): HealthVerdict {
  if (!answer || answer.status !== 200) return 'down';
  const body = answer.body as { ok?: unknown; sync?: { state?: unknown } } | null;
  if (body?.ok !== true) return 'down';
  if (body.sync === undefined || body.sync === null) return 'ready';
  const state = body.sync.state;
  if (state === 'ready') return 'ready';
  if (state === 'error') return 'sync_error';
  return 'restoring';
}

/** Polls the VM's public health from this browser until it is ready, or the window closes. */
export async function waitForWorkspace(
  url: string,
  deps: Pick<FlowDeps, 'probe' | 'sleep' | 'now'>,
  onRestoring: (restoring: boolean) => void,
  signal?: AbortSignal,
): Promise<'ready' | 'sync_error' | 'unreachable' | 'aborted'> {
  const started = deps.now();
  let restoring = false;
  for (;;) {
    if (signal?.aborted) return 'aborted';
    const verdict = healthVerdict(await deps.probe(url).catch(() => null));
    if (verdict === 'ready') return 'ready';
    if (verdict === 'sync_error') return 'sync_error';
    if ((verdict === 'restoring') !== restoring) {
      restoring = verdict === 'restoring';
      onRestoring(restoring);
    }
    if (deps.now() - started >= HANDOFF_TIMEOUT_MS) return 'unreachable';
    await deps.sleep(HEALTH_POLL_MS);
  }
}

/** Only https, or http on loopback (a local engine under test), is a URL this page will hand off to. */
export function safeWorkspaceUrl(raw: string | undefined): string | null {
  if (!raw) return null;
  try {
    const url = new URL(raw);
    const loopback = url.hostname === '127.0.0.1' || url.hostname === 'localhost' || url.hostname === '[::1]';
    if (url.protocol !== 'https:' && !(url.protocol === 'http:' && loopback)) return null;
    if (url.username || url.password) return null;
    return url.href.replace(/\/+$/, '');
  } catch {
    return null;
  }
}

/**
 * Where the browser goes once the workspace is ready. With the web app hosted apart from the
 * VM (`VITE_APP_URL`, e.g. on Vercel), that is the app, told which workspace to use; the app
 * validates the URL again before it calls it. Without one, the VM serves its own UI: go there.
 */
export function handoffUrl(workspaceUrl: string, appUrl: string | undefined): string {
  const app = appUrl?.trim().replace(/\/+$/, '');
  if (!app) return workspaceUrl;
  return `${app}/?workspace=${encodeURIComponent(workspaceUrl)}`;
}

/**
 * Runs the whole flow, emitting every state it passes through, and resolves with the terminal
 * one (`ready` or `failed`). Aborting the signal resolves with the last state and emits nothing more.
 */
export async function runWorkspaceFlow(deps: FlowDeps, emit: (state: WorkspaceFlow) => void, signal?: AbortSignal): Promise<WorkspaceFlow> {
  let last: WorkspaceFlow = { phase: 'requesting' };
  const say = (state: WorkspaceFlow) => {
    last = state;
    if (!signal?.aborted) emit(state);
    return state;
  };
  say(last);

  let status: StudentSessionStatus;
  try {
    status = await deps.start();
  } catch (error) {
    return say(failureOf(error));
  }

  const started = deps.now();
  let failures = 0;
  let restarts = 0;
  for (;;) {
    if (signal?.aborted) return last;
    if (deps.now() - started >= SPAWN_TIMEOUT_MS && status.state !== 'queued') return say({ phase: 'failed', reason: 'timeout', retryable: true });

    let wait = SPAWN_POLL_MS;
    switch (status.state) {
      case 'queued':
        say({ phase: 'queued', position: status.position ?? null, steps: status.steps });
        wait = QUEUE_POLL_MS;
        break;
      case 'spawning':
        say({ phase: 'spawning', steps: status.steps, waitingForCapacity: status.error?.code === 'no_capacity' });
        break;
      case 'stopping':
        // A spawn that failed is being torn down: it will not recover, so do not wait on it.
        if (status.error?.code === 'spawn_failed') return say(spawnFailed(status));
        say({ phase: 'previous-stopping' });
        break;
      case 'ready': {
        const url = safeWorkspaceUrl(status.url);
        if (!url) return say({ phase: 'failed', reason: 'spawn_failed', retryable: true });
        const steps = status.steps;
        say({ phase: 'connecting', url, steps, restoring: false });
        const outcome = await waitForWorkspace(url, deps, (restoring) => say({ phase: 'connecting', url, steps, restoring }), signal);
        if (outcome === 'aborted') return last;
        if (outcome === 'ready') return say({ phase: 'ready', url });
        return say({ phase: 'failed', reason: outcome, retryable: true });
      }
      case 'failed':
        return say(spawnFailed(status));
      case 'ended':
        return say({ phase: 'failed', reason: 'ended', retryable: true });
    }

    await deps.sleep(wait);
    if (signal?.aborted) return last;
    try {
      const wasStopping = status.state === 'stopping';
      const next = await deps.status();
      failures = 0;
      if (!next) return say({ phase: 'failed', reason: 'ended', retryable: true });
      // The old session finished its final save: now a new one can start.
      // Only a session that ended cleanly is replaced, and only once: a failed one means the
      // spawn itself is broken, and asking again for ever is what this must never do.
      if (wasStopping && next.state === 'failed') return say(spawnFailed(next));
      if (wasStopping && next.state === 'ended') {
        if (restarts >= MAX_AUTO_RESTARTS) return say({ phase: 'failed', reason: 'ended', retryable: true });
        restarts += 1;
        status = await deps.start();
      } else {
        status = next;
      }
    } catch (error) {
      if (isFlowError(error) && error.status !== 0) return say(failureOf(error));
      failures += 1;
      if (failures >= MAX_POLL_FAILURES) return say({ phase: 'failed', reason: 'network', retryable: true });
    }
  }
}
