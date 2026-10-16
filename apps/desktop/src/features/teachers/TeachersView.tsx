import { TEACHER_IDS, TEACHERS, type TeacherId } from '@sef/shared';
import { useMutation } from '@tanstack/react-query';
import { ArrowDown, FileCheck, RotateCcw } from 'lucide-react';
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
import { useAnchors, useInvalidateBrain } from '@/lib/queries';
import { ProposalReviewDialog } from '@/features/contribute/ProposalReviewDialog';
import { useStickToBottom } from '@/lib/use-stick-to-bottom';
import { AnchorBar } from './AnchorBar';
import { useChat, type ChatMessage } from './chat-store';
import { Composer, type Attachments, type ComposerHandle } from './Composer';
import { HistoryButton } from './ConversationHistory';
import { AssistantMessage, ThreadSkeleton, UserMessage } from './MessageRow';
import { ReflectDialog } from './ReflectDialog';
import { TeacherIntro } from './TeacherIntro';
import { TEACHER_LOOK } from './teacher-meta';

export function TeachersView() {
  const nav = useNav();
  const [teacher, setTeacher] = useState<TeacherId>(nav.teacher ?? 'guide');
  const { threads, send, retry, stop, reset, handoff, setAnchor, setWebConsent, clearAnchorChoices } = useChat();
  const thread = threads[teacher];
  const anchors = useAnchors(teacher === 'philosopher');
  const [draft, setDraft] = useState(nav.draft ?? '');
  const [attachments, setAttachments] = useState<Attachments>([]);
  const [reflectStartedAt, setReflectStartedAt] = useState<number>();
  const [reflectOpen, setReflectOpen] = useState(false);
  const [proposalId, setProposalId] = useState<string | null>(null);
  const composer = useRef<ComposerHandle>(null);
  const invalidateBrain = useInvalidateBrain();
  const lastMessage = thread.messages.at(-1);
  const scroll = useStickToBottom<HTMLDivElement>(`${teacher}:${thread.messages.length}:${lastMessage?.content.length ?? 0}:${lastMessage?.trace?.length ?? 0}`);

  useEffect(() => {
    if (nav.teacher) setTeacher(nav.teacher);
    if (nav.draft) setDraft(nav.draft);
  }, [nav.teacher, nav.draft]);

  /**
   * A launch from the sky or a page deep link names the anchor by page id; the catalogue
   * row it must match is the engine's, re-fetched — a page that no longer qualifies is
   * said so, not silently anchored.
   */
  useEffect(() => {
    if (nav.teacher !== 'philosopher' || !nav.anchorPage || !anchors.data) return;
    const candidate = anchors.data.anchors.find((a) => a.pageId === nav.anchorPage);
    if (candidate) setAnchor('philosopher', candidate);
    else toast.info('That page is not an anchor any more — pick a current page to explore from.');
    // The claim is consumed once: the thread's anchor is the truth from here.
    nav.go('teachers', { teacher: 'philosopher' });
  }, [nav, anchors.data, setAnchor]);

  useEffect(() => {
    scroll.scrollToBottom('auto');
    composer.current?.focus();
  }, [teacher, scroll.scrollToBottom]);

  const reflect = useMutation({
    mutationFn: async () => {
      if (!thread.sessionId) throw new Error('Nothing has been said in this conversation yet.');
      setReflectStartedAt(Date.now());
      setReflectOpen(true);
      // Freeze the fresh turns as a source, then let the keeper draft — the proposal
      // comes back for review; nothing reaches the wiki until the student accepts.
      const receipt = await api.reflectReview(thread.sessionId);
      return api.compileJob(receipt.jobId);
    },
    onSuccess: (result) => {
      setReflectOpen(false);
      invalidateBrain();
      if (result.job.stage === 'awaiting_review' && result.proposalId) {
        setProposalId(result.proposalId);
      } else if (result.job.stage === 'no_changes') {
        toast.info('The keeper found nothing new in that session to write.');
      } else if (result.job.stage === 'failed') {
        toast.error(result.job.error ?? 'The reflection could not be drafted — it is kept under Add to my wiki for a retry.');
      }
    },
    onError: (e) => {
      setReflectOpen(false);
      log.warn('reflect_failed', { teacher, error: (e as Error).message });
      toast.error((e as Error).message);
    },
  });

  /**
   * Save to wiki: the answer turn is frozen as a model-provenance source and its job
   * compiles straight away. The proposal still waits for the student's accept — the only
   * difference from Reflect is granularity: one answer, not the whole session.
   */
  const save = useMutation({
    mutationFn: async (message: ChatMessage) => {
      if (!thread.sessionId) throw new Error('Nothing has been said in this conversation yet.');
      // Index and content both go up: a failed turn drifts the position, and the stored
      // session turn — not the rendered message — is the source of truth for the save.
      const receipt = await api.saveAnswer({ sessionId: thread.sessionId, turnIndex: thread.messages.indexOf(message), content: message.content });
      return api.compileJob(receipt.jobId);
    },
    onSuccess: (result) => {
      invalidateBrain();
      if (result.job.stage === 'awaiting_review' && result.proposalId) {
        setProposalId(result.proposalId);
      } else if (result.job.stage === 'no_changes') {
        toast.info('The answer is kept as a source, but the keeper found nothing to write from it.');
      } else if (result.job.stage === 'failed') {
        toast.error(result.job.error ?? 'The saved answer could not be drafted — it is kept under Add to my wiki for a retry.');
      }
    },
    onError: (e) => {
      log.warn('wiki_save_failed', { teacher, error: (e as Error).message });
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
          <Tooltip content={teacher === 'friend' ? 'Campus chats are not part of your study brain' : 'Freeze this conversation as a source and draft wiki updates — nothing is written until you review and accept the proposal.'}>
            <span>
              <Button variant="primary" size="sm" onClick={() => reflect.mutate()} disabled={!userTurns || thread.busy || teacher === 'friend' || reflect.isPending}>
                {reflect.isPending ? <PixelLoader /> : <FileCheck />} {reflect.isPending ? 'Reflecting' : 'Reflect into brain'}
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
              <TeacherIntro teacher={teacher} onPick={(p) => submit(p)} anchor={thread.anchor} onAnchor={(a) => setAnchor(teacher, a)} />
            ) : (
              <div className="space-y-7" role="log" aria-live="polite" aria-atomic="false">
                {thread.messages.map((m, i) =>
                  m.role === 'user' ? (
                    <UserMessage key={m.id} message={m} />
                  ) : (
                    <AssistantMessage
                      key={m.id}
                      message={m}
                      teacher={teacher}
                      isLatest={i === thread.messages.length - 1 && !thread.busy}
                      onSave={teacher === 'friend' ? undefined : () => save.mutate(m)}
                      saving={save.isPending}
                      onRetry={() => void retry(teacher)}
                      onFollowUp={(text) => submit(text)}
                      onHandoff={(to) => {
                        const lastQuestion = thread.messages.findLast((x) => x.role === 'user');
                        // The registry closes this conversation and issues the successor; the view
                        // follows only once that is recorded, so a failed hand-off never strands
                        // the student outside the conversation that is still open.
                        void handoff(teacher, to).then((recorded) => {
                          if (!recorded) return;
                          setTeacher(to);
                          if (lastQuestion) setDraft(lastQuestion.content);
                        });
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
        {teacher === 'philosopher' && (
          <AnchorBar
            thread={thread}
            onAnchor={(a) => setAnchor('philosopher', a)}
            onConsent={(on) => setWebConsent('philosopher', on)}
            onExploreChoice={(a) => {
              setAnchor('philosopher', a);
              // The choice resolves the refused turn — retry resends it under the new anchor.
              void retry('philosopher');
            }}
            onDismissChoices={() => clearAnchorChoices('philosopher')}
          />
        )}
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

      <ReflectDialog open={reflectOpen} startedAt={reflectStartedAt} onClose={() => setReflectOpen(false)} />
      <ProposalReviewDialog proposalId={proposalId} onClose={() => setProposalId(null)} />
    </div>
  );
}
