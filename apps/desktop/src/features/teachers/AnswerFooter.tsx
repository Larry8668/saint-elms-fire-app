import type { SourceRef } from '@sef/shared';
import { ArrowRight, BookOpen, Brain, CalendarClock, Check, ChevronDown, Copy, ExternalLink, Globe, LifeBuoy, RotateCcw, Telescope } from 'lucide-react';
import { AnimatePresence, motion } from 'motion/react';
import { useState, type ReactNode } from 'react';
import { toast } from 'sonner';
import { Markdown } from '@/components/Markdown';
import { Button } from '@/components/ui/button';
import { Tooltip } from '@/components/ui/overlays';
import { cn } from '@/lib/cn';
import { log } from '@/lib/log';
import { useNav } from '@/lib/nav';
import { safeHref } from '@/lib/url';

const SOURCE_STYLE: Record<SourceRef['kind'], { Icon: typeof BookOpen; tone: string }> = {
  lesson: { Icon: BookOpen, tone: 'text-beacon-300' },
  brain: { Icon: Brain, tone: 'text-gold-300' },
  web: { Icon: Globe, tone: 'text-aurora-300' },
  support: { Icon: LifeBuoy, tone: 'text-ember-300' },
  logistics: { Icon: CalendarClock, tone: 'text-rose-300' },
};

const hostOf = (url: string) => {
  try {
    return new URL(url).hostname.replace(/^www\./, '');
  } catch {
    return url;
  }
};

const sourceKey = (s: SourceRef) => `${s.kind}:${s.id}`;
const isLessonLike = (s: SourceRef) => s.kind === 'lesson' || s.kind === 'support';
const CHIP = 'inline-flex max-w-full items-center gap-1.5 rounded-full border px-2.5 py-1 text-[11.5px] transition';

function SourceChip({ source, expanded, muted, onToggle }: { source: SourceRef; expanded: boolean; muted?: boolean; onToggle: () => void }) {
  const { go } = useNav();
  const { Icon, tone } = SOURCE_STYLE[source.kind];
  const cls = cn(
    CHIP,
    expanded ? 'border-beacon-400/40 bg-beacon-500/10 text-night-100' : 'border-white/[0.07] bg-white/[0.03] text-night-300 hover:border-white/[0.16] hover:text-night-100',
    muted && !expanded && 'opacity-60 hover:opacity-100',
  );
  const href = safeHref(source.url);
  const body = (
    <>
      <Icon className={cn('size-3 shrink-0', tone)} />
      <span className="max-w-52 truncate">{source.title}</span>
      {href && <span className="text-night-500">{hostOf(href)}</span>}
    </>
  );
  if (href) {
    return (
      <a href={href} target="_blank" rel="noreferrer" className={cls}>
        {body}
        <ExternalLink className="size-2.5 text-night-500" />
      </a>
    );
  }
  if (source.kind === 'brain') {
    return (
      <Tooltip content="Your own page for this concept. Opens its star in the sky.">
        <button onClick={() => go('sky', { conceptKey: source.id })} className={cn(cls, 'cursor-pointer')}>
          {body}
        </button>
      </Tooltip>
    );
  }
  if (source.kind === 'logistics') {
    return (
      <Tooltip content="A confirmed record from your private logistics. Opens the ledger.">
        <button onClick={() => go('logistics')} className={cn(cls, 'cursor-pointer')}>
          {body}
        </button>
      </Tooltip>
    );
  }
  return (
    <button onClick={onToggle} aria-expanded={expanded} className={cn(cls, 'cursor-pointer')}>
      {body}
      <ChevronDown className={cn('size-3 text-night-500 transition', expanded && 'rotate-180')} />
    </button>
  );
}

/** The passage of a lesson the answer drew on, with a jump to that section of the lesson. */
function LessonSourcePreview({ source }: { source: SourceRef }) {
  const { go } = useNav();
  return (
    <motion.div initial={{ opacity: 0, height: 0 }} animate={{ opacity: 1, height: 'auto' }} exit={{ opacity: 0, height: 0 }} transition={{ duration: 0.18 }} className="overflow-hidden">
      <div className="mt-2 rounded-xl border border-white/[0.07] bg-black/25 p-3.5">
        <div className="flex flex-wrap items-center gap-x-2 gap-y-1 text-[11.5px] text-night-500">
          {source.courseName && <span>{source.courseName}</span>}
          {source.section && (
            <>
              <span>›</span>
              <span className="text-night-300">{source.section.heading}</span>
            </>
          )}
          <span className={cn('ml-auto rounded-full px-2 py-px text-[10.5px] font-medium', source.cited ? 'bg-aurora-500/15 text-aurora-300' : 'bg-white/[0.06] text-night-400')}>
            {source.cited ? 'used in this answer' : 'retrieved, not used'}
          </span>
        </div>
        {source.excerpt ? (
          <div className="mt-2 border-l-2 border-beacon-400/30 pl-3 text-[13px]">
            <Markdown variant="chat" className="text-[13px] leading-6 text-night-300">
              {source.excerpt}
            </Markdown>
          </div>
        ) : (
          <p className="mt-2 text-[12.5px] text-night-500">No passage preview for this source.</p>
        )}
        <Button
          size="sm"
          variant="outline"
          className="mt-3"
          onClick={() => go('library', { lessonId: source.id, section: source.section?.index, sectionHeading: source.section?.heading })}
        >
          <BookOpen /> {source.section ? 'Open at this section' : 'Open lesson'} <ArrowRight />
        </Button>
      </div>
    </motion.div>
  );
}

/**
 * Citations under an answer. Lessons the answer measurably drew on are shown up front; lessons that were
 * retrieved but not used sit behind a toggle so the student can still see everything the teacher looked at.
 */
export function SourceChips({ sources }: { sources: SourceRef[] }) {
  const [expanded, setExpanded] = useState<string | null>(null);
  const [showUnused, setShowUnused] = useState(false);
  if (!sources.length) return null;

  const primary = sources.filter((s) => !isLessonLike(s) || s.cited !== false);
  const unused = sources.filter((s) => isLessonLike(s) && s.cited === false);
  const open = sources.find((s) => sourceKey(s) === expanded);
  const toggle = (s: SourceRef) => setExpanded((k) => (k === sourceKey(s) ? null : sourceKey(s)));

  return (
    <div className="mt-3">
      <div className="flex flex-wrap items-center gap-1.5">
        {primary.map((s) => (
          <SourceChip key={sourceKey(s)} source={s} expanded={expanded === sourceKey(s)} onToggle={() => toggle(s)} />
        ))}
        {showUnused && unused.map((s) => <SourceChip key={sourceKey(s)} source={s} muted expanded={expanded === sourceKey(s)} onToggle={() => toggle(s)} />)}
        {unused.length > 0 && (
          <Tooltip content="Lessons the teacher retrieved but the answer did not draw on">
            <button onClick={() => setShowUnused((v) => !v)} className="cursor-pointer px-1.5 text-[11.5px] text-night-500 hover:text-night-300">
              {showUnused ? 'hide unused' : `+${unused.length} also retrieved`}
            </button>
          </Tooltip>
        )}
      </div>
      <AnimatePresence initial={false}>{open && isLessonLike(open) && <LessonSourcePreview key={sourceKey(open)} source={open} />}</AnimatePresence>
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
