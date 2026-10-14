import type { ChatAttachment, ChatTurn, TeacherId, Verification } from '@sef/shared';
import { createContext, useCallback, useContext, useMemo, useRef, useState, type ReactNode } from 'react';
import { streamChat } from '@/lib/api';
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
  pending?: boolean;
  trace?: TraceStep[];
  startedAt?: number;
  firstTokenAt?: number;
  finishedAt?: number;
  verification?: Verification;
  error?: string;
  stopped?: boolean;
}

interface Thread {
  sessionId: string;
  messages: ChatMessage[];
  busy: boolean;
}

interface ChatStore {
  threads: Record<TeacherId, Thread>;
  send: (teacher: TeacherId, text: string, attachments?: ChatMessage['attachments']) => Promise<void>;
  /** Drops the last exchange and asks the same question again. */
  retry: (teacher: TeacherId) => Promise<void>;
  stop: (teacher: TeacherId) => void;
  reset: (teacher: TeacherId) => void;
}

const ChatContext = createContext<ChatStore | null>(null);

const newSessionId = (teacher: TeacherId) => `${teacher}-${new Date().toISOString().slice(0, 10)}-${Math.random().toString(36).slice(2, 8)}`;
const newThread = (teacher: TeacherId): Thread => ({ sessionId: newSessionId(teacher), messages: [], busy: false });
const uid = () => Math.random().toString(36).slice(2, 10);

const toTurn = (m: ChatMessage): ChatTurn => ({ role: m.role, content: m.content, attachments: m.attachments?.map(({ preview: _p, ...a }) => a) });

/** Holds one conversation per teacher so switching screens or teachers never loses a thread. */
export function ChatProvider({ children }: { children: ReactNode }) {
  const [threads, setThreads] = useState<Record<TeacherId, Thread>>({ friend: newThread('friend'), guide: newThread('guide'), philosopher: newThread('philosopher') });
  const aborts = useRef<Partial<Record<TeacherId, AbortController>>>({});
  /** Source of truth between renders: streaming events and retry read it synchronously. */
  const threadsRef = useRef(threads);

  const update = useCallback((teacher: TeacherId, patch: (t: Thread) => Thread) => {
    const next = { ...threadsRef.current, [teacher]: patch(threadsRef.current[teacher]) };
    threadsRef.current = next;
    setThreads(next);
  }, []);

  const patchMessage = useCallback(
    (teacher: TeacherId, id: string, patch: (m: ChatMessage) => ChatMessage) => update(teacher, (t) => ({ ...t, messages: t.messages.map((m) => (m.id === id ? patch(m) : m)) })),
    [update],
  );

  const send = useCallback<ChatStore['send']>(
    async (teacher, text, attachments) => {
      const thread = threadsRef.current[teacher];
      if (thread.busy) return;
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
    [patchMessage, update],
  );

  const retry = useCallback<ChatStore['retry']>(
    async (teacher) => {
      const thread = threadsRef.current[teacher];
      if (thread.busy) return;
      const lastUser = thread.messages.findLastIndex((m) => m.role === 'user');
      if (lastUser < 0) return;
      const question = thread.messages[lastUser];
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
      update(teacher, () => newThread(teacher));
    },
    [update],
  );

  const value = useMemo(() => ({ threads, send, retry, stop, reset }), [threads, send, retry, stop, reset]);
  return <ChatContext.Provider value={value}>{children}</ChatContext.Provider>;
}

export function useChat(): ChatStore {
  const ctx = useContext(ChatContext);
  if (!ctx) throw new Error('useChat must be used inside ChatProvider');
  return ctx;
}
