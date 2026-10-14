import type { Account, DeviceProfile } from '@sef/shared';
import { hashPassword, verifyPassword } from '@sef/shared/node';
import { config, log } from '../config';
import { readJson, writeJson } from '../lib/fs';

/** What the device remembers about a student. The verifier and uni token never leave the engine. */
interface StoredProfile extends Omit<DeviceProfile, 'offlineReady'> {
  /** scrypt hash of the password, set at the last successful online sign-in (or by the demo seeder). */
  verifier?: string;
  uniToken?: string;
  uniTokenExpiresAt?: string;
}

const toPublic = ({ verifier, uniToken: _t, uniTokenExpiresAt: _e, ...rest }: StoredProfile): DeviceProfile => ({
  ...rest,
  offlineReady: Boolean(verifier),
});

/** Student profiles known to this device. Enables offline sign-in after one online sign-in. */
export class ProfileRegistry {
  private profiles: Map<string, StoredProfile> | null = null;

  private async load(): Promise<Map<string, StoredProfile>> {
    if (!this.profiles) {
      const rows = await readJson<StoredProfile[]>(config.paths.profiles, []);
      this.profiles = new Map(rows.map((p) => [p.id, p]));
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

  async uniToken(id: string): Promise<string | undefined> {
    const p = (await this.load()).get(id);
    if (!p?.uniToken || (p.uniTokenExpiresAt && Date.parse(p.uniTokenExpiresAt) < Date.now())) return undefined;
    return p.uniToken;
  }

  /** Records a successful online sign-in: refreshes identity, offline verifier and uni token. */
  async recordOnline(account: Account, password: string, uniToken: string, expiresAt: string): Promise<DeviceProfile> {
    const profiles = await this.load();
    const existing = profiles.get(account.id);
    const next: StoredProfile = {
      id: account.id,
      name: account.name,
      email: account.email,
      cohortId: account.cohortId ?? existing?.cohortId ?? '',
      stage: account.stage,
      persona: account.persona,
      lastOnlineAt: new Date().toISOString(),
      verifier: await hashPassword(password),
      uniToken,
      uniTokenExpiresAt: expiresAt,
    };
    profiles.set(account.id, next);
    await this.persist();
    log.info('profile_online_signin', { profileId: account.id, cohortId: next.cohortId, created: !existing });
    return toPublic(next);
  }

  /** Offline sign-in: only possible for profiles that have a verifier on this device. */
  async verifyOffline(email: string, password: string): Promise<DeviceProfile | null> {
    const profile = [...(await this.load()).values()].find((p) => p.email === email);
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

  async forgetUniToken(id: string): Promise<void> {
    const p = (await this.load()).get(id);
    if (!p) return;
    delete p.uniToken;
    delete p.uniTokenExpiresAt;
    await this.persist();
  }
}
