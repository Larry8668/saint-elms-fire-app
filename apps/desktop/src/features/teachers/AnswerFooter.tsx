import type { SourceRef } from '@sef/shared';
import { BookOpen, Brain, Check, Copy, Globe, LifeBuoy, RotateCcw, Telescope } from 'lucide-react';
import { useState, type ReactNode } from 'react';
import { toast } from 'sonner';
import { Tooltip } from '@/components/ui/overlays';
import { cn } from '@/lib/cn';
import { log } from '@/lib/log';

const SOURCE_STYLE: Record<SourceRef['kind'], { Icon: typeof BookOpen; tone: string }> = {
  lesson: { Icon: BookOpen, tone: 'text-beacon-300' },
  brain: { Icon: Brain, tone: 'text-gold-300' },
  web: { Icon: Globe, tone: 'text-aurora-300' },
  support: { Icon: LifeBuoy, tone: 'text-ember-300' },
};

const hostOf = (url: string) => {
  try {
    return new URL(url).hostname.replace(/^www\./, '');
  } catch {
    return url;
  }
};

/** Inline citations: lessons, brain pages and web results the answer actually drew on. */
export function SourceChips({ sources, max = 5 }: { sources: SourceRef[]; max?: number }) {
  if (!sources.length) return null;
  const shown = sources.slice(0, max);
  return (
    <div className="mt-3 flex flex-wrap gap-1.5">
      {shown.map((s) => {
        const { Icon, tone } = SOURCE_STYLE[s.kind];
        const body = (
          <>
            <Icon className={cn('size-3 shrink-0', tone)} />
            <span className="max-w-52 truncate">{s.title}</span>
            {s.url && <span className="text-night-500">{hostOf(s.url)}</span>}
          </>
        );
        const cls = 'inline-flex items-center gap-1.5 rounded-full border border-white/[0.07] bg-white/[0.03] px-2.5 py-1 text-[11.5px] text-night-300 transition';
        return s.url ? (
          <a key={`${s.kind}:${s.id}`} href={s.url} target="_blank" rel="noreferrer" className={cn(cls, 'hover:border-white/[0.16] hover:text-night-100')}>
            {body}
          </a>
        ) : (
          <span key={`${s.kind}:${s.id}`} className={cls}>
            {body}
          </span>
        );
      })}
      {sources.length > max && <span className="self-center px-1 text-[11.5px] text-night-500">+{sources.length - max} more</span>}
    </div>
  );
}

/** The Philosopher's closing question, offered as the next thing to explore. */
export function TrailheadCard({ question, onExplore }: { question: string; onExplore: (q: string) => void }) {
  return (
    <button
      onClick={() => onExplore(question)}
      className="group mt-4 flex w-full cursor-pointer items-start gap-3 rounded-xl border border-aurora-400/20 bg-aurora-500/[0.06] px-3.5 py-3 text-left transition hover:border-aurora-400/40 hover:bg-aurora-500/[0.1]"
    >
      <Telescope className="mt-0.5 size-4 shrink-0 text-aurora-300" />
      <span className="min-w-0">
        <span className="block text-[10.5px] font-semibold tracking-[0.16em] text-aurora-300/80 uppercase">Trailhead</span>
        <span className="mt-0.5 block text-[14px] leading-6 text-night-100">{question}</span>
      </span>
      <span className="ml-auto self-center text-[11.5px] whitespace-nowrap text-night-500 transition group-hover:text-aurora-300">Explore →</span>
    </button>
  );
}

function ActionButton({ label, onClick, children }: { label: string; onClick: () => void; children: ReactNode }) {
  return (
    <Tooltip content={label}>
      <button onClick={onClick} aria-label={label} className="grid size-7 cursor-pointer place-items-center rounded-lg text-night-500 transition hover:bg-white/[0.06] hover:text-night-200 [&_svg]:size-3.5">
        {children}
      </button>
    </Tooltip>
  );
}

/** Copy / retry, plus one-tap follow-ups. Only the latest answer gets retry and follow-ups. */
export function AnswerActions({ content, onRetry, followUps, onFollowUp }: { content: string; onRetry?: () => void; followUps?: string[]; onFollowUp?: (text: string) => void }) {
  const [copied, setCopied] = useState(false);
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(content);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1400);
    } catch (error) {
      log.warn('copy_failed', { error: String(error) });
      toast.error('Could not copy to the clipboard.');
    }
  };

  return (
    <div className="mt-2 flex flex-wrap items-center gap-1">
      <ActionButton label={copied ? 'Copied' : 'Copy answer'} onClick={() => void copy()}>
        {copied ? <Check className="text-aurora-400" /> : <Copy />}
      </ActionButton>
      {onRetry && (
        <ActionButton label="Ask again" onClick={onRetry}>
          <RotateCcw />
        </ActionButton>
      )}
      {followUps && onFollowUp && followUps.length > 0 && (
        <div className="ml-1 flex flex-wrap gap-1.5">
          {followUps.map((f) => (
            <button
              key={f}
              onClick={() => onFollowUp(f)}
              className="cursor-pointer rounded-full border border-white/[0.08] px-2.5 py-1 text-[11.5px] text-night-300 transition hover:border-beacon-400/40 hover:bg-beacon-500/10 hover:text-night-100"
            >
              {f}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
