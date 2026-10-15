/**
 * Where the university server is, for links the desktop app opens in the system browser.
 * The account and onboarding surfaces are hosted there; the student dashboard is not.
 */
export const UNI_URL = ((import.meta.env.VITE_UNI_URL as string | undefined) ?? 'http://localhost:4200').replace(/\/+$/, '');

/** The hosted onboarding/app shell, which handles registration, verification and applications. */
export const portalUrl = (path = ''): string => `${UNI_URL}/app${path ? `/${path.replace(/^\/+/, '')}` : ''}`;
