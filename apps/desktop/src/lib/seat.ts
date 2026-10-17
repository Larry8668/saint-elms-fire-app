/**
 * Where engine calls go. lib/api.ts reads `engineTarget()` on every call, so the address is
 * never a build-time constant baked into a module.
 *
 * - `served`: the UI an engine serves itself (`VITE_ENGINE_URL=same-origin`), so calls go to the
 *   page's own origin. Outside loopback that is a hosted workspace VM (PR-42), which can sit
 *   behind an edge that answers for it while it starts or after it went away.
 * - `workspace`: the web app (hosted apart from the engine, e.g. on Vercel) pointed at a
 *   student's workspace VM, which the portal handed over as `?workspace=<url>`. Calls cross
 *   origins; the VM allows the app's origin (`ENGINE_ALLOWED_ORIGINS`).
 * - `local`: this computer's engine (`VITE_ENGINE_URL`, else 127.0.0.1:4100).
 */
export type EngineTarget =
  | { kind: 'served'; base: ''; remote: boolean }
  | { kind: 'workspace'; base: string; host: string }
  | { kind: 'local'; base: string };

const LOOPBACK = new Set(['localhost', '127.0.0.1', '[::1]', '::1']);

const env = import.meta.env as Record<string, string | undefined> | undefined;
const configuredEngineUrl = env?.VITE_ENGINE_URL;
/** Workspace hosts must end with this: a forged link cannot point the app at someone else's engine. */
const configuredHostSuffix = env?.VITE_WORKSPACE_HOST_SUFFIX?.trim() || '.instabox.tech';

const pageHost = (): string | null => (typeof location === 'undefined' ? null : location.hostname);

/** The stored workspace record (`{ engineUrl }`), as the PR-39 seat record kept it, minus the machine id. */
export interface WorkspaceRecord {
  engineUrl: string;
}

const WORKSPACE_KEY = 'sef.workspace';

const appStorage = (): Storage | null => {
  try {
    return typeof localStorage === 'undefined' ? null : localStorage;
  } catch {
    return null;
  }
};

const hostAllowed = (hostname: string, suffix: string): boolean => {
  const want = suffix.toLowerCase();
  if (want.startsWith('.')) return hostname.length > want.length && hostname.endsWith(want);
  return hostname === want || hostname.endsWith(`.${want}`);
};

/**
 * A workspace URL reduced to its origin, or null: https (plain http only on loopback), no
 * credentials, query, fragment or path, and a host under the configured suffix.
 */
export function normalizeWorkspaceUrl(raw: unknown, suffix = configuredHostSuffix): string | null {
  if (typeof raw !== 'string' || !raw.trim()) return null;
  try {
    const url = new URL(raw.trim());
    const hostname = url.hostname.toLowerCase();
    const secure = url.protocol === 'https:' || (url.protocol === 'http:' && LOOPBACK.has(hostname));
    if (!secure || !hostname || url.username || url.password || url.search || url.hash) return null;
    if (url.pathname !== '/' && url.pathname !== '') return null;
    if (!hostAllowed(hostname, suffix)) return null;
    return url.origin;
  } catch {
    return null;
  }
}

/** The stored workspace, validated on every read; corrupt or disallowed is cleared and reads as none. */
export function readWorkspace(store: Storage | null = appStorage(), suffix = configuredHostSuffix): WorkspaceRecord | null {
  try {
    const raw = store?.getItem(WORKSPACE_KEY) ?? null;
    if (raw === null) return null;
    const engineUrl = normalizeWorkspaceUrl((JSON.parse(raw) as Partial<WorkspaceRecord> | null)?.engineUrl, suffix);
    if (engineUrl) return { engineUrl };
  } catch {
    // Falls through to clearing the record.
  }
  forgetWorkspace(store);
  return null;
}

/** Stores a workspace; false (and nothing stored) when the URL is not an allowed one. Never throws. */
export function writeWorkspace(engineUrl: string, store: Storage | null = appStorage(), suffix = configuredHostSuffix): boolean {
  const origin = normalizeWorkspaceUrl(engineUrl, suffix);
  if (!origin) return false;
  try {
    store?.setItem(WORKSPACE_KEY, JSON.stringify({ engineUrl: origin } satisfies WorkspaceRecord));
    return Boolean(store);
  } catch {
    return false;
  }
}

/** "Forget workspace": engine calls go back to this computer's engine. */
export function forgetWorkspace(store: Storage | null = appStorage()): void {
  try {
    store?.removeItem(WORKSPACE_KEY);
  } catch {
    // Storage that refuses writes still reads as no workspace.
  }
}

export function engineTarget(configured = configuredEngineUrl, host: string | null = pageHost(), store: Storage | null = appStorage(), suffix = configuredHostSuffix): EngineTarget {
  if (configured === 'same-origin') return { kind: 'served', base: '', remote: host !== null && !LOOPBACK.has(host) };
  const workspace = readWorkspace(store, suffix);
  if (workspace) return { kind: 'workspace', base: workspace.engineUrl, host: new URL(workspace.engineUrl).host };
  return { kind: 'local', base: configured ?? 'http://127.0.0.1:4100' };
}

/** True when engine calls cross a network edge that may answer for the engine (waking, gone). */
export const isRemoteTarget = (target: EngineTarget) => target.kind === 'workspace' || (target.kind === 'served' && target.remote);

/** True when the engine may be a hosted workspace VM (served by it, or handed to the web app). */
export const isWorkspaceTarget = (target: EngineTarget) => target.kind === 'served' || target.kind === 'workspace';

let pinned: EngineTarget | null = null;

/** The target for this call. Tests pin one, because node has neither `location` nor Vite's env. */
export const currentEngineTarget = (): EngineTarget => pinned ?? engineTarget();

export function pinEngineTargetForTests(target: EngineTarget | null): void {
  pinned = target;
}

const SESSION_KEY = 'sef.session';

export type WorkspaceIntake = 'none' | 'stored' | 'refused';

/**
 * Reads the portal's hand-off (`?workspace=<VM url>`) once, on load: an allowed URL is stored
 * and becomes the engine target, anything else is ignored. The parameter is always stripped
 * from the address bar. A new workspace drops a session token held for another engine.
 */
export function takeWorkspaceFromUrl(
  deps: {
    href: string;
    replaceUrl: (url: string) => void;
    store?: Storage | null;
    session?: Storage | null;
    suffix?: string;
  },
): WorkspaceIntake {
  let url: URL;
  try {
    url = new URL(deps.href);
  } catch {
    return 'none';
  }
  if (!url.searchParams.has('workspace')) return 'none';
  const raw = url.searchParams.get('workspace');
  url.searchParams.delete('workspace');
  deps.replaceUrl(`${url.pathname}${url.search}${url.hash}`);
  const store = deps.store === undefined ? appStorage() : deps.store;
  const suffix = deps.suffix ?? configuredHostSuffix;
  const before = readWorkspace(store, suffix)?.engineUrl;
  if (!writeWorkspace(raw ?? '', store, suffix)) return 'refused';
  if (before !== normalizeWorkspaceUrl(raw, suffix)) {
    try {
      (deps.session === undefined ? sessionStorage : deps.session)?.removeItem(SESSION_KEY);
    } catch {
      // No session storage: nothing held for another engine.
    }
  }
  return 'stored';
}
