import type { DeviceProfile, EngineLoginResponse, EngineMe, LoginResponse } from '@sef/shared';
import { log } from '../config';
import type { SettingsStore } from '../settings/store';
import { uniFetch, UniHttpError, UniUnreachableError } from '../uni/client';
import type { ProfileRegistry } from './registry';
import type { AuthSessions } from './sessions';

export class AuthError extends Error {
  constructor(
    readonly code: 'invalid_credentials' | 'offline_unknown_profile' | 'account_disabled',
    message: string,
  ) {
    super(message);
  }
}

/**
 * Sign-in for the desktop app.
 *  - Uni reachable: the uni is the source of truth; we cache a verifier for later offline use.
 *  - Uni unreachable: fall back to the cached verifier, so a student who signed in once keeps working.
 * Wrong credentials from a reachable uni are final: we never fall back to a stale local password.
 */
export class AuthService {
  constructor(
    private readonly settings: SettingsStore,
    private readonly registry: ProfileRegistry,
    private readonly sessions: AuthSessions,
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
        log.info('admin_login_relayed', { accountId: res.account.id });
        return { role: 'admin', uniToken: res.token, uniUrl: uniServerUrl, account: res.account };
      }
      const profile = await this.registry.recordOnline(res.account, password, res.token, res.expiresAt);
      return { role: 'student', profile, mode: 'online', token: await this.sessions.create(profile.id, 'online') };
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
    return { role: 'student', profile, mode: 'offline', token: await this.sessions.create(profile.id, 'offline') };
  }

  async resolve(token: string): Promise<EngineMe | null> {
    const session = await this.sessions.resolve(token);
    if (!session) return null;
    const profile = await this.registry.get(session.profileId);
    return profile ? { profile, mode: session.mode } : null;
  }

  logout(token: string): Promise<void> {
    return this.sessions.revoke(token);
  }

  profiles(): Promise<DeviceProfile[]> {
    return this.registry.list();
  }
}
