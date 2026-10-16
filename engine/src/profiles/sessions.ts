import { createHash, randomBytes } from 'node:crypto';
import type { SessionAccess, SessionMode } from '@sef/shared';
import { config } from '../config';
import { readJson, writeJson } from '../lib/fs';

interface AuthSession {
  profileId: string;
  mode: SessionMode;
  /** Decided when the session is issued; rows written before limited access existed have none and read as full. */
  access?: SessionAccess;
  expiresAt: string;
}

const TOKEN_HASH = /^[0-9a-f]{64}$/;
const hash = (token: string) => createHash('sha256').update(token).digest('hex');

/**
 * Engine-issued sign-in sessions for the desktop UI. Opaque random tokens, persisted
 * hashed so a stolen auth-sessions.json cannot be replayed. Sessions written by older
 * versions (plaintext keys) are dropped on first load, which simply signs the user out.
 */
export class AuthSessions {
  private sessions: Map<string, AuthSession> | null = null;

  private async load(): Promise<Map<string, AuthSession>> {
    if (!this.sessions) {
      const rows = await readJson<Record<string, AuthSession>>(config.paths.authSessions, {});
      const now = Date.now();
      const kept = Object.entries(rows).filter(([key, s]) => TOKEN_HASH.test(key) && Date.parse(s.expiresAt) > now);
      this.sessions = new Map(kept);
      if (kept.length !== Object.keys(rows).length) await this.persist();
    }
    return this.sessions;
  }

  /** Prunes expired sessions on every write, not just at first load, so the file can't grow without bound. */
  private async persist(): Promise<void> {
    const sessions = this.sessions ?? new Map<string, AuthSession>();
    const now = Date.now();
    for (const [key, s] of sessions) if (Date.parse(s.expiresAt) <= now) sessions.delete(key);
    await writeJson(config.paths.authSessions, Object.fromEntries(sessions));
  }

  async create(profileId: string, mode: SessionMode, access: SessionAccess = { mode: 'full' }): Promise<string> {
    const token = randomBytes(32).toString('base64url');
    const expiresAt = new Date(Date.now() + config.sessionHours * 3600_000).toISOString();
    (await this.load()).set(hash(token), { profileId, mode, access, expiresAt });
    await this.persist();
    return token;
  }

  async resolve(token: string): Promise<AuthSession | null> {
    const session = (await this.load()).get(hash(token));
    if (!session) return null;
    if (Date.parse(session.expiresAt) < Date.now()) {
      await this.revoke(token);
      return null;
    }
    return session;
  }

  async revoke(token: string): Promise<void> {
    if ((await this.load()).delete(hash(token))) await this.persist();
  }

  /** Sign-out must kill every session bound to the profile, not just the presented token. */
  async revokeForProfile(profileId: string): Promise<void> {
    const sessions = await this.load();
    let changed = false;
    for (const [key, s] of sessions) {
      if (s.profileId === profileId) {
        sessions.delete(key);
        changed = true;
      }
    }
    if (changed) await this.persist();
  }
}
