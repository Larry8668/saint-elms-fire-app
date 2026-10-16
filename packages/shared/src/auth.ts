import { z } from 'zod';
import type { EnrolmentStatus } from './identity';

export const ROLES = ['student', 'admin'] as const;
export type Role = (typeof ROLES)[number];

/** An account as anyone outside the uni server sees it: never includes the password hash. */
export interface Account {
  id: string;
  email: string;
  name: string;
  role: Role;
  cohortId?: string;
  /** Human description of where a student is in the programme, e.g. "End of Semester 3". */
  stage?: string;
  /** Short line about how this student learns, shown on the profile picker. */
  persona?: string;
  createdAt: string;
  disabled?: boolean;
}

/** Claims inside a uni-issued token. Signed with the same ed25519 key that signs course packages. */
export interface TokenClaims {
  iss: string;
  sub: string;
  role: Role;
  name: string;
  email: string;
  cohortId?: string;
  stage?: string;
  /** Audience restriction. Engine-bound credentials carry ENGINE_AUDIENCE. */
  aud?: string;
  /** Device id the credential was issued to, for offline entitlement checks. */
  dev?: string;
  iat: number;
  exp: number;
}

export const TOKEN_PREFIX = 'sef1';
/** Audience claim on uni-signed offline entitlements; a device credential is never a staff credential. */
export const ENGINE_AUDIENCE = 'sef-engine';

/** Emails are compared and stored case-insensitively, so one mailbox can never hold two accounts. */
export const normalizeEmail = (email: string) => email.trim().toLowerCase();

export const LoginRequestSchema = z.object({
  email: z.string().trim().toLowerCase().email(),
  password: z.string().min(1).max(200),
});
export type LoginRequest = z.infer<typeof LoginRequestSchema>;

export interface LoginResponse {
  token: string;
  expiresAt: string;
  account: Account;
}

/** Reads token claims without verifying them. Fine for display; never for access decisions. */
export function peekTokenClaims(token: string): TokenClaims | null {
  const [prefix, payload] = token.split('.');
  if (prefix !== TOKEN_PREFIX || !payload) return null;
  try {
    const json = atob(payload.replace(/-/g, '+').replace(/_/g, '/'));
    return JSON.parse(new TextDecoder().decode(Uint8Array.from(json, (c) => c.charCodeAt(0)))) as TokenClaims;
  } catch {
    return null;
  }
}

// ---- Engine-side identity (a student profile on one device) ----

/** A student profile stored on this device. The engine works offline from these. */
export interface DeviceProfile {
  id: string;
  name: string;
  email: string;
  cohortId: string;
  /** Programme the enrolment is against, learned at device sign-in. Absent on legacy password profiles. */
  programmeId?: string;
  stage?: string;
  persona?: string;
  lastOnlineAt?: string;
  /** True once the student has signed in online here, so offline sign-in is possible. */
  offlineReady: boolean;
  /**
   * Admission state from the university, set on profiles created through device sign-in.
   * Undefined on legacy/password profiles, which predate admission gating and stay usable.
   */
  admission?: EnrolmentStatus | 'none';
}

export type SessionMode = 'online' | 'offline';

/** Students only: staff accounts sign in at the uni-hosted /admin portal, never through the engine. */
export interface EngineLoginResponse {
  role: 'student';
  token: string;
  profile: DeviceProfile;
  mode: SessionMode;
}

export interface EngineMe {
  profile: DeviceProfile;
  mode: SessionMode;
}

// ---- Device sign-in (RFC 8628 over the uni's better-auth device endpoints) ----

/** What the engine hands the UI after asking the uni for a device grant. */
export interface DeviceSignInStart {
  userCode: string;
  verificationUri: string;
  /** Verification page with the code pre-filled; open this when there is only one device. */
  verificationUriComplete?: string;
  expiresInSeconds: number;
  intervalSeconds: number;
}

export type DevicePollResult =
  | { status: 'pending'; intervalSeconds?: number }
  | ({ status: 'approved' } & Extract<EngineLoginResponse, { role: 'student' }>)
  | { status: 'denied' }
  | { status: 'expired' };

// ---- Offline entitlement (uni-signed, engine-verified) ----

export const EntitlementRequestSchema = z.object({
  deviceId: z.string().min(1).max(128),
});
export type EntitlementRequest = z.infer<typeof EntitlementRequestSchema>;

export interface EntitlementResponse {
  token: string;
  expiresAt: string;
  cohortId: string;
}

// ---- Admin API (uni server) ----

export interface CohortSummary {
  id: string;
  name: string;
  courses: string[];
  students: number;
}

export interface AdminCourse {
  id: string;
  title: string;
  code?: string;
  semesterNumber: number;
  subjectId: string;
  lessonCount: number;
  version: string;
  support: boolean;
  /** Cohorts this course is released to. */
  cohorts: string[];
}

export interface AdminLesson {
  id: string;
  title: string;
  moduleName: string;
  order: number;
  concepts: string[];
  summary?: string;
}

/** Latest package a student's device pulled for one course. */
export interface DispersalRecord {
  accountId: string;
  cohortId: string;
  courseId: string;
  version: string;
  at: string;
}

export interface AuditEntry {
  at: string;
  actor: string;
  action: string;
  detail: string;
}

export interface AdminOverview {
  issuer: string;
  programmeName: string;
  students: number;
  cohorts: number;
  courses: number;
  releasedCourseSlots: number;
  syncsLast7Days: number;
  outdatedInstalls: number;
  sharesLast7Days: number;
  recentAudit: AuditEntry[];
}

export interface AdminShare {
  id: string;
  cohortId: string;
  fromStudent: string;
  title: string;
  markdown: string;
  createdAt: string;
}

export const NewAccountSchema = z.object({
  email: z.string().trim().toLowerCase().email(),
  name: z.string().trim().min(1).max(80),
  role: z.enum(ROLES).default('student'),
  cohortId: z.string().optional(),
  stage: z.string().max(80).optional(),
  persona: z.string().max(200).optional(),
  password: z.string().min(8).max(200),
});
export type NewAccount = z.infer<typeof NewAccountSchema>;

export const AccountPatchSchema = z.object({
  name: z.string().trim().min(1).max(80).optional(),
  cohortId: z.string().optional(),
  stage: z.string().max(80).optional(),
  disabled: z.boolean().optional(),
  password: z.string().min(8).max(200).optional(),
});
export type AccountPatch = z.infer<typeof AccountPatchSchema>;
