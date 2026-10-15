import { randomUUID } from 'node:crypto';
import path from 'node:path';
import type { ChatTurn, TeacherId, TurnRejection } from '@sef/shared';
import { profilePaths } from '../config';
import { readJson, writeJson } from '../lib/fs';
import type { Session } from '../sessions/store';
import { MAX_HISTORY_TURNS } from './messages';

/** How many completed turn ids are remembered per session for replay detection. */
const REPLAY_MEMORY = 200;

export interface ConversationRecord {
  id: string;
  profileId: string;
  teacher: TeacherId;
  createdAt: string;
  lastTurnAt: string;
  turnCount: number;
  /** Ids of turns already accepted, newest last. Bounded. */
  recentTurnIds: string[];
  closed: boolean;
  handedOffTo?: { teacher: TeacherId; sessionId: string; reason: string };
}

export interface ConversationFile {
  schemaVersion: 1;
  sessions: ConversationRecord[];
}

export interface AdmittedTurn {
  session: ConversationRecord;
  clientMessageId: string;
}

interface Stored {
  session: ConversationRecord;
  file: string;
}

/** Every refusal a turn can earn, thrown before any model or store is touched. */
export class ConversationRefused extends Error {
  constructor(
    readonly rejection: TurnRejection,
    message: string,
  ) {
    super(message);
    this.name = 'ConversationRefused';
  }
}

const REFUSAL_COPY: Record<TurnRejection, string> = {
  unknown_session: 'No such conversation. Start one with the server before sending a turn.',
  session_owner_mismatch: 'That conversation belongs to another student.',
  teacher_mismatch: 'That conversation belongs to a different teacher. Ask for a hand-off instead.',
  replayed_turn: 'That turn was already accepted.',
  concurrent_turn: 'That conversation is already answering a turn.',
  session_closed: 'That conversation is finished. Start another one.',
  capability_denied: 'This teacher is not permitted that.',
  anchor_required: 'This teacher needs an anchor before it can speak.',
};

export function refusalCopy(rejection: TurnRejection): string {
  return REFUSAL_COPY[rejection];
}

export interface ConversationRegistryOptions {
  /** Where one student's conversations live. Defaults to that profile's own sessions directory. */
  dirFor?: (profileId: string) => string;
  now?: () => Date;
  newId?: () => string;
}

/**
 * The server owns the transcript. A client references a conversation the server issued and sends
 * one message; it never supplies history, so there is nothing to invent, replay or swap teachers on.
 *
 * Ownership is checked against the in-process index rather than the caller's own file, so a
 * session id belonging to another student is refused as such instead of reading as unknown.
 */
export class ConversationRegistry {
  private readonly sessions = new Map<string, ConversationRecord>();
  private readonly fileFor = new Map<string, string>();
  private readonly now: () => Date;
  private readonly newId: () => string;
  private readonly inFlight = new Set<string>();
  private readonly loading = new Map<string, Promise<void>>();

  constructor(private readonly options: ConversationRegistryOptions) {
    this.now = options.now ?? (() => new Date());
    this.newId = options.newId ?? (() => `s-${randomUUID()}`);
  }

  private pathFor(profileId: string) {
    const dir = this.options.dirFor?.(profileId) ?? path.join(profilePaths(profileId).sessions, 'conversations');
    return path.join(dir, `${profileId.replace(/[^A-Za-z0-9_-]/g, '')}.json`);
  }

  private async load(profileId: string): Promise<void> {
    if (this.sessionsLoadedFor(profileId)) return;
    const pending = this.loading.get(profileId);
    if (pending) return pending;
    const file = this.pathFor(profileId);
    const task = (async () => {
      const stored = await readJson<ConversationFile | null>(file, null);
      for (const session of stored?.sessions ?? []) this.sessions.set(session.id, session);
      this.fileFor.set(profileId, file);
      this.loading.set(profileId, Promise.resolve());
    })();
    this.loading.set(profileId, task);
    return task;
  }

  private sessionsLoadedFor(profileId: string) {
    return this.fileFor.has(profileId);
  }

  private async persist(profile: ConversationRecord): Promise<void> {
    const file = this.pathFor(profile.profileId);
    this.fileFor.set(profile.profileId, file);
    const mine = [...this.sessions.values()].filter((s) => s.profileId === profile.profileId);
    await writeJson(file, { schemaVersion: 1, sessions: mine } satisfies ConversationFile);
  }

  /** Issues a conversation bound to one student and one teacher. */
  async open(input: { profileId: string; teacher: TeacherId }): Promise<ConversationRecord> {
    await this.load(input.profileId);
    const at = this.now().toISOString();
    const session: ConversationRecord = {
      id: this.newId(),
      profileId: input.profileId,
      teacher: input.teacher,
      createdAt: at,
      lastTurnAt: at,
      turnCount: 0,
      recentTurnIds: [],
      closed: false,
    };
    this.sessions.set(session.id, session);
    await this.persist(session);
    return session;
  }

  /**
   * The whole admission decision, in order: known, then owned, then this teacher, then open,
   * then not a replay, then not already answering. The checks and the in-flight claim run
   * without an await between them, so two concurrent calls cannot both get through.
   */
  async admit(input: { sessionId: string; profileId: string; teacher: TeacherId; clientMessageId: string }): Promise<AdmittedTurn> {
    await this.load(input.profileId);
    const session = this.sessions.get(input.sessionId);
    if (!session) throw new ConversationRefused('unknown_session', refusalCopy('unknown_session'));
    if (session.profileId !== input.profileId) throw new ConversationRefused('session_owner_mismatch', refusalCopy('session_owner_mismatch'));
    // Closed is checked before the teacher: once a thread has been handed off, "start another one"
    // is the useful answer whatever teacher the sender names.
    if (session.closed) throw new ConversationRefused('session_closed', refusalCopy('session_closed'));
    if (session.teacher !== input.teacher) throw new ConversationRefused('teacher_mismatch', refusalCopy('teacher_mismatch'));
    if (session.recentTurnIds.includes(input.clientMessageId)) throw new ConversationRefused('replayed_turn', refusalCopy('replayed_turn'));
    if (this.inFlight.has(session.id)) throw new ConversationRefused('concurrent_turn', refusalCopy('concurrent_turn'));

    this.inFlight.add(session.id);
    return { session, clientMessageId: input.clientMessageId };
  }

  /** Records the turn as taken. Only then does its id count as a replay. */
  async complete(admitted: AdmittedTurn): Promise<ConversationRecord> {
    const session = admitted.session;
    const at = this.now().toISOString();
    session.turnCount += 1;
    session.lastTurnAt = at;
    session.recentTurnIds = [...session.recentTurnIds, admitted.clientMessageId].slice(-REPLAY_MEMORY);
    this.inFlight.delete(session.id);
    try {
      await this.persist(session);
    } catch (error) {
      this.inFlight.delete(session.id);
      throw error;
    }
    return session;
  }

  /** Releases the in-flight claim when a turn failed before it could be recorded. */
  release(sessionId: string): void {
    this.inFlight.delete(sessionId);
  }

  /**
   * An explicit hand-off: the old conversation closes and a new one is issued for the new teacher.
   * A teacher never changes identity on a session, so a mid-thread role switch has no path.
   */
  async handoff(input: { sessionId: string; profileId: string; to: TeacherId; reason: string }): Promise<ConversationRecord> {
    const previous = this.sessions.get(input.sessionId);
    if (!previous) throw new ConversationRefused('unknown_session', refusalCopy('unknown_session'));
    if (previous.profileId !== input.profileId) throw new ConversationRefused('session_owner_mismatch', refusalCopy('session_owner_mismatch'));
    if (previous.teacher === input.to) throw new ConversationRefused('teacher_mismatch', refusalCopy('teacher_mismatch'));
    const next = await this.open({ profileId: input.profileId, teacher: input.to });
    previous.closed = true;
    previous.handedOffTo = { teacher: input.to, sessionId: next.id, reason: input.reason };
    await this.persist(previous);
    return next;
  }

  /** Test and shutdown seam. */
  reset(): void {
    this.sessions.clear();
    this.fileFor.clear();
    this.inFlight.clear();
    this.loading.clear();
  }

  /** Test seam: the record as stored, or null when this student does not own it. */
  get(profileId: string, sessionId: string): ConversationRecord | null {
    const session = this.sessions.get(sessionId);
    return session && session.profileId === profileId ? session : null;
  }
}

/**
 * The transcript a turn runs on: what the server stored, plus the one message it just accepted.
 * There is no path for a client to contribute earlier turns, so history cannot be invented.
 */
export function serverTranscript(session: Pick<Session, 'turns'> | null, latest: ChatTurn): ChatTurn[] {
  const history = (session?.turns ?? []).slice(-MAX_HISTORY_TURNS).map((turn) => ({ role: turn.role, content: turn.content }));
  return [...history, latest];
}