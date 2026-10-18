import { DEMO_ADMIN, DEMO_PERSONAS, normalizeEmail } from '@sef/shared';
import { DEMO_SELF_SERVE } from './demo-self-serve';

/**
 * Demo helpers (one-click demo accounts, the shared demo password) exist only in demo builds.
 * Opt-in: only a build with VITE_DEMO_MODE=true offers a known credential. A self-serve demo
 * build (lib/demo-self-serve.ts) is a demo build too.
 */
export const DEMO_MODE = (import.meta.env.VITE_DEMO_MODE as string | undefined) === 'true' || DEMO_SELF_SERVE;

const DEMO_EMAILS = new Set([DEMO_ADMIN.email, ...DEMO_PERSONAS.map((p) => p.email)].map(normalizeEmail));

export const isDemoEmail = (email: string) => DEMO_EMAILS.has(normalizeEmail(email));
