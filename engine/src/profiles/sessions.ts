import { createHash, randomBytes, randomUUID } from 'node:crypto';
import type { AuthSessionSummary, SessionAccess, SessionMode } from '@sef/shared';
import { config } from '../config';
import { readJson, writeJson } from '../lib/fs';

interface AuthSession {
  /** Public handle for listing and revoking; unrelated to the token. Rows from older versions get one on load. */
  id?: string;
  profileId: string;
  mode: SessionMode;
  /** Decided when the session is issued; rows written before limited access existed have none and read as full. */
  access?: SessionAccess;
  deviceLabel?: string;
  createdAt?: string;
  lastSeenAt?: string;
  expiresAt: string;
}

const TOKEN_HASH = /^[0-9a-f]{64}$/;
const hash = (token: string) => createHash('sha256').update(token).digest('hex');
export const UNKNOWN_DEVICE = 'Unknown device';
/** `lastSeenAt` is a recency hint; rewriting the file on every request would buy nothing. */
const LAST_SEEN_RESOLUTION_MS = 5 * 60_000;

/**
 * A stable id for a row written before sessions had one: derived from its storage key, so
 * it is the same on every load even if the migration write never lands. Domain-separated
 * and truncated, so the id cannot stand in for the token hash.
 */
const legacyId = (key: string) => createHash('sha256').update(`sef-session-id:${key}`).digest('hex').slice(0, 32);

/**
 * Engine-issued sign-in sessions for the desktop UI. Opaque random tokens, persisted
 * hashed so a stolen auth-sessions.json cannot be replayed. Sessions written by older
 * versions (plaintext keys) are dropped on first load, which simply signs the user out;
 * hashed rows without an id are kept and given one.
 */
export class AuthSessions {
  private sessions: Map<string, AuthSession> | null = null;

  private async load(): Promise<Map<string, AuthSession>> {
    if (!this.sessions) {
      const rows = await readJson<Record<string, AuthSession>>(config.paths.authSessions, {});
      const now = Date.now();
      const kept = Object.entries(rows).filter(([key, s]) => TOKEN_HASH.test(key) && Date.parse(s.expiresAt) > now);
      let migrated = false;
      for (const [key, s] of kept) {
        if (!s.id) {
          s.id = legacyId(key);
          migrated = true;
        }
      }
      this.sessions = new Map(kept);
      if (migrated || kept.length !== Object.keys(rows).length) await this.persist();
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

  async create(profileId: string, mode: SessionMode, access: SessionAccess = { mode: 'full' }, deviceLabel = UNKNOWN_DEVICE): Promise<string> {
    const token = randomBytes(32).toString('base64url');
    const now = new Date();
    const expiresAt = new Date(now.getTime() + config.sessionHours * 3600_000).toISOString();
    (await this.load()).set(hash(token), {
      id: randomUUID(),
      profileId,
      mode,
      access,
      deviceLabel: deviceLabel || UNKNOWN_DEVICE,
      createdAt: now.toISOString(),
      lastSeenAt: now.toISOString(),
      expiresAt,
    });
    await this.persist();
    return token;
  }

  async resolve(token: string): Promise<AuthSession | null> {
    const session = (await this.load()).get(hash(token));
    if (!session) return null;
    const now = Date.now();
    if (Date.parse(session.expiresAt) < now) {
      await this.revoke(token);
      return null;
    }
    if (!session.lastSeenAt || now - Date.parse(session.lastSeenAt) >= LAST_SEEN_RESOLUTION_MS) {
      session.lastSeenAt = new Date(now).toISOString();
      await this.persist();
    }
    return session;
  }

  /** The profile's live sessions, newest first. Storage keys never leave this class. */
  async list(profileId: string, currentToken?: string): Promise<AuthSessionSummary[]> {
    const sessions = await this.load();
    const currentKey = currentToken ? hash(currentToken) : null;
    const now = Date.now();
    return [...sessions]
      .filter(([, s]) => s.profileId === profileId && Date.parse(s.expiresAt) > now)
      .map(([key, s]) => ({
        id: s.id ?? legacyId(key),
        deviceLabel: s.deviceLabel ?? UNKNOWN_DEVICE,
        mode: s.mode,
        createdAt: s.createdAt ?? null,
        lastSeenAt: s.lastSeenAt ?? null,
        expiresAt: s.expiresAt,
        current: key === currentKey,
      }))
      .sort((a, b) => (b.lastSeenAt ?? b.createdAt ?? '').localeCompare(a.lastSeenAt ?? a.createdAt ?? ''));
  }

  /** Revokes one session by id, only if it belongs to the profile. Returns false when there was nothing of theirs to revoke. */
  async revokeById(profileId: string, id: string): Promise<boolean> {
    const sessions = await this.load();
    for (const [key, s] of sessions) {
      if (s.id === id && s.profileId === profileId) {
        sessions.delete(key);
        await this.persist();
        return true;
      }
    }
    return false;
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

  /** Drops every session whose profile fails `keep`; returns how many went. A hosted seat's startup sweep. */
  async revokeUnless(keep: (profileId: string) => boolean): Promise<number> {
    const sessions = await this.load();
    let revoked = 0;
    for (const [key, s] of sessions) {
      if (keep(s.profileId)) continue;
      sessions.delete(key);
      revoked += 1;
    }
    if (revoked > 0) await this.persist();
    return revoked;
  }
}
