import { randomBytes } from 'node:crypto';
import type { SessionMode } from '@sef/shared';
import { config } from '../config';
import { readJson, writeJson } from '../lib/fs';

interface AuthSession {
  profileId: string;
  mode: SessionMode;
  expiresAt: string;
}

/**
 * Engine-issued sign-in sessions for the desktop UI. Opaque random tokens, persisted so an
 * engine restart does not sign the student out. Works identically online and offline.
 */
export class AuthSessions {
  private sessions: Map<string, AuthSession> | null = null;

  private async load(): Promise<Map<string, AuthSession>> {
    if (!this.sessions) {
      const rows = await readJson<Record<string, AuthSession>>(config.paths.authSessions, {});
      const now = Date.now();
      this.sessions = new Map(Object.entries(rows).filter(([, s]) => Date.parse(s.expiresAt) > now));
    }
    return this.sessions;
  }

  /** Prunes expired sessions on every write, not just at first load, so the file can't grow without bound. */
  private async persist(): Promise<void> {
    const sessions = await this.load();
    const now = Date.now();
    for (const [token, s] of sessions) if (Date.parse(s.expiresAt) <= now) sessions.delete(token);
    await writeJson(config.paths.authSessions, Object.fromEntries(sessions));
  }

  async create(profileId: string, mode: SessionMode): Promise<string> {
    const token = randomBytes(32).toString('base64url');
    const expiresAt = new Date(Date.now() + config.sessionHours * 3600_000).toISOString();
    (await this.load()).set(token, { profileId, mode, expiresAt });
    await this.persist();
    return token;
  }

  async resolve(token: string): Promise<AuthSession | null> {
    const session = (await this.load()).get(token);
    if (!session) return null;
    if (Date.parse(session.expiresAt) < Date.now()) {
      await this.revoke(token);
      return null;
    }
    return session;
  }

  async revoke(token: string): Promise<void> {
    if ((await this.load()).delete(token)) await this.persist();
  }
}
