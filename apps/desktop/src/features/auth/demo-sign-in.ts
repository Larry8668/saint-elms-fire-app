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
