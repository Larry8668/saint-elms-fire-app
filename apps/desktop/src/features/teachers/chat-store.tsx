import type { ChatAttachment, ChatTurn, TeacherId, Verification } from '@sef/shared';
import { createContext, useCallback, useContext, useMemo, useRef, useState, type ReactNode } from 'react';
import { streamChat } from '@/lib/api';
import { log } from '@/lib/log';

export interface ChatMessage {
  id: string;
  role: 'user' | 'assistant';
  content: string;
  attachments?: Array<ChatAttachment & { preview: string }>;
  pending?: boolean;
  status?: string;
  tools?: Array<{ tool: string; summary: string }>;
  verification?: Verification;
  error?: string;
}

interface Thread {
  sessionId: string;
  messages: ChatMessage[];
  busy: boolean;
}

interface ChatStore {
  threads: Record<TeacherId, Thread>;
  send: (teacher: TeacherId, text: string, attachments?: ChatMessage['attachments']) => Promise<void>;
  stop: (teacher: TeacherId) => void;
  reset: (teacher: TeacherId) => void;
}

const ChatContext = createContext<ChatStore | null>(null);

const newSessionId = (teacher: TeacherId) => `${teacher}-${new Date().toISOString().slice(0, 10)}-${Math.random().toString(36).slice(2, 8)}`;
const newThread = (teacher: TeacherId): Thread => ({ sessionId: newSessionId(teacher), messages: [], busy: false });
const uid = () => Math.random().toString(36).slice(2, 10);

/** Holds one conversation per teacher so switching screens or teachers never loses a thread. */
export function ChatProvider({ children }: { children: ReactNode }) {
  const [threads, setThreads] = useState<Record<TeacherId, Thread>>({ friend: newThread('friend'), guide: newThread('guide'), philosopher: newThread('philosopher') });
  const aborts = useRef<Partial<Record<TeacherId, AbortController>>>({});
  const threadsRef = useRef(threads);
  threadsRef.current = threads;

  const patchAssistant = useCallback((teacher: TeacherId, id: string, patch: (m: ChatMessage) => ChatMessage) => {
    setThreads((all) => ({ ...all, [teacher]: { ...all[teacher], messages: all[teacher].messages.map((m) => (m.id === id ? patch(m) : m)) } }));
  }, []);

  const send = useCallback<ChatStore['send']>(
    async (teacher, text, attachments) => {
      const thread = threadsRef.current[teacher];
      if (thread.busy) return;
      const userMsg: ChatMessage = { id: uid(), role: 'user', content: text, attachments };
      const assistantId = uid();
      const history: ChatTurn[] = [...thread.messages, userMsg]
        .filter((m) => !m.error && m.content)
        .map((m) => ({ role: m.role, content: m.content, attachments: m.attachments?.map(({ preview: _p, ...a }) => a) }));

      setThreads((all) => ({
        ...all,
        [teacher]: { ...all[teacher], busy: true, messages: [...all[teacher].messages, userMsg, { id: assistantId, role: 'assistant', content: '', pending: true, tools: [] }] },
      }));

      const controller = new AbortController();
      aborts.current[teacher] = controller;
      log.info('chat_send', { teacher, sessionId: thread.sessionId, images: attachments?.length ?? 0 });

      await streamChat(
        { teacher, sessionId: thread.sessionId, messages: history.slice(-12) },
        (event) => {
          switch (event.type) {
            case 'status':
              patchAssistant(teacher, assistantId, (m) => ({ ...m, status: event.message }));
              break;
            case 'tool':
              patchAssistant(teacher, assistantId, (m) => ({ ...m, tools: [...(m.tools ?? []), { tool: event.tool, summary: event.summary }] }));
              break;
            case 'delta':
              patchAssistant(teacher, assistantId, (m) => ({ ...m, content: m.content + event.text, status: undefined }));
              break;
            case 'done':
              patchAssistant(teacher, assistantId, (m) => ({ ...m, content: event.text, pending: false, status: undefined, verification: event.verification }));
              break;
            case 'error':
              patchAssistant(teacher, assistantId, (m) => ({ ...m, pending: false, status: undefined, error: event.message }));
              break;
          }
        },
        controller.signal,
      );

      patchAssistant(teacher, assistantId, (m) => (m.pending ? { ...m, pending: false, status: undefined } : m));
      setThreads((all) => ({ ...all, [teacher]: { ...all[teacher], busy: false } }));
    },
    [patchAssistant],
  );

  const stop = useCallback((teacher: TeacherId) => {
    aborts.current[teacher]?.abort();
  }, []);

  const reset = useCallback((teacher: TeacherId) => {
    aborts.current[teacher]?.abort();
    setThreads((all) => ({ ...all, [teacher]: newThread(teacher) }));
  }, []);

  const value = useMemo(() => ({ threads, send, stop, reset }), [threads, send, stop, reset]);
  return <ChatContext.Provider value={value}>{children}</ChatContext.Provider>;
}

export function useChat(): ChatStore {
  const ctx = useContext(ChatContext);
  if (!ctx) throw new Error('useChat must be used inside ChatProvider');
  return ctx;
}
