import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import type {
  AdmissionMe,
  AuthSessionSummary,
  DevicePollResult,
  DeviceProfile,
  DeviceSignInStart,
  EngineLoginResponse,
  EngineMe,
  EnrolmentStatus,
  LimitedAccessReason,
  LoginResponse,
  SessionAccess,
} from '@sef/shared';
import { log } from '../config';
import type { CredentialStore } from '../credentials/store';
import type { SettingsStore } from '../settings/store';
import { uniFetch, UniHttpError, UniUnreachableError } from '../uni/client';
import { pollDeviceGrant, requestDeviceGrant } from '../uni/device';
import { fetchEntitlement, verifyEntitlement, verifyEntitlementOffline } from '../uni/entitlement';
import { trustedUniKey } from '../uni/trust';
import { deviceId as defaultDeviceId } from './device';
import type { ProfileRegistry } from './registry';
import { SeatOwner } from './seat-owner';
import type { AuthSessions } from './sessions';

export class AuthError extends Error {
  constructor(
    readonly code:
      | 'invalid_credentials'
      | 'offline_unknown_profile'
      | 'account_disabled'
      | 'no_device_flow'
      | 'offline_locked'
      | 'staff_use_portal'
      | 'seat_not_yours',
    message: string,
  ) {
    super(message);
  }
}

interface PendingDeviceFlow {
  deviceCode: string;
  intervalSeconds: number;
  expiresAtMs: number;
  /** SHA-256 of the key handed to the client that started the grant. */
  flowKeyHash: Buffer;
  /** Started by a caller at the device itself, so a keyless poll there may pick it up. */
  allowKeyless: boolean;
}

export interface DeviceStartOptions {
  /** The starting caller is the device itself (not remote): keyless polls may find this flow. */
  allowKeyless?: boolean;
}

export interface DevicePollOptions {
  flowKey?: string;
  /** A remote caller must present the starting client's key; at the device itself it stays optional. */
  requireFlowKey?: boolean;
  deviceLabel?: string;
}

export interface AuthServiceOptions {
  /** Most device grants held at once; the oldest is dropped first. */
  maxPendingFlows?: number;
  now?: () => number;
  /** Who a hosted seat belongs to. Defaults to a local engine: no owner, no check. */
  seat?: SeatOwner;
}

/** Pending grants outlive the uni's expiry by at most this, however long the uni says. */
const MAX_FLOW_TTL_MS = 30 * 60_000;
const DEFAULT_MAX_PENDING_FLOWS = 32;
/** An expired grant lingers this long so the starting client's next poll still reads `expired`. */
const EXPIRED_GRACE_MS = 2 * 60_000;

const sha256 = (value: string) => createHash('sha256').update(value).digest();

const FULL: SessionAccess = { mode: 'full' };

/**
 * The reason a sign-in is read/export-only, or null for a full session. An enrolment
 * state the uni itself reported outranks local expiry: signing back in online cannot
 * restore a suspended enrolment, so that is the story the student needs to hear.
 */
const limitedReason = (profile: DeviceProfile, entitlementExpired: boolean): LimitedAccessReason | null => {
  if (profile.admission === 'suspended') return 'admission_suspended';
  if (profile.admission === 'withdrawn') return 'admission_withdrawn';
  return entitlementExpired ? 'entitlement_expired' : null;
};

const seatNotYours = () => new AuthError('seat_not_yours', 'This seat belongs to another student.');

const accessFor = (reason: LimitedAccessReason | null): SessionAccess => (reason ? { mode: 'limited', reason } : FULL);

/**
 * Sign-in for the desktop app.
 *  - Password: the uni is the source of truth; we cache a verifier for later offline use.
 *  - Device code (RFC 8628): first-party sign-in for enrolment accounts — the student
 *    confirms a user code on the uni page; approval yields a session plus, for approved
 *    students, a signed offline entitlement bound to this device.
 *  - Offline: the cached verifier (password profiles) or the verified entitlement
 *    (device profiles) unlocks local study. A guessed or tampered credential cannot.
 */
export class AuthService {
  /**
   * In-flight device grants, keyed by the hex SHA-256 of their flow key, in start order.
   * One per starting client, so concurrent visitors cannot cancel each other; bounded by
   * count (oldest out) and by each grant's expiry.
   */
  private readonly pendingFlows = new Map<string, PendingDeviceFlow>();
  private readonly maxPendingFlows: number;
  private readonly now: () => number;
  private readonly seat: SeatOwner;

  constructor(
    private readonly settings: SettingsStore,
    private readonly registry: ProfileRegistry,
    private readonly sessions: AuthSessions,
    private readonly credentials: CredentialStore,
    private readonly deviceId: () => Promise<string> = () => defaultDeviceId(),
    options: AuthServiceOptions = {},
  ) {
    this.maxPendingFlows = Math.max(1, options.maxPendingFlows ?? DEFAULT_MAX_PENDING_FLOWS);
    this.now = options.now ?? Date.now;
    this.seat = options.seat ?? new SeatOwner({ hosted: false });
  }

  /**
   * Refuses an account that does not own this hosted seat, before any profile, verifier or
   * credential of theirs is written. `verified`: the uni just vouched for the id, so an
   * unpinned seat pins it. Offline paths never pin; on an unpinned seat they stay closed.
   */
  private async admitToSeat(accountId: string, verified: boolean): Promise<void> {
    if (verified ? await this.seat.claim(accountId) : await this.seat.allows(accountId)) return;
    const state = await this.seat.load();
    log.warn('seat_signin_refused', { accountId, seat: state.kind });
    if (state.kind === 'unpinned') {
      throw new AuthError('offline_unknown_profile', 'This seat has no owner yet. Sign in once while the university is reachable.');
    }
    throw seatNotYours();
  }

  /** Grants currently held — for tests and diagnostics. */
  get pendingDeviceFlows(): number {
    return this.pendingFlows.size;
  }

  async login(email: string, password: string, deviceLabel?: string): Promise<EngineLoginResponse> {
    const { uniServerUrl } = await this.settings.get();
    try {
      const res = await uniFetch<LoginResponse>(uniServerUrl, '/v1/auth/login', {
        method: 'POST',
        body: { email, password },
        timeoutMs: 5000,
      });
      if (res.account.role === 'admin') {
        // Staff are not engine users: the registrar portal at the uni's /admin is their surface.
        log.info('staff_login_refused', { accountId: res.account.id });
        throw new AuthError('staff_use_portal', 'Staff accounts sign in at the university’s /admin portal, not in the study app.');
      }
      await this.admitToSeat(res.account.id, true);
      const profile = await this.registry.recordOnline(res.account, password, res.token, res.expiresAt);
      return { role: 'student', profile, mode: 'online', access: FULL, token: await this.sessions.create(profile.id, 'online', FULL, deviceLabel) };
    } catch (error) {
      if (error instanceof UniHttpError && error.status === 401) {
        throw new AuthError('invalid_credentials', 'That email and password do not match.');
      }
      if (!(error instanceof UniUnreachableError)) throw error;
      log.warn('uni_unreachable_trying_offline_login', { email });
    }

    const profile = await this.registry.verifyOffline(email, password);
    if (!profile) {
      throw new AuthError(
        'offline_unknown_profile',
        'The university server is unreachable and this device has no offline sign-in for that account. Sign in once while online.',
      );
    }
    await this.admitToSeat(profile.id, false);
    log.info('offline_login', { profileId: profile.id });
    return { role: 'student', profile, mode: 'offline', access: FULL, token: await this.sessions.create(profile.id, 'offline', FULL, deviceLabel) };
  }

  /** Begins an RFC 8628 device grant with the uni. Online only — errors propagate as unreachable. */
  async startDeviceSignIn(options: DeviceStartOptions = {}): Promise<DeviceSignInStart> {
    const { uniServerUrl } = await this.settings.get();
    const grant = await requestDeviceGrant(uniServerUrl);
    const flowKey = randomBytes(24).toString('base64url');
    const flowKeyHash = sha256(flowKey);
    const now = this.now();
    this.evictExpiredFlows(now);
    this.pendingFlows.set(flowKeyHash.toString('hex'), {
      deviceCode: grant.deviceCode,
      intervalSeconds: grant.intervalSeconds,
      expiresAtMs: now + Math.min(grant.expiresInSeconds * 1000, MAX_FLOW_TTL_MS),
      flowKeyHash,
      allowKeyless: options.allowKeyless === true,
    });
    for (const key of this.pendingFlows.keys()) {
      if (this.pendingFlows.size <= this.maxPendingFlows) break;
      this.pendingFlows.delete(key);
    }
    log.info('device_signin_started', { expiresInSeconds: grant.expiresInSeconds, pending: this.pendingFlows.size });
    return {
      userCode: grant.userCode,
      verificationUri: grant.verificationUri,
      verificationUriComplete: grant.verificationUriComplete,
      expiresInSeconds: grant.expiresInSeconds,
      intervalSeconds: grant.intervalSeconds,
      flowKey,
    };
  }

  /**
   * One poll of the pending device grant. The UI drives the interval; `slow_down`
   * from the uni comes back as an increased `intervalSeconds` hint.
   */
  async pollDeviceSignIn(options: DevicePollOptions = {}): Promise<DevicePollResult> {
    const found = this.findFlow(options);
    // A wrong key is indistinguishable from no flow, so a stranger polling learns nothing.
    if (!found) throw new AuthError('no_device_flow', 'No device sign-in is in progress.');
    const [id, pending] = found;
    const done = () => this.pendingFlows.delete(id);
    if (this.now() > pending.expiresAtMs) {
      done();
      return { status: 'expired' };
    }
    const { uniServerUrl } = await this.settings.get();
    const poll = await pollDeviceGrant(uniServerUrl, pending.deviceCode);
    switch (poll.status) {
      case 'pending':
        if (poll.slowDown) pending.intervalSeconds += 5;
        return { status: 'pending', intervalSeconds: pending.intervalSeconds };
      case 'denied':
        done();
        return { status: 'denied' };
      case 'expired':
        done();
        return { status: 'expired' };
    }
    done();

    const sessionToken = poll.sessionToken;
    const sessionExpiresAt = new Date(Date.now() + poll.expiresInSeconds * 1000).toISOString();
    const me = await uniFetch<AdmissionMe>(uniServerUrl, '/v1/me', { token: sessionToken });
    await this.admitToSeat(me.user.id, true);
    const admission: NonNullable<DeviceProfile['admission']> = me.enrolment?.status ?? 'none';
    const cohortId = me.enrolment?.cohortId ?? '';
    let profile = await this.registry.recordDeviceSignIn(me.user, sessionToken, sessionExpiresAt, admission, cohortId, me.enrolment?.programmeId);
    if (admission === 'approved') {
      await this.refreshEntitlement(uniServerUrl, sessionToken, profile.id);
      profile = (await this.registry.get(profile.id)) ?? profile;
    } else {
      log.info('device_signin_unapproved', { profileId: profile.id, admission });
    }
    // Suspended or withdrawn enrolments once had files here: admit them read/export-only
    // rather than locking the student out of their own vault. Pending/rejected never had
    // files, so their full session stays confined to /api/auth/* by the approved gate.
    const access = accessFor(limitedReason(profile, false));
    if (access.mode === 'limited') log.info('device_signin_limited', { profileId: profile.id, reason: access.reason });
    const token = await this.sessions.create(profile.id, 'online', access, options.deviceLabel);
    return { status: 'approved', role: 'student', profile, mode: 'online', access, token };
  }

  /**
   * The flow a poll names. With a key: the grant whose key hash matches (confirmed with a
   * timing-safe compare). Without one, only when the caller is the device itself: the most
   * recent grant that was also started there.
   */
  private findFlow(options: DevicePollOptions): [string, PendingDeviceFlow] | null {
    if (options.flowKey !== undefined) {
      const hash = sha256(options.flowKey);
      const id = hash.toString('hex');
      const pending = this.pendingFlows.get(id);
      return pending && timingSafeEqual(hash, pending.flowKeyHash) ? [id, pending] : null;
    }
    if (options.requireFlowKey) return null;
    const keyless = [...this.pendingFlows].filter(([, flow]) => flow.allowKeyless);
    return keyless.at(-1) ?? null;
  }

  /** TTL eviction: drops grants a grace period past their expiry. */
  private evictExpiredFlows(now: number): void {
    for (const [id, flow] of this.pendingFlows) if (now > flow.expiresAtMs + EXPIRED_GRACE_MS) this.pendingFlows.delete(id);
  }

  /** Fetches and stores a fresh device-bound entitlement; failure leaves the profile online-only. */
  private async refreshEntitlement(uniUrl: string, sessionToken: string, profileId: string): Promise<void> {
    try {
      const dev = await this.deviceId();
      const entitlement = await fetchEntitlement(uniUrl, sessionToken, dev);
      // First sign-in is the trust-on-first-use moment: pin the uni key before
      // verifying, same rule ContentSync applies to course packages.
      const key = await trustedUniKey(uniUrl);
      const verified = verifyEntitlement(entitlement.token, key, { profileId, deviceId: dev });
      if (!verified.ok) {
        log.warn('entitlement_refused', { profileId, reason: verified.reason });
        return;
      }
      await this.registry.recordEntitlement(profileId, entitlement.token);
      log.info('entitlement_stored', { profileId, expiresAt: entitlement.expiresAt });
    } catch (error) {
      log.warn('entitlement_unavailable', { profileId, error: (error as Error).message });
    }
  }

  /**
   * Offline unlock for a profile created via device sign-in: requires a stored
   * entitlement that verifies locally (signature, audience, student, device).
   * An expired entitlement — or a profile whose last reported enrolment is suspended
   * or withdrawn — still unlocks private read/export as a limited session: the
   * student's own files stay theirs. Nothing network-facing can run offline anyway.
   */
  async unlockOffline(profileId: string, deviceLabel?: string): Promise<EngineLoginResponse | null> {
    const profile = await this.registry.get(profileId);
    if (!profile) return null;
    await this.admitToSeat(profile.id, false);
    const token = await this.registry.entitlement(profileId);
    if (!token) {
      throw new AuthError('offline_locked', 'This device has no offline entitlement for that profile. Sign in while online first.');
    }
    const verified = await verifyEntitlementOffline(token, { profileId, deviceId: await this.deviceId() });
    if (!verified.ok && verified.reason !== 'expired') {
      log.warn('offline_unlock_rejected', { profileId, reason: verified.reason });
      throw new AuthError('offline_locked', 'The offline credential on this device is not valid. Sign in while online.');
    }
    if (!verified.ok) log.info('entitlement_expired_offline_read', { profileId });
    else log.info('offline_unlock', { profileId });
    const access = accessFor(limitedReason(profile, !verified.ok));
    if (access.mode === 'limited') log.info('offline_unlock_limited', { profileId, reason: access.reason });
    return { role: 'student', profile, mode: 'offline', access, token: await this.sessions.create(profile.id, 'offline', access, deviceLabel) };
  }

  async resolve(token: string): Promise<EngineMe | null> {
    const session = await this.sessions.resolve(token);
    if (!session || !(await this.seat.allowsSession(session.profileId))) return null;
    const profile = await this.registry.get(session.profileId);
    return profile ? { profile, mode: session.mode, access: session.access ?? FULL } : null;
  }

  /**
   * Signs the profile out everywhere: engine session(s), the uni session (best effort),
   * and every stored credential. Nothing in-flight is left pointing at the profile.
   */
  async logout(token: string): Promise<void> {
    const session = await this.sessions.resolve(token);
    await this.sessions.revoke(token);
    if (!session) return;
    const { uniServerUrl } = await this.settings.get();
    const uniToken = await this.registry.uniToken(session.profileId);
    if (uniToken) {
      try {
        await uniFetch(uniServerUrl, '/v1/auth/sign-out', { method: 'POST', token: uniToken, timeoutMs: 4000 });
      } catch (error) {
        if (!(error instanceof UniUnreachableError)) log.warn('uni_signout_failed', { error: (error as Error).message });
      }
    }
    await this.sessions.revokeForProfile(session.profileId);
    await this.registry.forgetCredentials(session.profileId);
    log.info('logout', { profileId: session.profileId });
  }

  /** The profile's own sessions only; `currentToken` marks the one asking. */
  listSessions(profileId: string, currentToken: string): Promise<AuthSessionSummary[]> {
    return this.sessions.list(profileId, currentToken);
  }

  /** Revokes one of the profile's sessions; another profile's id is reported as not found. */
  async revokeSession(profileId: string, sessionId: string): Promise<boolean> {
    const revoked = await this.sessions.revokeById(profileId, sessionId);
    if (revoked) log.info('session_revoked', { profileId, sessionId });
    return revoked;
  }

  profiles(): Promise<DeviceProfile[]> {
    return this.registry.list();
  }

  /** Credential-store kind, surfaced for diagnostics — 'os' persists, 'memory' does not. */
  credentialBackend(): 'os' | 'memory' {
    return this.credentials.kind;
  }
}
