import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import type {
  AdmissionMe,
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
import type { AuthSessions } from './sessions';

export class AuthError extends Error {
  constructor(
    readonly code: 'invalid_credentials' | 'offline_unknown_profile' | 'account_disabled' | 'no_device_flow' | 'offline_locked' | 'staff_use_portal',
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
}

export interface DevicePollOptions {
  flowKey?: string;
  /** A hosted engine refuses polls without the starting client's key; loopback keeps it optional. */
  requireFlowKey?: boolean;
}

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
  private pendingFlow: PendingDeviceFlow | null = null;

  constructor(
    private readonly settings: SettingsStore,
    private readonly registry: ProfileRegistry,
    private readonly sessions: AuthSessions,
    private readonly credentials: CredentialStore,
    private readonly deviceId: () => Promise<string> = () => defaultDeviceId(),
  ) {}

  async login(email: string, password: string): Promise<EngineLoginResponse> {
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
      const profile = await this.registry.recordOnline(res.account, password, res.token, res.expiresAt);
      return { role: 'student', profile, mode: 'online', access: FULL, token: await this.sessions.create(profile.id, 'online') };
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
    log.info('offline_login', { profileId: profile.id });
    return { role: 'student', profile, mode: 'offline', access: FULL, token: await this.sessions.create(profile.id, 'offline') };
  }

  /** Begins an RFC 8628 device grant with the uni. Online only — errors propagate as unreachable. */
  async startDeviceSignIn(): Promise<DeviceSignInStart> {
    const { uniServerUrl } = await this.settings.get();
    const grant = await requestDeviceGrant(uniServerUrl);
    const flowKey = randomBytes(24).toString('base64url');
    this.pendingFlow = {
      deviceCode: grant.deviceCode,
      intervalSeconds: grant.intervalSeconds,
      expiresAtMs: Date.now() + grant.expiresInSeconds * 1000,
      flowKeyHash: sha256(flowKey),
    };
    log.info('device_signin_started', { expiresInSeconds: grant.expiresInSeconds });
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
    const pending = this.pendingFlow;
    if (!pending) throw new AuthError('no_device_flow', 'No device sign-in is in progress.');
    // A wrong key is indistinguishable from no flow, so a stranger polling learns nothing.
    if (options.flowKey !== undefined ? !timingSafeEqual(sha256(options.flowKey), pending.flowKeyHash) : options.requireFlowKey) {
      throw new AuthError('no_device_flow', 'No device sign-in is in progress.');
    }
    if (Date.now() > pending.expiresAtMs) {
      this.pendingFlow = null;
      return { status: 'expired' };
    }
    const { uniServerUrl } = await this.settings.get();
    const poll = await pollDeviceGrant(uniServerUrl, pending.deviceCode);
    switch (poll.status) {
      case 'pending':
        if (poll.slowDown) pending.intervalSeconds += 5;
        return { status: 'pending', intervalSeconds: pending.intervalSeconds };
      case 'denied':
        this.pendingFlow = null;
        return { status: 'denied' };
      case 'expired':
        this.pendingFlow = null;
        return { status: 'expired' };
    }
    this.pendingFlow = null;

    const sessionToken = poll.sessionToken;
    const sessionExpiresAt = new Date(Date.now() + poll.expiresInSeconds * 1000).toISOString();
    const me = await uniFetch<AdmissionMe>(uniServerUrl, '/v1/me', { token: sessionToken });
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
    const token = await this.sessions.create(profile.id, 'online', access);
    return { status: 'approved', role: 'student', profile, mode: 'online', access, token };
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
  async unlockOffline(profileId: string): Promise<EngineLoginResponse | null> {
    const profile = await this.registry.get(profileId);
    if (!profile) return null;
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
    return { role: 'student', profile, mode: 'offline', access, token: await this.sessions.create(profile.id, 'offline', access) };
  }

  async resolve(token: string): Promise<EngineMe | null> {
    const session = await this.sessions.resolve(token);
    if (!session) return null;
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

  profiles(): Promise<DeviceProfile[]> {
    return this.registry.list();
  }

  /** Credential-store kind, surfaced for diagnostics — 'os' persists, 'memory' does not. */
  credentialBackend(): 'os' | 'memory' {
    return this.credentials.kind;
  }
}
