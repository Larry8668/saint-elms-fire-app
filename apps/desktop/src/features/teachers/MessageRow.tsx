import { TEACHERS, type TeacherId } from '@sef/shared';
import { AlertCircle, ArrowRight, CircleSlash, ImageIcon } from 'lucide-react';
import { motion } from 'motion/react';
import { Markdown } from '@/components/Markdown';
import { Skeleton, SkeletonText } from '@/components/ui/primitives';
import { cn } from '@/lib/cn';
import { AnswerActions, SourceChips, TrailheadCard } from './AnswerFooter';
import { QUICK_REPLIES, splitTrailhead, uniqueSources } from './answer-parts';
import type { ChatMessage } from './chat-store';
import { TEACHER_LOOK } from './teacher-meta';
import { ThoughtTrace } from './ThoughtTrace';
import { VerificationPanel } from './VerificationPanel';

const enter = { initial: { opacity: 0, y: 6 }, animate: { opacity: 1, y: 0 }, transition: { duration: 0.22, ease: 'easeOut' } } as const;

/** Placeholder while a saved conversation is read from the engine. */
export function ThreadSkeleton() {
  return (
    <div className="space-y-7" aria-busy>
      {[0, 1].map((i) => (
        <div key={i} className="space-y-7">
          <div className="flex justify-end">
            <Skeleton className={cn('h-10 rounded-2xl rounded-br-md', i ? 'w-1/3' : 'w-1/2')} />
          </div>
          <div className="flex gap-3">
            <Skeleton className="size-8 shrink-0 rounded-xl" />
            <SkeletonText lines={i ? 3 : 4} className="flex-1 pt-1.5" />
          </div>
        </div>
      ))}
    </div>
  );
}

export function UserMessage({ message }: { message: ChatMessage }) {
  return (
    <motion.div {...enter} className="flex justify-end">
      <div className="flex max-w-[85%] flex-col items-end gap-2">
        {message.attachments?.map((a) => (
          <figure key={a.name} className="overflow-hidden rounded-2xl border border-white/10">
            <img src={a.preview} alt={a.name} className="max-h-56" />
            <figcaption className="flex items-center gap-1.5 bg-black/40 px-2.5 py-1 text-[11px] text-night-400">
              <ImageIcon className="size-3" /> read on this device
            </figcaption>
          </figure>
        ))}
        {!message.attachments?.length && Boolean(message.images) && (
          <span className="inline-flex items-center gap-1.5 rounded-full border border-white/[0.07] px-2.5 py-1 text-[11px] text-night-500">
            <ImageIcon className="size-3" /> {message.images === 1 ? 'An image was' : `${message.images} images were`} sent (not stored)
          </span>
        )}
        {message.content && (
          <div className="rounded-2xl rounded-br-md border border-beacon-400/15 bg-beacon-500/[0.14] px-4 py-2.5 text-[14.5px] leading-6 whitespace-pre-wrap text-night-100">{message.content}</div>
        )}
      </div>
    </motion.div>
  );
}

interface AssistantMessageProps {
  message: ChatMessage;
  teacher: TeacherId;
  isLatest: boolean;
  onHandoff: (to: TeacherId) => void;
  onRetry: () => void;
  onFollowUp: (text: string) => void;
  /** Freeze this answer as a source and draft it into a proposal — the student decides the rest. */
  onSave?: () => void;
  saving?: boolean;
}

export function AssistantMessage({ message, teacher, isLatest, onHandoff, onRetry, onFollowUp, onSave, saving }: AssistantMessageProps) {
  const look = TEACHER_LOOK[teacher];
  const settled = !message.pending;
  const { body, trailhead } = settled ? splitTrailhead(message.content) : { body: message.content, trailhead: undefined };
  const handoff = message.verification?.handoff;
  const sources = uniqueSources(message.verification?.sources ?? []);
  const canAct = settled && !message.error && Boolean(message.content);

  return (
    <motion.div {...enter} className="group/msg flex gap-3">
      <span className={cn('mt-0.5 grid size-8 shrink-0 place-items-center rounded-xl border bg-white/[0.04]', look.ring, look.accent)}>
        <look.Icon className="size-4" />
      </span>
      <div className="min-w-0 flex-1">
        <ThoughtTrace message={message} accent={look.accent} />

        {message.error ? (
          <div className="flex items-start gap-2.5 rounded-xl border border-rose-400/25 bg-rose-400/[0.07] px-4 py-3 text-sm text-rose-400">
            <AlertCircle className="mt-0.5 size-4 shrink-0" />
            <div className="min-w-0">
              <p>{message.error}</p>
              {isLatest && (
                <button onClick={onRetry} className="mt-1.5 cursor-pointer text-[12.5px] text-night-300 underline decoration-white/20 underline-offset-2 hover:text-night-100">
                  Try again
                </button>
              )}
            </div>
          </div>
        ) : message.content ? (
          <div className={cn(message.pending && 'stream-caret')}>
            <Markdown variant="chat">{body}</Markdown>
          </div>
        ) : message.pending ? (
          <SkeletonText lines={3} className="max-w-md pt-1.5 opacity-70" />
        ) : null}

        {message.stopped && (
          <p className="mt-2 flex items-center gap-1.5 text-[12px] text-night-500">
            <CircleSlash className="size-3" /> Stopped
          </p>
        )}

        {trailhead && <TrailheadCard question={trailhead} onExplore={onFollowUp} />}
        {settled && <SourceChips sources={sources} />}

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

        {canAct && (
          <AnswerActions
            content={message.content}
            onRetry={isLatest ? onRetry : undefined}
            onSave={onSave}
            saving={saving}
            followUps={isLatest && !handoff ? QUICK_REPLIES[teacher] : undefined}
            onFollowUp={onFollowUp}
          />
        )}
        {message.verification && <VerificationPanel verification={message.verification} />}
      </div>
    </motion.div>
  );
}
