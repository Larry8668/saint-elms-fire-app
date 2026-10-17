import { DEMO_ACCOUNTS, type DemoAccount } from '@/lib/demo-accounts';

/**
 * "Demo student" sign-in: pick one of the seeded personas, type the demo password this
 * university was given, and sign in through the legacy login. Pure over the login call, so
 * the whole sequence is tested without a browser.
 */
export type DemoSignIn =
  | { phase: 'choosing'; personaId: DemoAccount['id'] | null; error: { message: string; code: string } | null }
  | { phase: 'submitting'; persona: DemoAccount }
  | { phase: 'signed-in'; persona: DemoAccount };

export const DEMO_START: DemoSignIn = { phase: 'choosing', personaId: null, error: null };

export const pickPersona = (state: DemoSignIn, personaId: DemoAccount['id']): DemoSignIn =>
  state.phase === 'choosing' ? { phase: 'choosing', personaId, error: null } : state;

type LoginError = { message: string; status: number; code: string };
const isLoginError = (error: unknown): error is LoginError =>
  typeof (error as LoginError | null)?.message === 'string' && typeof (error as LoginError | null)?.code === 'string';

/**
 * Submits the form. Without a persona or a password nothing is sent; otherwise it emits
 * `submitting`, calls the login, and resolves with `signed-in` or back to `choosing` with
 * the refusal (the persona stays picked, so a mistyped password is one retype away).
 */
export async function submitDemoSignIn(
  state: DemoSignIn,
  password: string,
  login: (email: string, password: string) => Promise<void>,
  emit: (state: DemoSignIn) => void,
): Promise<DemoSignIn> {
  if (state.phase !== 'choosing') return state;
  const persona = DEMO_ACCOUNTS.find((a) => a.id === state.personaId);
  if (!persona) return say(emit, { ...state, error: { message: 'Pick a demo student first.', code: 'no_persona' } });
  if (!password) return say(emit, { ...state, error: { message: 'Enter the demo password.', code: 'no_password' } });

  emit({ phase: 'submitting', persona });
  try {
    await login(persona.email, password);
  } catch (error) {
    const refusal = isLoginError(error) ? { message: error.message, code: error.code } : { message: 'Sign-in failed. Try again.', code: 'unexpected' };
    return say(emit, { phase: 'choosing', personaId: persona.id, error: refusal });
  }
  return say(emit, { phase: 'signed-in', persona });
}

function say(emit: (state: DemoSignIn) => void, state: DemoSignIn): DemoSignIn {
  emit(state);
  return state;
}
