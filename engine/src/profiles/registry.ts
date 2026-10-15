import { normalizeEmail, type Account, type DeviceProfile } from '@sef/shared';
import { hashPassword, verifyPassword } from '@sef/shared/node';
import { config, log } from '../config';
import type { CredentialStore } from '../credentials/store';
import { MemoryCredentialStore } from '../credentials/store';
import { readJson, writeJson } from '../lib/fs';

/** Credential-store keys are derived from the profile id; values never touch profiles.json. */
const uniSessionKey = (profileId: string) => `uni-session:${profileId}`;
const entitlementKey = (profileId: string) => `entitlement:${profileId}`;

/** What the device remembers about a student. Secrets live in the credential store, not here. */
interface StoredProfile extends Omit<DeviceProfile, 'offlineReady'> {
  /** scrypt hash of the password, set at the last successful online sign-in (or by the demo seeder). */
  verifier?: string;
  /** Expiry of the uni credential held in the credential store. Metadata, not a secret. */
  uniTokenExpiresAt?: string;
  /** True while a uni-signed offline entitlement sits in the credential store. */
  hasEntitlement?: boolean;
  /** Pre-PR-07 field: migrated to the credential store on first load, then removed. */
  uniToken?: string;
}

const toPublic = ({ verifier: _v, uniToken: _t, uniTokenExpiresAt: _e, hasEntitlement, ...rest }: StoredProfile): DeviceProfile => ({
  ...rest,
  offlineReady: Boolean(_v || hasEntitlement),
});

/** Student profiles known to this device. Enables offline sign-in after one online sign-in. */
export class ProfileRegistry {
  private profiles: Map<string, StoredProfile> | null = null;

  constructor(private readonly credentials: CredentialStore = new MemoryCredentialStore()) {}

  private async load(): Promise<Map<string, StoredProfile>> {
    if (!this.profiles) {
      const rows = await readJson<StoredProfile[]>(config.paths.profiles, []);
      this.profiles = new Map(rows.map((p) => [p.id, p]));
      // Migrate plaintext uni tokens written by older versions into the credential store.
      let migrated = false;
      for (const row of rows) {
        if (!row.uniToken) continue;
        await this.credentials.set(uniSessionKey(row.id), row.uniToken);
        delete row.uniToken;
        migrated = true;
      }
      if (migrated) await this.persist();
    }
    return this.profiles;
  }

  private async persist(): Promise<void> {
    await writeJson(config.paths.profiles, [...(await this.load()).values()]);
  }

  async list(): Promise<DeviceProfile[]> {
    return [...(await this.load()).values()].map(toPublic).sort((a, b) => a.name.localeCompare(b.name));
  }

  async get(id: string): Promise<DeviceProfile | undefined> {
    const p = (await this.load()).get(id);
    return p ? toPublic(p) : undefined;
  }

  /** The live uni credential for this profile — a better-auth session or a legacy sef1 token. */
  async uniToken(id: string): Promise<string | undefined> {
    const p = (await this.load()).get(id);
    if (!p || (p.uniTokenExpiresAt && Date.parse(p.uniTokenExpiresAt) < Date.now())) return undefined;
    return (await this.credentials.get(uniSessionKey(id))) ?? undefined;
  }

  /** The offline entitlement for this profile, used for unlock and local verification. */
  async entitlement(id: string): Promise<string | null> {
    return this.credentials.get(entitlementKey(id));
  }

  /** Records a successful online sign-in: refreshes identity, offline verifier and uni credential. */
  async recordOnline(account: Account, password: string, uniToken: string, expiresAt: string): Promise<DeviceProfile> {
    const profiles = await this.load();
    const existing = profiles.get(account.id);
    await this.credentials.set(uniSessionKey(account.id), uniToken);
    const next: StoredProfile = {
      id: account.id,
      name: account.name,
      email: account.email,
      cohortId: account.cohortId ?? existing?.cohortId ?? '',
      stage: account.stage,
      persona: account.persona,
      lastOnlineAt: new Date().toISOString(),
      verifier: await hashPassword(password),
      uniTokenExpiresAt: expiresAt,
      admission: existing?.admission,
      hasEntitlement: existing?.hasEntitlement,
    };
    profiles.set(account.id, next);
    await this.persist();
    log.info('profile_online_signin', { profileId: account.id, cohortId: next.cohortId, created: !existing });
    return toPublic(next);
  }

  /**
   * Records a device-authorization sign-in. There is no password to verify offline —
   * offline re-entry is gated by the stored entitlement instead. Keeps an existing
   * verifier if this profile also signs in by password.
   */
  async recordDeviceSignIn(
    user: { id: string; name: string; email: string },
    sessionToken: string,
    sessionExpiresAt: string,
    admission: NonNullable<DeviceProfile['admission']>,
    cohortId: string,
  ): Promise<DeviceProfile> {
    const profiles = await this.load();
    const existing = profiles.get(user.id);
    await this.credentials.set(uniSessionKey(user.id), sessionToken);
    const next: StoredProfile = {
      id: user.id,
      name: user.name,
      email: user.email,
      cohortId: cohortId || existing?.cohortId || '',
      stage: existing?.stage,
      persona: existing?.persona,
      lastOnlineAt: new Date().toISOString(),
      verifier: existing?.verifier,
      uniTokenExpiresAt: sessionExpiresAt,
      admission,
      hasEntitlement: existing?.hasEntitlement,
    };
    profiles.set(user.id, next);
    await this.persist();
    log.info('profile_device_signin', { profileId: user.id, admission, created: !existing });
    return toPublic(next);
  }

  /** Stores a fresh entitlement and marks the profile offline-capable. */
  async recordEntitlement(id: string, token: string): Promise<void> {
    const p = (await this.load()).get(id);
    if (!p) return;
    await this.credentials.set(entitlementKey(id), token);
    p.hasEntitlement = true;
    await this.persist();
  }

  /** Offline sign-in: only possible for profiles that have a verifier on this device. */
  async verifyOffline(email: string, password: string): Promise<DeviceProfile | null> {
    const wanted = normalizeEmail(email);
    const profile = [...(await this.load()).values()].find((p) => normalizeEmail(p.email) === wanted);
    if (!profile?.verifier) return null;
    return (await verifyPassword(password, profile.verifier)) ? toPublic(profile) : null;
  }

  /** Creates an offline-ready profile without a uni session (demo seeding). No-op if it exists. */
  async ensure(profile: Omit<DeviceProfile, 'offlineReady'>, password: string): Promise<boolean> {
    const profiles = await this.load();
    if (profiles.has(profile.id)) return false;
    profiles.set(profile.id, { ...profile, verifier: await hashPassword(password) });
    await this.persist();
    return true;
  }

  /** Drops every uni credential for this profile — called on sign-out and suspension. */
  async forgetCredentials(id: string): Promise<void> {
    await this.credentials.delete(uniSessionKey(id));
    await this.credentials.delete(entitlementKey(id));
    const p = (await this.load()).get(id);
    if (p) {
      delete p.uniTokenExpiresAt;
      p.hasEntitlement = false;
      await this.persist();
    }
  }

  async forgetUniToken(id: string): Promise<void> {
    await this.credentials.delete(uniSessionKey(id));
    const p = (await this.load()).get(id);
    if (!p) return;
    delete p.uniToken;
    delete p.uniTokenExpiresAt;
    await this.persist();
  }
}
