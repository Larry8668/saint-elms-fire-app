import { log } from '@/lib/log';

/**
 * Every call in this app is same-origin against the university server, which is also what
 * serves this build. The staff session is an HttpOnly better-auth cookie: there is no token to
 * hold, read or refresh here, so `credentials: 'include'` is the whole of the auth story.
 */
export const API_BASE = '/v1';
export const ACCOUNT_BASE = '/v1/auth';

export type ErrorKind =
  | 'unauthenticated'
  | 'forbidden'
  | 'reauthentication'
  | 'conflict'
  | 'not-found'
  | 'invalid'
  | 'unavailable'
  | 'network'
  | 'contract'
  | 'unknown';

export class ApiError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly code: string,
    /** Server-authored detail for codes the university controls; never shown for auth codes. */
    readonly detail?: string,
  ) {
    super(message);
    this.name = 'ApiError';
  }
}

/**
 * Fixed copy for better-auth codes: its messages can embed the submitted address or internal
 * detail, so an unrecognised auth code gets a generic line plus the code for support.
 */
const AUTH_MESSAGES: Record<string, string> = {
  INVALID_EMAIL_OR_PASSWORD: 'That email address and password do not match an account.',
  EMAIL_NOT_VERIFIED: 'Verify this email address first, then sign in again.',
  FAILED_TO_CREATE_SESSION: 'The server could not start a session for that account.',
  TOO_MANY_REQUESTS: 'Too many attempts. Wait a few minutes and try again.',
  INVALID_TWO_FACTOR_COOKIE: 'That two-factor challenge has expired. Sign in again.',
  INVALID_TWO_FACTOR_CODE: 'That code is not valid. Check your authenticator and try again.',
  INVALID_TOKEN: 'That link has expired or has already been used.',
  USER_NOT_FOUND: 'No account exists for that email address.',
  account_auth_unavailable: 'This server has no account service configured.',
  internal_error: 'The university server hit an error. Try again shortly.',
};

/** Staff/admission codes, whose status the university itself defines (see `admissionErrorStatus`). */
const UNI_KINDS: Record<string, ErrorKind> = {
  unauthenticated: 'unauthenticated',
  forbidden: 'forbidden',
  reauthentication_required: 'reauthentication',
  verification_required: 'forbidden',
  not_found: 'not-found',
  version_conflict: 'conflict',
  invalid_transition: 'conflict',
  already_enrolled: 'conflict',
  invalid_request: 'invalid',
  cohort_required: 'invalid',
  unknown_cohort: 'invalid',
  recovery_unavailable: 'unavailable',
  admission_unavailable: 'unavailable',
  account_auth_unavailable: 'unavailable',
  network_unavailable: 'network',
  contract_mismatch: 'contract',
};

export const kindOf = (code: string, status: number): ErrorKind => {
  const known = UNI_KINDS[code];
  if (known) return known;
  if (status === 401) return 'unauthenticated';
  if (status === 403) return 'forbidden';
  if (status === 404) return 'not-found';
  if (status === 409) return 'conflict';
  if (status === 0) return 'network';
  if (status >= 500) return 'unavailable';
  return 'unknown';
};

const messageFor = (code: string, status: number, detail: string | undefined): string => {
  if (AUTH_MESSAGES[code]) return AUTH_MESSAGES[code];
  // The university owns the wording for its own admission codes, and it is the only party that
  // knows the current version or transition being refused.
  if (detail && kindOf(code, status) !== 'unauthenticated') return detail;
  return `The university server refused that request (${code || status}).`;
};

/** One place that decides what a failure means, so no view invents its own status wording. */
export function describe(error: unknown): { kind: ErrorKind; code: string; message: string; status: number } {
  if (error instanceof ApiError) {
    return { kind: kindOf(error.code, error.status), code: error.code, message: error.message, status: error.status };
  }
  return {
    kind: 'unknown',
    code: 'unknown_error',
    message: 'Something went wrong in this app. Try again.',
    status: 0,
  };
}

async function request(path: string, init: RequestInit): Promise<unknown> {
  let response: Response;
  try {
    response = await fetch(path, {
      ...init,
      credentials: 'include',
      headers: { 'content-type': 'application/json', ...init.headers },
    });
  } catch {
    log.warn('admin_request_failed', { path, reason: 'network' });
    throw new ApiError('The university server could not be reached. Check your connection and try again.', 0, 'network_unavailable');
  }

  if (response.status === 204 || response.status === 202) return null;

  const raw = await response.json().catch(() => null);
  if (!response.ok) {
    const body = (raw ?? {}) as { error?: string; code?: string; message?: string };
    // The staff API answers `{ error }`; better-auth answers `{ code }`.
    const code = body.error ?? body.code ?? '';
    const detail = typeof body.message === 'string' && body.message.trim() ? body.message : undefined;
    log.warn('admin_request_failed', { path, status: response.status, code });
    throw new ApiError(messageFor(code, response.status, detail), response.status, code, detail);
  }
  return raw;
}

export const getJson = (path: string): Promise<unknown> => request(path, { method: 'GET' });

export const sendJson = (path: string, method: 'POST' | 'PATCH', body: unknown): Promise<unknown> =>
  request(path, { method, body: JSON.stringify(body) });

/** Raised when a response does not match the contract the UI is written against. */
export const contractError = (what: string): ApiError => {
  log.error('admin_contract_mismatch', { what });
  return new ApiError(`The university server returned ${what} this app cannot read.`, 0, 'contract_mismatch');
};