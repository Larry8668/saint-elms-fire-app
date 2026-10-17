import { readdir, rm } from 'node:fs/promises';
import path from 'node:path';
import type { AnchorCandidate, ChatTurn, SessionSummary, SourceRef, StoredTurn, TeacherId, Verification } from '@sef/shared';
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
  /** The wiki page an exploring conversation was last served under; later turns inherit it. */
  anchor?: AnchorCandidate;
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
    // The anchor the turn was actually served under wins — it was re-read from disk this
    // turn, so it always carries the revision the next continuation must re-verify.
    if (verification.anchor) session.anchor = verification.anchor;
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

  private async all(teacher?: TeacherId): Promise<Session[]> {
    const names = await readdir(this.dir).catch(() => [] as string[]);
    const sessions = await Promise.all(names.filter((n) => n.endsWith('.json')).map((n) => readJson<Session | null>(path.join(this.dir, n), null)));
    return sessions.filter((s): s is Session => Boolean(s) && (!teacher || s!.teacher === teacher));
  }

  /** The student's own latest messages to one teacher, newest first. */
  async recentUserTurns(teacher: TeacherId, limit = 20): Promise<string[]> {
    return (await this.all(teacher))
      .flatMap((s) => s.turns.filter((t) => t.role === 'user'))
      .sort((a, b) => (b.at ?? '').localeCompare(a.at ?? ''))
      .slice(0, limit)
      .map((t) => t.content);
  }

  /** Every lesson any conversation has drawn on. */
  async studiedLessonIds(): Promise<string[]> {
    return [...new Set((await this.all()).flatMap((s) => s.lessonIds))];
  }

  /** Teacher turns, and how many were refused by policy — the refusal rate's evidence. */
  async turnOutcomes(): Promise<{ total: number; refused: number }> {
    const answers = (await this.all()).flatMap((s) => s.turns.filter((t) => t.role === 'assistant'));
    return { total: answers.length, refused: answers.filter((t) => t.verification?.lane === 'refused').length };
  }

  /** When a conversation last drew on each lesson — the evidence a plan's read-lesson step waits for. */
  async lessonActivity(): Promise<Array<{ lessonId: string; at: string }>> {
    return (await this.all()).flatMap((s) => s.lessonIds.map((lessonId) => ({ lessonId, at: s.updatedAt })));
  }

  /** Newest first. `limit` is clamped to 1–MAX_LIST; non-numeric input falls back to 30. */
  async list({ teacher, limit = 30 }: { teacher?: TeacherId; limit?: number } = {}): Promise<SessionSummary[]> {
    const take = Number.isFinite(limit) ? Math.min(MAX_LIST, Math.max(1, Math.floor(limit))) : 30;
    return (await this.all(teacher))
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
