import { ChevronRight, CircleDot, Wrench } from 'lucide-react';
import { AnimatePresence, motion } from 'motion/react';
import { useState } from 'react';
import { formatSeconds, useElapsed, WorkingLabel } from '@/components/ui/loading';
import { cn } from '@/lib/cn';
import type { ChatMessage } from './chat-store';

const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? '' : 's'}`;

/**
 * What the teacher did before and while answering. Open while it is working with nothing to read yet,
 * folds itself away once the answer starts streaming, and stays one click away afterwards.
 */
export function ThoughtTrace({ message, accent }: { message: ChatMessage; accent: string }) {
  const [userOpen, setUserOpen] = useState<boolean | null>(null);
  const steps = message.trace ?? [];
  const working = Boolean(message.pending && !message.content);
  const open = userOpen ?? working;
  const tools = steps.filter((s) => s.kind === 'tool').length;
  const doneAt = message.firstTokenAt ?? message.finishedAt;
  const seconds = useElapsed(message.startedAt, doneAt, working);

  if (!working && steps.length === 0) return null;

  const latest = steps.at(-1);
  const workingLabel = latest ? (latest.kind === 'tool' ? `Using ${latest.label}` : latest.label) : 'Thinking';

  return (
    <div className="mb-2.5">
      <button onClick={() => setUserOpen(!open)} className="group flex cursor-pointer items-center gap-1.5 rounded-lg py-0.5 text-left" aria-expanded={open}>
        {working ? (
          <WorkingLabel label={workingLabel} startedAt={message.startedAt} className={accent} />
        ) : (
          <span className="text-[12.5px] text-night-400 transition group-hover:text-night-200">
            Worked for {formatSeconds(seconds)}
            {steps.length > 0 && <span className="text-night-500"> · {plural(steps.length - tools, 'step')}{tools > 0 && ` · ${plural(tools, 'tool call')}`}</span>}
          </span>
        )}
        {steps.length > 0 && <ChevronRight className={cn('size-3.5 text-night-500 transition', open && 'rotate-90')} />}
      </button>

      <AnimatePresence initial={false}>
        {open && steps.length > 0 && (
          <motion.ol
            initial={{ height: 0, opacity: 0 }}
            animate={{ height: 'auto', opacity: 1 }}
            exit={{ height: 0, opacity: 0 }}
            transition={{ duration: 0.2, ease: 'easeOut' }}
            className="relative ml-[6px] overflow-hidden border-l border-white/[0.08] pl-4"
          >
            {steps.map((step, i) => (
              <motion.li key={i} initial={{ opacity: 0, x: -4 }} animate={{ opacity: 1, x: 0 }} className="flex items-start gap-2 py-1 text-[12.5px] first:pt-2 last:pb-1">
                {step.kind === 'tool' ? (
                  <>
                    <Wrench className="mt-0.5 size-3 shrink-0 text-night-500" />
                    <span className="min-w-0">
                      <code className="rounded-md border border-white/[0.07] bg-white/[0.04] px-1.5 py-px font-mono text-[11.5px] text-aurora-300">{step.label}</code>
                      {step.detail && <span className="ml-1.5 text-night-400">{step.detail}</span>}
                    </span>
                  </>
                ) : (
                  <>
                    <CircleDot className="mt-0.5 size-3 shrink-0 text-night-500" />
                    <span className="text-night-400">{step.label}</span>
                  </>
                )}
                {message.startedAt && <span className="ml-auto shrink-0 pl-3 font-mono text-[10.5px] text-night-600 tabular-nums">+{formatSeconds((step.at - message.startedAt) / 1000)}</span>}
              </motion.li>
            ))}
          </motion.ol>
        )}
      </AnimatePresence>
    </div>
  );
}
