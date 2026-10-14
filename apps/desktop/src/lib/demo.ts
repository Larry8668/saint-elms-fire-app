import { DEMO_ADMIN, DEMO_PERSONAS, normalizeEmail } from '@sef/shared';

/**
 * Demo helpers (one-click demo accounts, the shared demo password) exist only in demo builds.
 * Build with VITE_DEMO_MODE=false for a real deployment and the UI never offers a known credential.
 */
export const DEMO_MODE = (import.meta.env.VITE_DEMO_MODE as string | undefined) !== 'false';

const DEMO_EMAILS = new Set([DEMO_ADMIN.email, ...DEMO_PERSONAS.map((p) => p.email)].map(normalizeEmail));

export const isDemoEmail = (email: string) => DEMO_EMAILS.has(normalizeEmail(email));
