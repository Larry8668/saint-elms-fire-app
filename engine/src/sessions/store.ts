import { readdir } from 'node:fs/promises';
import path from 'node:path';
import type { ChatTurn, SourceRef, TeacherId } from '@sef/shared';
import { config } from '../config';
import { readJson, writeJson } from '../lib/fs';

export interface StoredTurn {
  role: ChatTurn['role'];
  content: string;
  images?: number;
  at: string;
}

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

const fileFor = (id: string) => path.join(config.paths.sessions, `${id.replace(/[^a-zA-Z0-9_-]/g, '')}.json`);

/** Chat transcripts, kept on the device. Images are not stored — only that one was sent. */
export class SessionStore {
  async get(id: string): Promise<Session | null> {
    return readJson<Session | null>(fileFor(id), null);
  }

  async appendTurn(id: string, teacher: TeacherId, user: ChatTurn, assistant: string, sources: SourceRef[], lessonIds: string[]): Promise<Session> {
    const now = new Date().toISOString();
    const session = (await this.get(id)) ?? { id, teacher, startedAt: now, updatedAt: now, turns: [], lessonIds: [], sources: [], ingestedTurns: 0 };
    session.turns.push({ role: 'user', content: user.content, images: user.attachments?.length || undefined, at: now });
    session.turns.push({ role: 'assistant', content: assistant, at: now });
    session.lessonIds = [...new Set([...session.lessonIds, ...lessonIds])];
    const known = new Set(session.sources.map((s) => `${s.kind}:${s.id}`));
    for (const s of sources) if (!known.has(`${s.kind}:${s.id}`)) session.sources.push(s);
    session.updatedAt = now;
    await writeJson(fileFor(id), session);
    return session;
  }

  async markIngested(session: Session): Promise<void> {
    session.ingestedTurns = session.turns.length;
    await writeJson(fileFor(session.id), session);
  }

  async list(limit = 30): Promise<Array<Pick<Session, 'id' | 'teacher' | 'startedAt' | 'updatedAt'> & { turns: number; pending: number; preview: string }>> {
    const names = await readdir(config.paths.sessions).catch(() => [] as string[]);
    const sessions = await Promise.all(names.filter((n) => n.endsWith('.json')).map((n) => readJson<Session | null>(path.join(config.paths.sessions, n), null)));
    return sessions
      .filter((s): s is Session => Boolean(s))
      .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))
      .slice(0, limit)
      .map((s) => ({
        id: s.id,
        teacher: s.teacher,
        startedAt: s.startedAt,
        updatedAt: s.updatedAt,
        turns: s.turns.length,
        pending: s.turns.length - s.ingestedTurns,
        preview: s.turns.find((t) => t.role === 'user')?.content.slice(0, 80) ?? '',
      }));
  }
}
