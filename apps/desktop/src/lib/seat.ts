/**
 * Where engine calls go. lib/api.ts reads `engineTarget()` on every call, so the address is
 * never a build-time constant baked into a module.
 *
 * - `served`: the UI an engine serves itself (`VITE_ENGINE_URL=same-origin`), so calls go to the
 *   page's own origin. Outside loopback that is a hosted workspace VM (PR-42), which can sit
 *   behind an edge that answers for it while it starts or after it went away.
 * - `local`: this computer's engine (`VITE_ENGINE_URL`, else 127.0.0.1:4100).
 */
export type EngineTarget = { kind: 'served'; base: ''; remote: boolean } | { kind: 'local'; base: string };

const LOOPBACK = new Set(['localhost', '127.0.0.1', '[::1]', '::1']);

const configuredEngineUrl = import.meta.env?.VITE_ENGINE_URL as string | undefined;

const pageHost = (): string | null => (typeof location === 'undefined' ? null : location.hostname);

export function engineTarget(configured = configuredEngineUrl, host: string | null = pageHost()): EngineTarget {
  if (configured === 'same-origin') return { kind: 'served', base: '', remote: host !== null && !LOOPBACK.has(host) };
  return { kind: 'local', base: configured ?? 'http://127.0.0.1:4100' };
}

/** True when engine calls cross a network edge that may answer for the engine (waking, gone). */
export const isRemoteTarget = (target: EngineTarget) => target.kind === 'served' && target.remote;

let pinned: EngineTarget | null = null;

/** The target for this call. Tests pin one, because node has neither `location` nor Vite's env. */
export const currentEngineTarget = (): EngineTarget => pinned ?? engineTarget();

export function pinEngineTargetForTests(target: EngineTarget | null): void {
  pinned = target;
}
