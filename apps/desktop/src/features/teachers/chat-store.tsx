import { TEACHER_IDS, type ChatAttachment, type ChatTurn, type SessionDetail, type TeacherId, type Verification } from '@sef/shared';
import { useQueryClient } from '@tanstack/react-query';
import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { toast } from 'sonner';
import { api, EngineError, streamChat } from '@/lib/api';
import { log } from '@/lib/log';

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
  sessionId: string;
  messages: ChatMessage[];
  busy: boolean;
  /** A saved conversation is being loaded from the engine. */
  loading?: boolean;
}

interface ChatStore {
  threads: Record<TeacherId, Thread>;
  send: (teacher: TeacherId, text: string, attachments?: ChatMessage['attachments']) => Promise<void>;
  /** Drops the last exchange and asks the same question again. */
  retry: (teacher: TeacherId) => Promise<void>;
  stop: (teacher: TeacherId) => void;
  reset: (teacher: TeacherId) => void;
  /** Opens a saved conversation from this device. */
  open: (teacher: TeacherId, sessionId: string) => Promise<void>;
  remove: (teacher: TeacherId, sessionId: string) => Promise<void>;
}

const ChatContext = createContext<ChatStore | null>(null);

const newSessionId = (teacher: TeacherId) => `${teacher}-${new Date().toISOString().slice(0, 10)}-${Math.random().toString(36).slice(2, 8)}`;
const newThread = (teacher: TeacherId): Thread => ({ sessionId: newSessionId(teacher), messages: [], busy: false });
const uid = () => Math.random().toString(36).slice(2, 10);

const toTurn = (m: ChatMessage): ChatTurn => ({ role: m.role, content: m.content, attachments: m.attachments?.map(({ preview: _p, ...a }) => a) });

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
  const [threads, setThreads] = useState<Record<TeacherId, Thread>>({ friend: newThread('friend'), guide: newThread('guide'), philosopher: newThread('philosopher') });
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
        update(teacher, (t) => (t.sessionId === sessionId ? { ...t, messages: fromSession(session), loading: false } : t));
        active.set(teacher, sessionId);
      } catch (error) {
        log.warn('chat_session_load_failed', { teacher, sessionId, error: String(error) });
        active.set(teacher, null);
        update(teacher, () => newThread(teacher));
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

  const send = useCallback<ChatStore['send']>(
    async (teacher, text, attachments) => {
      const thread = threadsRef.current[teacher];
      if (thread.busy || thread.loading) return;
      const userMsg: ChatMessage = { id: uid(), role: 'user', content: text, attachments };
      const assistantId = uid();
      const history = [...thread.messages, userMsg].filter((m) => !m.error && m.content).map(toTurn);
      const startedAt = Date.now();

      update(teacher, (t) => ({ ...t, busy: true, messages: [...t.messages, userMsg, { id: assistantId, role: 'assistant', content: '', pending: true, trace: [], startedAt }] }));

      const controller = new AbortController();
      aborts.current[teacher] = controller;
      log.info('chat_send', { teacher, sessionId: thread.sessionId, images: attachments?.length ?? 0 });

      const addStep = (step: Omit<TraceStep, 'at'>) => patchMessage(teacher, assistantId, (m) => ({ ...m, trace: [...(m.trace ?? []), { ...step, at: Date.now() }] }));

      await streamChat(
        { teacher, sessionId: thread.sessionId, messages: history.slice(-12) },
        (event) => {
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
              active.set(teacher, thread.sessionId);
              void queryClient.invalidateQueries({ queryKey: ['sessions', teacher] });
              break;
            case 'error':
              log.warn('chat_error', { teacher, message: event.message });
              patchMessage(teacher, assistantId, (m) => ({ ...m, pending: false, finishedAt: Date.now(), error: event.message }));
              break;
          }
        },
        controller.signal,
      );

      patchMessage(teacher, assistantId, (m) => (m.pending ? { ...m, pending: false, finishedAt: Date.now(), stopped: controller.signal.aborted } : m));
      update(teacher, (t) => ({ ...t, busy: false }));
    },
    [active, patchMessage, queryClient, update],
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
      update(teacher, () => newThread(teacher));
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
        await queryClient.invalidateQueries({ queryKey: ['sessions', teacher] });
      } catch (error) {
        toast.error(error instanceof Error ? error.message : 'Could not delete that conversation.');
      }
    },
    [queryClient, reset],
  );

  const value = useMemo(() => ({ threads, send, retry, stop, reset, open, remove }), [threads, send, retry, stop, reset, open, remove]);
  return <ChatContext.Provider value={value}>{children}</ChatContext.Provider>;
}

export function useChat(): ChatStore {
  const ctx = useContext(ChatContext);
  if (!ctx) throw new Error('useChat must be used inside ChatProvider');
  return ctx;
}
