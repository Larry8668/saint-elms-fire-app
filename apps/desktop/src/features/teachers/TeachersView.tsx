import { TEACHER_IDS, TEACHERS, type IngestResult, type TeacherId } from '@sef/shared';
import { useMutation } from '@tanstack/react-query';
import { ArrowDown, Brain, RotateCcw } from 'lucide-react';
import { AnimatePresence, motion } from 'motion/react';
import { useEffect, useRef, useState } from 'react';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';
import { PixelLoader } from '@/components/ui/loading';
import { Tooltip } from '@/components/ui/overlays';
import { api } from '@/lib/api';
import { cn } from '@/lib/cn';
import { log } from '@/lib/log';
import { useNav } from '@/lib/nav';
import { useInvalidateBrain } from '@/lib/queries';
import { useStickToBottom } from '@/lib/use-stick-to-bottom';
import { useChat } from './chat-store';
import { Composer, type Attachments, type ComposerHandle } from './Composer';
import { HistoryButton } from './ConversationHistory';
import { AssistantMessage, ThreadSkeleton, UserMessage } from './MessageRow';
import { ReflectDialog } from './ReflectDialog';
import { TeacherIntro } from './TeacherIntro';
import { TEACHER_LOOK } from './teacher-meta';

export function TeachersView() {
  const nav = useNav();
  const [teacher, setTeacher] = useState<TeacherId>(nav.teacher ?? 'guide');
  const { threads, send, retry, stop, reset, handoff } = useChat();
  const thread = threads[teacher];
  const [draft, setDraft] = useState(nav.draft ?? '');
  const [attachments, setAttachments] = useState<Attachments>([]);
  const [reflection, setReflection] = useState<IngestResult | null>(null);
  const [reflectStartedAt, setReflectStartedAt] = useState<number>();
  const [reflectOpen, setReflectOpen] = useState(false);
  const composer = useRef<ComposerHandle>(null);
  const invalidateBrain = useInvalidateBrain();
  const lastMessage = thread.messages.at(-1);
  const scroll = useStickToBottom<HTMLDivElement>(`${teacher}:${thread.messages.length}:${lastMessage?.content.length ?? 0}:${lastMessage?.trace?.length ?? 0}`);

  useEffect(() => {
    if (nav.teacher) setTeacher(nav.teacher);
    if (nav.draft) setDraft(nav.draft);
  }, [nav.teacher, nav.draft]);

  useEffect(() => {
    scroll.scrollToBottom('auto');
    composer.current?.focus();
  }, [teacher, scroll.scrollToBottom]);

  const reflect = useMutation({
    mutationFn: () => {
      if (!thread.sessionId) throw new Error('Nothing has been said in this conversation yet.');
      setReflection(null);
      setReflectStartedAt(Date.now());
      setReflectOpen(true);
      return api.ingest(thread.sessionId);
    },
    onSuccess: (result) => {
      setReflection(result);
      setReflectOpen(true);
      invalidateBrain();
    },
    onError: (e) => {
      setReflectOpen(false);
      log.warn('reflect_failed', { teacher, error: (e as Error).message });
      toast.error((e as Error).message);
    },
  });

  const submit = (text = draft) => {
    const trimmed = text.trim();
    if ((!trimmed && !attachments.length) || thread.busy) return;
    void send(teacher, trimmed, attachments.length ? attachments : undefined);
    setDraft('');
    setAttachments([]);
    scroll.scrollToBottom();
  };

  const prefill = (text: string) => {
    setDraft(text);
    composer.current?.focus();
  };

  const userTurns = thread.messages.filter((m) => m.role === 'user').length;

  return (
    <div className="flex h-full flex-col">
      <div className="flex flex-col gap-3 border-b border-white/[0.06] px-6 py-4 lg:flex-row lg:items-center lg:justify-between">
        <div className="grid grid-cols-3 gap-2 lg:flex" role="tablist" aria-label="Teachers">
          {TEACHER_IDS.map((id) => {
            const t = TEACHERS[id];
            const l = TEACHER_LOOK[id];
            const active = id === teacher;
            return (
              <button
                key={id}
                role="tab"
                aria-selected={active}
                onClick={() => setTeacher(id)}
                className={cn(
                  'group relative flex cursor-pointer items-center gap-3 rounded-2xl border px-3.5 py-2.5 text-left transition',
                  active ? `${l.ring} bg-white/[0.06]` : 'border-white/[0.06] hover:border-white/[0.12] hover:bg-white/[0.03]',
                )}
              >
                <span className={cn('grid size-9 shrink-0 place-items-center rounded-xl bg-white/[0.05]', l.accent)}>
                  <l.Icon className="size-[18px]" />
                </span>
                <span className="hidden min-w-0 sm:block">
                  <span className="block text-sm font-medium text-night-100">{t.name}</span>
                  <span className="block truncate text-[11.5px] text-night-400">{t.role}</span>
                </span>
                {threads[id].busy && <PixelLoader className={cn('ml-1', l.accent)} />}
              </button>
            );
          })}
        </div>
        <div className="flex items-center gap-2">
          <HistoryButton teacher={teacher} />
          <Tooltip content="Start a fresh conversation with this teacher">
            <Button variant="ghost" size="sm" onClick={() => reset(teacher)} disabled={!thread.messages.length}>
              <RotateCcw /> New
            </Button>
          </Tooltip>
          <Tooltip content={teacher === 'friend' ? 'Campus chats are not part of your study brain' : 'The brain keeper reads this session and proposes updates to your concept pages. A validator checks every edit.'}>
            <span>
              <Button variant="primary" size="sm" onClick={() => reflect.mutate()} disabled={!userTurns || thread.busy || teacher === 'friend' || reflect.isPending}>
                {reflect.isPending ? <PixelLoader /> : <Brain />} {reflect.isPending ? 'Reflecting' : 'Reflect into brain'}
              </Button>
            </span>
          </Tooltip>
        </div>
      </div>

      <div className="relative min-h-0 flex-1">
        <div ref={scroll.ref} onScroll={scroll.onScroll} className="h-full overflow-y-auto">
          <div className="mx-auto w-full max-w-3xl px-6 py-8">
            {thread.loading ? (
              <ThreadSkeleton />
            ) : thread.messages.length === 0 ? (
              <TeacherIntro teacher={teacher} onPick={(p) => submit(p)} />
            ) : (
              <div className="space-y-7">
                {thread.messages.map((m, i) =>
                  m.role === 'user' ? (
                    <UserMessage key={m.id} message={m} />
                  ) : (
                    <AssistantMessage
                      key={m.id}
                      message={m}
                      teacher={teacher}
                      isLatest={i === thread.messages.length - 1 && !thread.busy}
                      onRetry={() => void retry(teacher)}
                      onFollowUp={(text) => submit(text)}
                      onHandoff={(to) => {
                        const lastQuestion = thread.messages.findLast((x) => x.role === 'user');
                        // The registry closes this conversation and issues the successor; the view
                        // follows it rather than silently re-teachering the same session.
                        void handoff(teacher, to);
                        setTeacher(to);
                        if (lastQuestion) setDraft(lastQuestion.content);
                      }}
                    />
                  ),
                )}
              </div>
            )}
          </div>
        </div>

        <AnimatePresence>
          {!scroll.atBottom && (
            <motion.button
              initial={{ opacity: 0, y: 6 }}
              animate={{ opacity: 1, y: 0 }}
              exit={{ opacity: 0, y: 6 }}
              onClick={() => scroll.scrollToBottom()}
              className="glass-strong absolute bottom-4 left-1/2 flex -translate-x-1/2 cursor-pointer items-center gap-1.5 rounded-full px-3 py-1.5 text-[12px] text-night-200 shadow-lg hover:text-night-100"
            >
              <ArrowDown className="size-3.5" /> {thread.busy ? 'Answer streaming' : 'Latest'}
            </motion.button>
          )}
        </AnimatePresence>
      </div>

      <div className="border-t border-white/[0.06] px-6 py-4">
        <Composer
          ref={composer}
          teacher={teacher}
          draft={draft}
          onDraftChange={setDraft}
          attachments={attachments}
          onAttachmentsChange={setAttachments}
          busy={thread.busy}
          onSubmit={() => submit()}
          onStop={() => stop(teacher)}
        />
      </div>

      <ReflectDialog
        open={reflectOpen}
        startedAt={reflectStartedAt}
        result={reflection}
        onClose={() => setReflectOpen(false)}
        onSeeSky={() => {
          setReflectOpen(false);
          nav.go('sky');
        }}
      />
    </div>
  );
}
