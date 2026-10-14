import { TEACHER_IDS, TEACHERS, type IngestResult, type TeacherId } from '@sef/shared';
import { useMutation } from '@tanstack/react-query';
import { ArrowRight, ArrowUp, Brain, ImagePlus, Loader2, RotateCcw, Square, Wifi, X } from 'lucide-react';
import { AnimatePresence, motion } from 'motion/react';
import { useEffect, useRef, useState } from 'react';
import { toast } from 'sonner';
import { Markdown } from '@/components/Markdown';
import { Button } from '@/components/ui/button';
import { Dialog, Tooltip } from '@/components/ui/overlays';
import { Badge } from '@/components/ui/primitives';
import { BrainDiff } from '@/features/brain/BrainDiff';
import { api, fileToBase64 } from '@/lib/api';
import { cn } from '@/lib/cn';
import { useNav } from '@/lib/nav';
import { useInvalidateBrain } from '@/lib/queries';
import { useChat, type ChatMessage } from './chat-store';
import { TEACHER_LOOK } from './teacher-meta';
import { VerificationPanel } from './VerificationPanel';

const MAX_IMAGE_BYTES = 8 * 1024 * 1024;

export function TeachersView() {
  const nav = useNav();
  const [teacher, setTeacher] = useState<TeacherId>(nav.teacher ?? 'guide');
  const { threads, send, stop, reset } = useChat();
  const thread = threads[teacher];
  const [draft, setDraft] = useState(nav.draft ?? '');
  const [attachments, setAttachments] = useState<NonNullable<ChatMessage['attachments']>>([]);
  const [reflection, setReflection] = useState<IngestResult | null>(null);
  const scroller = useRef<HTMLDivElement>(null);
  const fileInput = useRef<HTMLInputElement>(null);
  const invalidateBrain = useInvalidateBrain();

  useEffect(() => {
    if (nav.teacher) setTeacher(nav.teacher);
    if (nav.draft) setDraft(nav.draft);
  }, [nav.teacher, nav.draft]);

  useEffect(() => {
    scroller.current?.scrollTo({ top: scroller.current.scrollHeight, behavior: 'smooth' });
  }, [thread.messages]);

  const reflect = useMutation({
    mutationFn: () => api.ingest(thread.sessionId),
    onSuccess: (result) => {
      setReflection(result);
      invalidateBrain();
    },
    onError: (e) => toast.error((e as Error).message),
  });

  const submit = (text = draft) => {
    const trimmed = text.trim();
    if ((!trimmed && !attachments.length) || thread.busy) return;
    void send(teacher, trimmed, attachments.length ? attachments : undefined);
    setDraft('');
    setAttachments([]);
  };

  const attach = async (files: FileList | null) => {
    const file = files?.[0];
    if (!file) return;
    if (!file.type.startsWith('image/')) return toast.error('Only images can be attached for now.');
    if (file.size > MAX_IMAGE_BYTES) return toast.error('That image is over 8 MB.');
    const encoded = await fileToBase64(file);
    setAttachments([{ kind: 'image', mimeType: encoded.mimeType, data: encoded.data, preview: encoded.preview, name: file.name }]);
  };

  const look = TEACHER_LOOK[teacher];
  const profile = TEACHERS[teacher];
  const userTurns = thread.messages.filter((m) => m.role === 'user').length;

  return (
    <div className="flex h-full flex-col">
      <div className="flex flex-col gap-3 border-b border-white/[0.06] px-6 py-4 lg:flex-row lg:items-center lg:justify-between">
        <div className="grid grid-cols-3 gap-2 lg:flex">
          {TEACHER_IDS.map((id) => {
            const t = TEACHERS[id];
            const l = TEACHER_LOOK[id];
            const active = id === teacher;
            return (
              <button
                key={id}
                onClick={() => setTeacher(id)}
                className={cn(
                  'group flex cursor-pointer items-center gap-3 rounded-2xl border px-3.5 py-2.5 text-left transition',
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
                {threads[id].busy && <Loader2 className="size-3.5 animate-spin text-night-400" />}
              </button>
            );
          })}
        </div>
        <div className="flex items-center gap-2">
          <Tooltip content="Start a fresh conversation with this teacher">
            <Button variant="ghost" size="sm" onClick={() => reset(teacher)} disabled={!thread.messages.length}>
              <RotateCcw /> New
            </Button>
          </Tooltip>
          <Tooltip content="The brain keeper reads this session and proposes updates to your concept pages. A validator checks every edit.">
            <Button variant="primary" size="sm" onClick={() => reflect.mutate()} loading={reflect.isPending} disabled={!userTurns || thread.busy || teacher === 'friend'}>
              {!reflect.isPending && <Brain />} {reflect.isPending ? 'Reflecting…' : 'Reflect into brain'}
            </Button>
          </Tooltip>
        </div>
      </div>

      <div ref={scroller} className="flex-1 overflow-y-auto">
        <div className="mx-auto w-full max-w-3xl px-6 py-8">
          {thread.messages.length === 0 ? (
            <TeacherIntro teacher={teacher} onPick={(p) => submit(p)} />
          ) : (
            <div className="space-y-6">
              <AnimatePresence initial={false}>
                {thread.messages.map((m) => (
                  <MessageRow
                    key={m.id}
                    message={m}
                    teacher={teacher}
                    onHandoff={(to) => {
                      const lastQuestion = [...thread.messages].reverse().find((x) => x.role === 'user');
                      setTeacher(to);
                      if (lastQuestion) setDraft(lastQuestion.content);
                    }}
                  />
                ))}
              </AnimatePresence>
            </div>
          )}
        </div>
      </div>

      <div className="border-t border-white/[0.06] px-6 py-4">
        <div className="mx-auto w-full max-w-3xl">
          {attachments.length > 0 && (
            <div className="mb-2 flex gap-2">
              {attachments.map((a) => (
                <div key={a.name} className="relative">
                  <img src={a.preview} alt={a.name} className="size-16 rounded-xl border border-white/10 object-cover" />
                  <button onClick={() => setAttachments([])} className="absolute -top-1.5 -right-1.5 grid size-5 place-items-center rounded-full bg-night-800 text-night-200 hover:bg-night-700" aria-label="Remove image">
                    <X className="size-3" />
                  </button>
                </div>
              ))}
            </div>
          )}
          <div className={cn('glass flex items-end gap-2 rounded-2xl p-2 transition focus-within:border-white/[0.14]', look.ring.replace('border-', 'focus-within:border-'))}>
            <Tooltip content="Attach a photo — a diagram, a textbook page, your handwritten working">
              <Button variant="ghost" size="icon" onClick={() => fileInput.current?.click()} aria-label="Attach image">
                <ImagePlus />
              </Button>
            </Tooltip>
            <input ref={fileInput} type="file" accept="image/*" className="hidden" onChange={(e) => { void attach(e.target.files); e.target.value = ''; }} />
            <textarea
              value={draft}
              onChange={(e) => setDraft(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter' && !e.shiftKey) {
                  e.preventDefault();
                  submit();
                }
              }}
              onPaste={(e) => {
                const file = [...e.clipboardData.files].find((f) => f.type.startsWith('image/'));
                if (file) {
                  e.preventDefault();
                  const list = new DataTransfer();
                  list.items.add(file);
                  void attach(list.files);
                }
              }}
              rows={1}
              placeholder={`Ask ${profile.voice}…`}
              className="max-h-40 min-h-10 flex-1 resize-none bg-transparent px-1 py-2 text-[14.5px] text-night-100 placeholder:text-night-500 focus:outline-none"
            />
            {thread.busy ? (
              <Button size="icon" variant="secondary" onClick={() => stop(teacher)} aria-label="Stop">
                <Square className="fill-current" />
              </Button>
            ) : (
              <Button size="icon" variant="primary" onClick={() => submit()} disabled={!draft.trim() && !attachments.length} aria-label="Send">
                <ArrowUp />
              </Button>
            )}
          </div>
          <div className="mt-2 flex items-center justify-between px-1 text-[11px] text-night-500">
            <span>{profile.scope}</span>
            {profile.needsNetwork && (
              <span className="flex items-center gap-1">
                <Wifi className="size-3" /> uses the web
              </span>
            )}
          </div>
        </div>
      </div>

      <Dialog open={Boolean(reflection)} onOpenChange={(o) => !o && setReflection(null)} title="Your brain grew" description="Proposed by the brain keeper, checked by the validator, written to markdown on this device.">
        {reflection && (
          <div className="space-y-5">
            <BrainDiff diff={reflection.diff} applied={reflection.applied} rejected={reflection.rejected} model={reflection.model} durationMs={reflection.durationMs} />
            <div className="flex justify-end gap-2">
              <Button variant="ghost" onClick={() => setReflection(null)}>
                Keep talking
              </Button>
              <Button variant="primary" onClick={() => { setReflection(null); nav.go('sky'); }}>
                See it in the sky <ArrowRight />
              </Button>
            </div>
          </div>
        )}
      </Dialog>
    </div>
  );
}

function TeacherIntro({ teacher, onPick }: { teacher: TeacherId; onPick: (prompt: string) => void }) {
  const look = TEACHER_LOOK[teacher];
  const profile = TEACHERS[teacher];
  return (
    <motion.div key={teacher} initial={{ opacity: 0, y: 8 }} animate={{ opacity: 1, y: 0 }} className="relative pt-10 text-center">
      <div className={cn('pointer-events-none absolute inset-x-0 -top-10 mx-auto h-56 w-56 rounded-full bg-gradient-radial bg-gradient-to-b to-transparent blur-3xl', look.glow)} />
      <div className={cn('relative mx-auto mb-5 grid size-16 place-items-center rounded-2xl border bg-white/[0.04]', look.ring, look.accent)}>
        <look.Icon className="size-7" />
      </div>
      <h2 className="relative font-display text-4xl text-night-100">{profile.voice}</h2>
      <p className="relative mx-auto mt-3 max-w-lg text-[15px] leading-7 text-night-400">{look.greeting}</p>
      <div className="relative mt-8 grid gap-2 sm:grid-cols-3">
        {profile.samplePrompts.map((p) => (
          <button key={p} onClick={() => onPick(p)} className="glass cursor-pointer rounded-xl p-3.5 text-left text-[13px] leading-5 text-night-300 transition hover:border-white/[0.14] hover:text-night-100">
            {p}
          </button>
        ))}
      </div>
    </motion.div>
  );
}

function MessageRow({ message, teacher, onHandoff }: { message: ChatMessage; teacher: TeacherId; onHandoff: (to: TeacherId) => void }) {
  const look = TEACHER_LOOK[teacher];
  if (message.role === 'user') {
    return (
      <motion.div initial={{ opacity: 0, y: 6 }} animate={{ opacity: 1, y: 0 }} className="flex justify-end">
        <div className="max-w-[85%] space-y-2">
          {message.attachments?.map((a) => <img key={a.name} src={a.preview} alt={a.name} className="ml-auto max-h-56 rounded-2xl border border-white/10" />)}
          {message.content && <div className="rounded-2xl rounded-br-md bg-beacon-500/20 px-4 py-2.5 text-[14.5px] leading-6 whitespace-pre-wrap text-night-100">{message.content}</div>}
        </div>
      </motion.div>
    );
  }

  const handoff = message.verification?.handoff;
  return (
    <motion.div initial={{ opacity: 0, y: 6 }} animate={{ opacity: 1, y: 0 }} className="flex gap-3">
      <span className={cn('mt-0.5 grid size-8 shrink-0 place-items-center rounded-xl border bg-white/[0.04]', look.ring, look.accent)}>
        <look.Icon className="size-4" />
      </span>
      <div className="min-w-0 flex-1">
        {message.tools && message.tools.length > 0 && message.pending && (
          <div className="mb-2 flex flex-wrap gap-1.5">
            {message.tools.map((t, i) => (
              <Badge key={i} tone="neutral" className="font-normal">
                <code className="text-aurora-300">{t.tool}</code> {t.summary}
              </Badge>
            ))}
          </div>
        )}
        {message.error ? (
          <div className="rounded-xl border border-rose-400/25 bg-rose-400/[0.07] px-4 py-3 text-sm text-rose-400">{message.error}</div>
        ) : message.content ? (
          <Markdown variant="chat">{message.content + (message.pending ? ' ▍' : '')}</Markdown>
        ) : (
          <div className="flex items-center gap-2 py-1.5 text-sm text-night-400">
            <span className="flex gap-1">
              {[0, 1, 2].map((i) => (
                <motion.span key={i} className="size-1.5 rounded-full bg-night-400" animate={{ opacity: [0.3, 1, 0.3] }} transition={{ duration: 1.2, repeat: Infinity, delay: i * 0.2 }} />
              ))}
            </span>
            {message.status ?? 'Thinking…'}
          </div>
        )}
        {handoff && (
          <button
            onClick={() => onHandoff(handoff.to)}
            className="mt-3 flex cursor-pointer items-center gap-2 rounded-xl border border-white/[0.08] bg-white/[0.03] px-3 py-2 text-[13px] text-night-200 transition hover:border-white/[0.16]"
          >
            {(() => {
              const L = TEACHER_LOOK[handoff.to];
              return <L.Icon className={cn('size-4', L.accent)} />;
            })()}
            Continue with the {TEACHERS[handoff.to].name}
            <ArrowRight className="size-3.5 text-night-500" />
          </button>
        )}
        {message.verification && <VerificationPanel verification={message.verification} />}
      </div>
    </motion.div>
  );
}
