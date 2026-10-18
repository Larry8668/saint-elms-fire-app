/**
 * Self-serve demo mode (demo day): a judge picks a demo student and everything else happens by
 * itself. Opt-in with VITE_DEMO_SELF_SERVE=true plus VITE_DEMO_PASSWORD, the demo password the
 * university was seeded with, embedded in the build. That password then ships in public
 * JavaScript, which is acceptable only for a demo deployment whose personas hold seeded data.
 * Without both variables nothing here is active and every demo path stays manual.
 */
type Env = Record<string, string | undefined> | undefined;

/** The embedded demo password when self-serve is on, else null. Pure over the env, for tests. */
export function selfServePassword(env: Env): string | null {
  if (env?.VITE_DEMO_SELF_SERVE !== 'true') return null;
  const password = env.VITE_DEMO_PASSWORD;
  return password ? password : null;
}

const env = import.meta.env as Env;

/** The demo password this build signs demo students in with, or null outside self-serve builds. */
export const DEMO_SELF_SERVE_PASSWORD = selfServePassword(env);
export const DEMO_SELF_SERVE = DEMO_SELF_SERVE_PASSWORD !== null;
