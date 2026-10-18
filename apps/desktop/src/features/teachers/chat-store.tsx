import { TEACHER_IDS, type AnchorCandidate, type ChatAttachment, type ChatStreamEvent, type SessionDetail, type TeacherId, type Verification } from '@sef/shared';
import { useQueryClient } from '@tanstack/react-query';
import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { toast } from 'sonner';
import { api, conversationApi, EngineError, streamTurn, TurnRefused } from '@/lib/api';
import { capture } from '@/lib/analytics';
import { log } from '@/lib/log';
import { keys } from '@/lib/queries';

/** One visible step of a teacher's work: a status update from the harness or a tool call. */
export interface TraceStep {
  kind: 'status' | 'tool';
  label: string;
  detail?: string;
  at: number;
}

export interface ChatMessage {
  id: string;
  role: 'user' | 'assistant';
  content: string;
  attachments?: Array<ChatAttachment & { preview: string }>;
  /** Images sent in a restored turn (the images themselves are never stored). */
  images?: number;
  pending?: boolean;
  trace?: TraceStep[];
  startedAt?: number;
  firstTokenAt?: number;
  finishedAt?: number;
  verification?: Verification;
  error?: string;
  stopped?: boolean;
}

export interface Thread {
  /** Server-issued conversation id; null until the first turn is sent. */
  sessionId: string | null;
  messages: ChatMessage[];
  busy: boolean;
  /** A saved conversation is being loaded from the engine. */
  loading?: boolean;
  /** The wiki page this conversation explores from — the claim the engine re-verifies each turn. */
  anchor?: AnchorCandidate | null;
  /** Ambiguity the engine handed back instead of guessing — the student picks, the turn retries. */
  anchorChoices?: AnchorCandidate[] | null;
  /** Per-turn web consent; resets to off after each send so a later turn never inherits it. */
  webConsent?: boolean;
}

interface ChatStore {
  threads: Record<TeacherId, Thread>;
  send: (teacher: TeacherId, text: string, attachments?: ChatMessage['attachments']) => Promise<void>;
  /** Chooses (or clears) the exploration anchor for a Philosopher thread. */
  setAnchor: (teacher: TeacherId, anchor: AnchorCandidate | null) => void;
  /** Arms the one-turn web consent. Nothing leaves the device until a turn sends with it. */
  setWebConsent: (teacher: TeacherId, on: boolean) => void;
  /** Dismisses an ambiguity choice without retrying. */
  clearAnchorChoices: (teacher: TeacherId) => void;
  /** Drops the last exchange and asks the same question again. */
  retry: (teacher: TeacherId) => Promise<void>;
  stop: (teacher: TeacherId) => void;
  reset: (teacher: TeacherId) => void;
  /** Records an accepted hand-off with the engine and points the target thread at the successor; false when it could not be recorded, so the caller stays put. */
  handoff: (from: TeacherId, to: TeacherId) => Promise<boolean>;
  /** Opens a saved conversation from this device. */
  open: (teacher: TeacherId, sessionId: string) => Promise<void>;
  remove: (teacher: TeacherId, sessionId: string) => Promise<void>;
}

const ChatContext = createContext<ChatStore | null>(null);

const newThread = (): Thread => ({ sessionId: null, messages: [], busy: false });
const uid = () => Math.random().toString(36).slice(2, 10);

/** Refusals the client can heal itself: the session is gone or finished, so reopen and resend. */
const REOPENABLE = new Set(['unknown_session', 'session_closed']);

function fromSession(session: SessionDetail): ChatMessage[] {
  return session.turns.map((t, i) => ({
    id: `${session.id}-${i}`,
    role: t.role,
    content: t.content,
    images: t.images,
    verification: t.verification,
  }));
}

/** Which conversation is open per teacher, remembered per student so a reload picks up where they left off. */
function activeStore(profileId: string) {
  const key = `sef.chat.active.${profileId}`;
  const read = (): Partial<Record<TeacherId, string>> => {
    try {
      return JSON.parse(localStorage.getItem(key) ?? '{}') as Partial<Record<TeacherId, string>>;
    } catch {
      return {};
    }
  };
  return {
    read,
    set(teacher: TeacherId, sessionId: string | null) {
      const next = { ...read() };
      if (sessionId) next[teacher] = sessionId;
      else delete next[teacher];
      try {
        localStorage.setItem(key, JSON.stringify(next));
      } catch (error) {
        log.warn('active_session_not_saved', { teacher, error: (error as Error).message });
      }
    },
  };
}

/** Holds one conversation per teacher so switching screens or teachers never loses a thread. */
export function ChatProvider({ profileId, children }: { profileId: string; children: ReactNode }) {
  const [threads, setThreads] = useState<Record<TeacherId, Thread>>({ friend: newThread(), guide: newThread(), philosopher: newThread() });
  const aborts = useRef<Partial<Record<TeacherId, AbortController>>>({});
  /** Source of truth between renders: streaming events and retry read it synchronously. */
  const threadsRef = useRef(threads);
  const active = useMemo(() => activeStore(profileId), [profileId]);
  const queryClient = useQueryClient();

  const update = useCallback((teacher: TeacherId, patch: (t: Thread) => Thread) => {
    const next = { ...threadsRef.current, [teacher]: patch(threadsRef.current[teacher]) };
    threadsRef.current = next;
    setThreads(next);
  }, []);

  const patchMessage = useCallback(
    (teacher: TeacherId, id: string, patch: (m: ChatMessage) => ChatMessage) => update(teacher, (t) => ({ ...t, messages: t.messages.map((m) => (m.id === id ? patch(m) : m)) })),
    [update],
  );

  const load = useCallback(
    async (teacher: TeacherId, sessionId: string, { quiet = false } = {}) => {
      update(teacher, () => ({ sessionId, messages: [], busy: false, loading: true }));
      try {
        const session = await api.session(sessionId);
        update(teacher, (t) => (t.sessionId === sessionId ? { ...t, messages: fromSession(session), loading: false, anchor: session.anchor ?? null } : t));
        active.set(teacher, sessionId);
      } catch (error) {
        log.warn('chat_session_load_failed', { teacher, sessionId, error: String(error) });
        active.set(teacher, null);
        update(teacher, () => newThread());
        if (!quiet && !(error instanceof EngineError && error.status === 404)) toast.error('Could not open that conversation.');
      }
    },
    [active, update],
  );

  useEffect(() => {
    const saved = active.read();
    for (const teacher of TEACHER_IDS) {
      const id = saved[teacher];
      if (id) void load(teacher, id, { quiet: true });
    }
  }, [active, load]);

  // Sign-out and profile switches remount this provider (Root keys the tree by profile id):
  // a stream belongs to the student who started it, so it dies here rather than leaking on.
  useEffect(() => {
    const controllers = aborts.current;
    return () => {
      for (const controller of Object.values(controllers)) controller?.abort();
    };
  }, []);

  const send = useCallback<ChatStore['send']>(
    async (teacher, text, attachments) => {
      const thread = threadsRef.current[teacher];
      if (thread.busy || thread.loading) return;
      capture('teacher_turn_sent', { teacher });
      const userMsg: ChatMessage = { id: uid(), role: 'user', content: text, attachments };
      const assistantId = uid();
      const startedAt = Date.now();

      update(teacher, (t) => ({ ...t, busy: true, messages: [...t.messages, userMsg, { id: assistantId, role: 'assistant', content: '', pending: true, trace: [], startedAt }] }));

      const controller = new AbortController();
      aborts.current[teacher] = controller;

      const addStep = (step: Omit<TraceStep, 'at'>) => patchMessage(teacher, assistantId, (m) => ({ ...m, trace: [...(m.trace ?? []), { ...step, at: Date.now() }] }));
      const onEvent = (sessionId: string) => (event: ChatStreamEvent) => {
        switch (event.type) {
          case 'status':
            addStep({ kind: 'status', label: event.message });
            break;
          case 'tool':
            addStep({ kind: 'tool', label: event.tool, detail: event.summary });
            break;
          case 'delta':
            patchMessage(teacher, assistantId, (m) => ({ ...m, content: m.content + event.text, firstTokenAt: m.firstTokenAt ?? Date.now() }));
            break;
          case 'done':
            patchMessage(teacher, assistantId, (m) => ({ ...m, content: event.text, pending: false, finishedAt: Date.now(), verification: event.verification }));
            // The anchor the engine actually served under wins — it re-read the page this turn.
            if (event.verification.anchor) update(teacher, (t) => ({ ...t, anchor: event.verification.anchor ?? t.anchor }));
            active.set(teacher, sessionId);
            void queryClient.invalidateQueries({ queryKey: keys.scoped.sessions(profileId, teacher) });
            break;
          case 'error':
            log.warn('chat_error', { teacher, message: event.message });
            patchMessage(teacher, assistantId, (m) => ({ ...m, pending: false, finishedAt: Date.now(), error: event.message }));
            break;
        }
      };

      // A conversation is opened lazily on the first turn: the server issues the id, so there is
      // nothing to mint client-side and nothing to fake before the server agrees.
      const ensureSession = async (): Promise<string> => {
        const existing = threadsRef.current[teacher].sessionId;
        if (existing) return existing;
        const conversation = await conversationApi.open(teacher);
        update(teacher, (t) => ({ ...t, sessionId: conversation.sessionId }));
        return conversation.sessionId;
      };

      try {
        let sessionId = await ensureSession();
        log.info('chat_send', { teacher, sessionId, images: attachments?.length ?? 0 });
        const anchor = threadsRef.current[teacher].anchor;
        const turn = {
          sessionId,
          teacher,
          clientMessageId: userMsg.id,
          message: text,
          attachments: attachments?.map(({ preview: _p, ...a }) => a),
          // The anchor travels as a claim — page plus the revision it was picked at — and the
          // consent is exactly this turn's: nothing else leaves the device with it.
          ...(teacher === 'philosopher' && anchor ? { anchorPageId: anchor.pageId, anchorRevision: anchor.pageRevision } : {}),
          // The Philosopher's job is real-world context: every anchored turn searches the web (topic only).
          ...(teacher === 'philosopher' ? { consent: { web: true } } : {}),
        };
        try {
          await streamTurn(turn, onEvent(sessionId), controller.signal);
        } catch (error) {
          if (!(error instanceof TurnRefused && REOPENABLE.has(error.code))) throw error;
          // The session we knew is gone or finished — reopen once and send the same message again.
          sessionId = (await conversationApi.open(teacher)).sessionId;
          update(teacher, (t) => ({ ...t, sessionId }));
          await streamTurn({ ...turn, sessionId }, onEvent(sessionId), controller.signal);
        }
      } catch (error) {
        if (error instanceof TurnRefused && error.code === 'anchor_ambiguous' && error.anchors?.length) {
          // The engine refused to guess: hand the candidates back for the student to pick.
          update(teacher, (t) => ({ ...t, anchorChoices: error.anchors ?? null }));
          patchMessage(teacher, assistantId, (m) => ({ ...m, pending: false, finishedAt: Date.now(), error: error.message }));
        } else {
          const message = error instanceof TurnRefused ? error.message : 'Could not send that message.';
          log.warn('chat_send_refused', { teacher, code: error instanceof TurnRefused ? error.code : 'request_failed' });
          patchMessage(teacher, assistantId, (m) => ({ ...m, pending: false, finishedAt: Date.now(), error: message }));
        }
      }

      patchMessage(teacher, assistantId, (m) => (m.pending ? { ...m, pending: false, finishedAt: Date.now(), stopped: controller.signal.aborted } : m));
      // Consent is one turn's: it does not quietly roll into the next question.
      update(teacher, (t) => ({ ...t, busy: false, webConsent: false }));
    },
    [active, patchMessage, queryClient, update],
  );

  const setAnchor = useCallback<ChatStore['setAnchor']>(
    (teacher, anchor) => update(teacher, (t) => ({ ...t, anchor, anchorChoices: null })),
    [update],
  );

  const setWebConsent = useCallback<ChatStore['setWebConsent']>(
    (teacher, on) => update(teacher, (t) => ({ ...t, webConsent: on })),
    [update],
  );

  const clearAnchorChoices = useCallback<ChatStore['clearAnchorChoices']>(
    (teacher) => update(teacher, (t) => ({ ...t, anchorChoices: null })),
    [update],
  );

  const retry = useCallback<ChatStore['retry']>(
    async (teacher) => {
      const thread = threadsRef.current[teacher];
      if (thread.busy) return;
      const lastUser = thread.messages.findLastIndex((m) => m.role === 'user');
      if (lastUser < 0) return;
      const question = thread.messages[lastUser]!;
      update(teacher, (t) => ({ ...t, messages: t.messages.slice(0, lastUser) }));
      log.info('chat_retry', { teacher, sessionId: thread.sessionId });
      await send(teacher, question.content, question.attachments);
    },
    [send, update],
  );

  const stop = useCallback((teacher: TeacherId) => {
    aborts.current[teacher]?.abort();
  }, []);

  const reset = useCallback(
    (teacher: TeacherId) => {
      aborts.current[teacher]?.abort();
      active.set(teacher, null);
      update(teacher, () => newThread());
    },
    [active, update],
  );

  const handoff = useCallback<ChatStore['handoff']>(
    async (from, to) => {
      const sessionId = threadsRef.current[from].sessionId;
      if (!sessionId) return true; // nothing was ever said on the source thread — the view just switches
      try {
        const next = await conversationApi.handoff(sessionId, to, 'the student accepted a hand-off');
        update(to, () => ({ sessionId: next.sessionId, messages: [], busy: false }));
        active.set(to, next.sessionId);
        log.info('chat_handoff_recorded', { from, to, sessionId: next.sessionId });
        return true;
      } catch (error) {
        log.warn('chat_handoff_failed', { from, to, error: String(error) });
        toast.error('The hand-off could not be recorded, so the original conversation stays open.');
        return false;
      }
    },
    [active, update],
  );

  const open = useCallback<ChatStore['open']>(
    async (teacher, sessionId) => {
      if (threadsRef.current[teacher].sessionId === sessionId) return;
      aborts.current[teacher]?.abort();
      log.info('chat_session_open', { teacher, sessionId });
      await load(teacher, sessionId);
    },
    [load],
  );

  const remove = useCallback<ChatStore['remove']>(
    async (teacher, sessionId) => {
      try {
        await api.deleteSession(sessionId);
        log.info('chat_session_deleted', { teacher, sessionId });
        if (threadsRef.current[teacher].sessionId === sessionId) reset(teacher);
        await queryClient.invalidateQueries({ queryKey: keys.scoped.sessions(profileId, teacher) });
      } catch (error) {
        toast.error(error instanceof Error ? error.message : 'Could not delete that conversation.');
      }
    },
    [queryClient, reset],
  );

  const value = useMemo(
    () => ({ threads, send, retry, stop, reset, handoff, open, remove, setAnchor, setWebConsent, clearAnchorChoices }),
    [threads, send, retry, stop, reset, handoff, open, remove, setAnchor, setWebConsent, clearAnchorChoices],
  );
  return <ChatContext.Provider value={value}>{children}</ChatContext.Provider>;
}

export function useChat(): ChatStore {
  const ctx = useContext(ChatContext);
  if (!ctx) throw new Error('useChat must be used inside ChatProvider');
  return ctx;
}
