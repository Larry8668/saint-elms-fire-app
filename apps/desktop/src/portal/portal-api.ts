import {
  AdmissionMeSchema,
  CONTRACT_VERSION,
  EnrolmentSchema,
  ProgrammeCatalogueSchema,
  ProgrammeSchema,
  type AdmissionMe,
  type Enrolment,
  type Programme,
  type ProgrammeSummary,
  type StudentSessionStatus,
} from '@sef/shared';
import { log } from '@/lib/log';

/**
 * Every call is same-origin against the university server, which is also what serves this
 * build. The session is an HttpOnly better-auth cookie: there is no token to hold, read or
 * refresh here, so `credentials: 'include'` is the whole of the auth story.
 */
const ACCOUNT_BASE = '/v1/auth';
const API_BASE = '/v1';

/** Where the server sends the student back after clicking a verification or magic link. */
export const RETURN_PATH = '/app?verified=1';

export class PortalError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly code: string,
  ) {
    super(message);
  }
}

/**
 * Fixed copy per known code. A raw better-auth message can embed the submitted address or
 * internal detail, so an unrecognised code gets a generic message plus the code for support
 * rather than the server's string.
 */
export const MAIL_SEND_FAILED = 'mail_send_failed';

const MESSAGES: Record<string, string> = {
  [MAIL_SEND_FAILED]: 'We could not send the email. Try again in a moment.',
  // Account layer.
  USER_ALREADY_EXISTS: 'An account already exists for that email address. Sign in instead, or reset the password.',
  INVALID_EMAIL_OR_PASSWORD: 'That email address and password do not match an account.',
  EMAIL_NOT_VERIFIED: 'Verify your email address first. Check your inbox for the link we sent.',
  INVALID_TOKEN: 'That link has expired or has already been used. Request a new one.',
  USER_NOT_FOUND: 'No account exists for that email address.',
  FAILED_TO_CREATE_SESSION: 'We could not start a session for that account. Try again in a moment.',
  TOO_MANY_REQUESTS: 'Too many attempts. Wait a few minutes and try again.',
  // Admission layer.
  verification_required: 'Verify your email address before applying to the programme.',
  unknown_programme: 'The university did not recognise that programme. Contact the registrar.',
  programme_unavailable: 'The programme is not published yet. Try again shortly.',
  unapproved: 'You do not have access to the programme yet.',
  account_auth_unavailable: 'This server has no account service configured.',
  internal_error: 'The university server hit an error. Try again shortly.',
  not_found: 'The university server could not find what was asked for.',
  invalid_request: 'The university server rejected that request.',
  // Hosted workspaces.
  session_orchestrator_unavailable: 'Hosted workspaces are not set up on this university server.',
  no_session: 'You have no workspace open right now.',
  account_unsupported: 'This account cannot open a hosted workspace. Contact the registrar.',
  // Demo students (legacy accounts).
  invalid_credentials: 'That password does not match this demo student.',
  rate_limited: 'Too many attempts. Wait a few minutes and try again.',
};

/**
 * A demo student is a legacy account, not a better-auth one, so it has no cookie: its signed
 * token is held here, in memory only, and sent as a bearer on this page's calls. A reload
 * forgets it, which is the point: nothing about it is written to storage.
 */
let legacyToken: string | null = null;

const messageFor = (code: string, status: number): string =>
  MESSAGES[code] ?? `The university server refused that request (${code || status}).`;

async function request<T>(path: string, init: RequestInit, parse: (raw: unknown) => T): Promise<T> {
  let response: Response;
  try {
    response = await fetch(path, {
      ...init,
      credentials: 'include',
      headers: { 'content-type': 'application/json', ...(legacyToken ? { authorization: `Bearer ${legacyToken}` } : {}), ...init.headers },
    });
  } catch {
    log.warn('portal_request_failed', { path, reason: 'network' });
    throw new PortalError('The university server could not be reached. Check your connection and try again.', 0, 'network_unavailable');
  }

  const raw = await response.json().catch(() => null);
  // The uni answers 200 even when better-auth could not hand the mail to the provider (it
  // swallows the error); this header is how the failure reaches the student.
  if (response.ok && response.headers.get('x-mail-delivery') === 'failed') {
    log.warn('portal_request_failed', { path, status: response.status, code: MAIL_SEND_FAILED });
    throw new PortalError(MESSAGES[MAIL_SEND_FAILED]!, response.status, MAIL_SEND_FAILED);
  }
  if (!response.ok) {
    const code = (raw as { code?: string; error?: string } | null)?.code ?? (raw as { error?: string } | null)?.error ?? '';
    log.warn('portal_request_failed', { path, status: response.status, code });
    throw new PortalError(messageFor(code, response.status), response.status, code);
  }
  return parse(raw);
}

/** Registration only creates the account; a separate verification link is mailed out. */
export function registerAccount(input: { name: string; email: string; password: string }): Promise<void> {
  return request(
    `${ACCOUNT_BASE}/sign-up/email`,
    { method: 'POST', body: JSON.stringify({ ...input, callbackURL: RETURN_PATH }) },
    () => undefined,
  );
}

export function signIn(input: { email: string; password: string }): Promise<void> {
  return request(`${ACCOUNT_BASE}/sign-in/email`, { method: 'POST', body: JSON.stringify(input) }, () => undefined);
}

/** Requests the single-use link. `name` only matters when the address has no account yet. */
export function requestMagicLink(email: string, name?: string): Promise<void> {
  return request(
    `${ACCOUNT_BASE}/sign-in/magic-link`,
    {
      method: 'POST',
      body: JSON.stringify({
        email,
        name,
        callbackURL: RETURN_PATH,
        newUserCallbackURL: RETURN_PATH,
        errorCallbackURL: '/app?error=magic_link',
      }),
    },
    () => undefined,
  );
}

export function sendVerificationEmail(email: string): Promise<void> {
  return request(
    `${ACCOUNT_BASE}/send-verification-email`,
    { method: 'POST', body: JSON.stringify({ email, callbackURL: RETURN_PATH }) },
    () => undefined,
  );
}

/** `redirectTo` is where the mailed link lands; the server appends `?token=` or `?error=`. */
export function requestPasswordReset(email: string): Promise<void> {
  return request(
    `${ACCOUNT_BASE}/request-password-reset`,
    { method: 'POST', body: JSON.stringify({ email, redirectTo: '/app#reset-password' }) },
    () => undefined,
  );
}

export function resetPassword(token: string, newPassword: string): Promise<void> {
  return request(`${ACCOUNT_BASE}/reset-password`, { method: 'POST', body: JSON.stringify({ token, newPassword }) }, () => undefined);
}

/** Whether this university seeds the demo students (`SEED_DEMO`), from its public health. */
export async function demoAvailable(): Promise<boolean> {
  try {
    const response = await fetch('/health', { credentials: 'omit', cache: 'no-store' });
    const body = (await response.json().catch(() => null)) as { demo?: unknown } | null;
    return response.ok && body?.demo === true;
  } catch {
    return false;
  }
}

/** POST /v1/auth/login: the legacy password sign-in the demo students use. */
export async function demoSignIn(email: string, password: string): Promise<void> {
  const token = await request(`${ACCOUNT_BASE}/login`, { method: 'POST', body: JSON.stringify({ email, password }) }, (raw) => (raw as { token?: unknown } | null)?.token);
  if (typeof token !== 'string' || !token) throw new PortalError('The university server returned a sign-in this app cannot read.', 0, 'contract_mismatch');
  legacyToken = token;
}

/** A legacy token has no server-side session to end; forgetting it is the sign-out. */
export function demoSignOut(): void {
  legacyToken = null;
}

export function signOut(): Promise<void> {
  return request(`${ACCOUNT_BASE}/sign-out`, { method: 'POST', body: '{}' }, () => undefined);
}

/**
 * Admission state, validated against the shared schema before it reaches the UI: a drifted or
 * unrecognised shape fails closed here instead of rendering a plausible wrong admission state.
 */
export async function getMe(): Promise<AdmissionMe> {
  const raw = await request(`${API_BASE}/me`, { method: 'GET' }, (value) => value);
  const parsed = AdmissionMeSchema.safeParse(raw);
  if (!parsed.success) {
    log.error('portal_admission_contract_mismatch', { issues: parsed.error.issues.length });
    throw new PortalError('The university server returned an admission record this app cannot read.', 0, 'contract_mismatch');
  }
  return parsed.data;
}

export async function applyToProgramme(programmeId: string): Promise<Enrolment> {
  const raw = await request(
    `${API_BASE}/applications`,
    { method: 'POST', body: JSON.stringify({ schemaVersion: CONTRACT_VERSION, programmeId }) },
    (value) => value,
  );
  const parsed = EnrolmentSchema.safeParse(raw);
  if (!parsed.success) {
    log.error('portal_enrolment_contract_mismatch', { issues: parsed.error.issues.length });
    throw new PortalError('The university server returned an application record this app cannot read.', 0, 'contract_mismatch');
  }
  return parsed.data;
}

/** Programme visibility is admission-gated, so this rejects for applicants and rejected students. */
/**
 * Programme identity for an applicant. `/v1/programme` (the full manifest) is deliberately
 * gated behind approval, so this is the only listing an unapproved verified account can read.
 */
export async function listProgrammes(): Promise<ProgrammeSummary[]> {
  const raw = await request<unknown>(`${API_BASE}/programmes`, { method: 'GET' }, (value) => value);
  const parsed = ProgrammeCatalogueSchema.safeParse(raw);
  if (!parsed.success) {
    log.error('portal_programme_catalogue_mismatch', { issues: parsed.error.issues.length });
    throw new PortalError('The university server returned programme details this app cannot read.', 0, 'contract_mismatch');
  }
  return parsed.data.programmes;
}

export async function getProgramme(): Promise<Programme> {
  const raw = await request(`${API_BASE}/programme`, { method: 'GET' }, (value) => (value as { programme?: unknown })?.programme);
  const parsed = ProgrammeSchema.safeParse(raw);
  if (!parsed.success) {
    log.error('portal_programme_contract_mismatch', { issues: parsed.error.issues.length });
    throw new PortalError('The university server returned programme details this app cannot read.', 0, 'contract_mismatch');
  }
  return parsed.data;
}
const isSessionStatus = (value: unknown): value is StudentSessionStatus => {
  const v = value as Partial<StudentSessionStatus> | null;
  return typeof v?.id === 'string' && typeof v.state === 'string' && Array.isArray(v.steps);
};

function sessionStatus(raw: unknown): StudentSessionStatus {
  if (!isSessionStatus(raw)) {
    log.error('portal_session_contract_mismatch', {});
    throw new PortalError('The university server returned a workspace status this app cannot read.', 0, 'contract_mismatch');
  }
  return raw;
}

/** POST /v1/session: the live workspace, or a new lease whose spawn starts on the server. */
export function startWorkspace(): Promise<StudentSessionStatus> {
  return request(`${API_BASE}/session`, { method: 'POST', body: '{}' }, sessionStatus);
}

/** GET /v1/session: the live workspace, else how the last one ended; null when there never was one. */
export async function getWorkspace(): Promise<StudentSessionStatus | null> {
  try {
    return await request(`${API_BASE}/session`, { method: 'GET' }, sessionStatus);
  } catch (error) {
    if (error instanceof PortalError && error.status === 404 && error.code === 'no_session') return null;
    throw error;
  }
}

/** DELETE /v1/session: the university saves the notes one last time, then deletes the machine. */
export function endWorkspace(): Promise<void> {
  return request(`${API_BASE}/session`, { method: 'DELETE' }, () => undefined);
}

/**
 * The workspace's public health, read from this browser: proof the edge answers for this
 * student, not only for the university. Cross-origin and without credentials; the engine
 * allows any origin to read this one body because it carries nothing private.
 */
export async function probeWorkspaceHealth(url: string): Promise<{ status: number; body: unknown } | null> {
  try {
    const response = await fetch(`${url}/api/health`, { credentials: 'omit', cache: 'no-store', signal: AbortSignal.timeout(8_000) });
    return { status: response.status, body: await response.json().catch(() => null) };
  } catch {
    return null;
  }
}


/**
 * Runs a mail-sending call and folds a delivery failure into the result, so the caller can still
 * show the check-your-email screen (the account may exist) but say the mail did not go out. The
 * outcome never depends on whether the address was registered beyond what the mail path did.
 */
export type MailOutcome = 'sent' | 'failed';

export async function mailOutcome(send: () => Promise<void>): Promise<MailOutcome> {
  try {
    await send();
    return 'sent';
  } catch (error) {
    if (error instanceof PortalError && error.code === MAIL_SEND_FAILED) return 'failed';
    throw error;
  }
}
