/**
 * Shared constants for the browser harness.
 *
 * The specs skip rather than fail when the university server was not started — a red run on
 * a machine with no database is noise, but a silently-passing run would be worse, so the skip
 * says exactly what is missing. Global setup records that outcome in a status file, because
 * setup and the workers are separate processes and an exported env var does not cross that
 * boundary.
 */

export const UNI_PORT = Number(process.env.E2E_UNI_PORT ?? 4310);
export const UNI_URL = `http://127.0.0.1:${UNI_PORT}`;
export const ENGINE_PORT = Number(process.env.E2E_ENGINE_PORT ?? 4311);
export const ENGINE_URL = `http://127.0.0.1:${ENGINE_PORT}`;
/** The fake Instabox the uni's session orchestrator talks to (PR-45). */
export const INSTABOX_PORT = Number(process.env.E2E_INSTABOX_PORT ?? 4312);
/**
 * The UI a workspace VM serves (same-origin build), served by the e2e engine when present:
 * `VITE_ENGINE_URL=same-origin VITE_DEMO_MODE=false pnpm --filter @sef/desktop exec vite build --outDir dist-workspace`.
 */
export const WORKSPACE_UI_DIR = process.env.E2E_WORKSPACE_UI_DIR ?? new URL('../apps/desktop/dist-workspace', import.meta.url).pathname;
/**
 * The web app hosted apart from the engine (PR-45d, the Vercel shape), served by `vite preview`
 * on its own origin when this build exists. Build it, and the portal that hands off to it:
 * `VITE_WORKSPACE_HOST_SUFFIX=127.0.0.1 VITE_UNI_URL=<uni> pnpm --filter @sef/desktop exec vite build --outDir dist-app`
 * `VITE_APP_URL=<APP_URL> pnpm --filter @sef/desktop build:portal`
 */
export const APP_PORT = Number(process.env.E2E_APP_PORT ?? 4313);
export const APP_URL = `http://127.0.0.1:${APP_PORT}`;
export const APP_DIR = process.env.E2E_APP_DIR ?? new URL('../apps/desktop/dist-app', import.meta.url).pathname;
/** Where account mail lands when the dev Mailpit profile is running. */
export const MAILPIT_URL = process.env.E2E_MAILPIT_URL ?? 'http://127.0.0.1:8025';

export interface E2EStatus {
  ok: boolean;
  reason?: string;
  engineUrl?: string;
  engineDataDir?: string;
  uniUrl?: string;
  workspaceUi?: boolean;
  /** Set when the web app runs on its own origin (APP_URL) and the engine allows only that one. */
  appUrl?: string;
}
