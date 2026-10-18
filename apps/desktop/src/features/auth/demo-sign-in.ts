import { DEMO_PASSWORD_DEFAULT } from '@sef/shared';
import type { SignInCopyMode } from './sign-in-copy';

/**
 * What a persona button does. Locally the engine seeds the personas with the public demo
 * password, so one click signs in. A hosted workspace signs in against a university that
 * refuses that public password in production, so the button asks for the demo password the
 * presenter was given instead of sending one that is bound to fail.
 */
export type PersonaClick = { kind: 'sign-in'; email: string; password: string } | { kind: 'prompt'; email: string };

export function personaClick(mode: SignInCopyMode, email: string): PersonaClick {
  return mode === 'hosted' ? { kind: 'prompt', email } : { kind: 'sign-in', email, password: DEMO_PASSWORD_DEFAULT };
}

/** The prompt's submit: nothing is sent until a password was typed. */
export function promptSubmit(email: string, typed: string): PersonaClick | null {
  return typed.length > 0 ? { kind: 'sign-in', email, password: typed } : null;
}

/**
 * The demo persona a workspace's own profile list points at. Only an unambiguous answer
 * preselects: exactly one profile, matching exactly one demo account by email or id.
 */
export function matchDemoProfile(profiles: ReadonlyArray<{ id: string; email: string }> | undefined, accounts: ReadonlyArray<{ id: string; email: string }>): string | null {
  if (profiles?.length !== 1) return null;
  const [profile] = profiles;
  const email = profile.email.trim().toLowerCase();
  const hits = accounts.filter((a) => a.email.toLowerCase() === email || a.id === profile.id);
  return hits.length === 1 ? hits[0].email : null;
}

/**
 * Self-serve demo builds: on a hosted workspace the portal handed a persona to, sign it in by
 * itself with the embedded password. Only the portal's hand-off counts (never a guess from the
 * profile list), and nothing happens without an embedded password.
 */
export function autoDemoSignIn(
  mode: SignInCopyMode,
  handedOver: string | null,
  password: string | null,
  accounts: ReadonlyArray<{ id: string; email: string; label: string }>,
): { email: string; password: string; label: string } | null {
  if (mode !== 'hosted' || !handedOver || !password) return null;
  const account = accounts.find((a) => a.id === handedOver);
  return account ? { email: account.email, password, label: account.label } : null;
}

/** "Signing in as the first-year student…" */
export const autoSignInLine = (label: string) => `Signing in as the ${label.charAt(0).toLowerCase()}${label.slice(1)}…`;

/** The persona to preselect: the portal's hand-off wins, the workspace's own profile list is the fallback. */
export function preselectedPersona(handedOver: string | null, profiles: ReadonlyArray<{ id: string; email: string }> | undefined, accounts: ReadonlyArray<{ id: string; email: string }>): string | null {
  const handed = handedOver ? accounts.find((a) => a.id === handedOver) : undefined;
  return handed?.email ?? matchDemoProfile(profiles, accounts);
}
