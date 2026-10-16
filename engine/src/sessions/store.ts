import { readdir, rm } from 'node:fs/promises';
import path from 'node:path';
import type { ChatTurn, SessionSummary, SourceRef, StoredTurn, TeacherId, Verification } from '@sef/shared';
import { readJson, writeJson } from '../lib/fs';

export interface Session {
  id: string;
  teacher: TeacherId;
  startedAt: string;
  updatedAt: string;
  turns: StoredTurn[];
  lessonIds: string[];
  sources: SourceRef[];
  ingestedTurns: number;
}

const PREVIEW_CHARS = 90;
const MAX_LIST = 100;

/** Chat transcripts, one JSON file per conversation in the student's workspace. Images are not stored — only that one was sent. */
export class SessionStore {
  constructor(private readonly dir: string) {}

  private fileFor(id: string) {
    return path.join(this.dir, `${id.replace(/[^a-zA-Z0-9_-]/g, '')}.json`);
  }

  /** Writes a whole session as-is (used by the demo seeder). */
  async put(session: Session): Promise<void> {
    await writeJson(this.fileFor(session.id), session);
  }

  async get(id: string): Promise<Session | null> {
    return readJson<Session | null>(this.fileFor(id), null);
  }

  async appendTurn(id: string, teacher: TeacherId, user: ChatTurn, assistant: string, verification: Verification, lessonIds: string[]): Promise<Session> {
    const now = new Date().toISOString();
    const session = (await this.get(id)) ?? { id, teacher, startedAt: now, updatedAt: now, turns: [], lessonIds: [], sources: [], ingestedTurns: 0 };
    session.turns.push({ role: 'user', content: user.content, images: user.attachments?.length || undefined, at: now });
    session.turns.push({ role: 'assistant', content: assistant, at: now, verification });
    session.lessonIds = [...new Set([...session.lessonIds, ...lessonIds])];
    const known = new Set(session.sources.map((s) => `${s.kind}:${s.id}`));
    for (const s of verification.sources) if (!known.has(`${s.kind}:${s.id}`)) session.sources.push(s);
    session.updatedAt = now;
    await writeJson(this.fileFor(id), session);
    return session;
  }

  /**
   * Checkpoints ingestion. `through` is a turn *count*: only turns the source committed
   * may be marked — anything appended after the transcript was frozen stays pending.
   */
  async markIngested(session: Session, through?: number): Promise<void> {
    session.ingestedTurns = Math.max(session.ingestedTurns, Math.min(through ?? session.turns.length, session.turns.length));
    await writeJson(this.fileFor(session.id), session);
  }

  /** Returns false when there was nothing to delete. */
  async remove(id: string): Promise<boolean> {
    try {
      await rm(this.fileFor(id));
      return true;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false;
      throw error;
    }
  }

  /** Newest first. `limit` is clamped to 1–MAX_LIST; non-numeric input falls back to 30. */
  async list({ teacher, limit = 30 }: { teacher?: TeacherId; limit?: number } = {}): Promise<SessionSummary[]> {
    const take = Number.isFinite(limit) ? Math.min(MAX_LIST, Math.max(1, Math.floor(limit))) : 30;
    const names = await readdir(this.dir).catch(() => [] as string[]);
    const sessions = await Promise.all(names.filter((n) => n.endsWith('.json')).map((n) => readJson<Session | null>(path.join(this.dir, n), null)));
    return sessions
      .filter((s): s is Session => Boolean(s) && (!teacher || s!.teacher === teacher))
      .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))
      .slice(0, take)
      .map((s) => ({
        id: s.id,
        teacher: s.teacher,
        startedAt: s.startedAt,
        updatedAt: s.updatedAt,
        turns: s.turns.length,
        pending: s.turns.length - s.ingestedTurns,
        preview: s.turns.find((t) => t.role === 'user')?.content.slice(0, PREVIEW_CHARS) ?? '',
      }));
  }
}
