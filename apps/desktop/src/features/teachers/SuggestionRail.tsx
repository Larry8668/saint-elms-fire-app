import type { TeacherId } from '@sef/shared';
import { Lightbulb, X } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import { Skeleton } from '@/components/ui/primitives';
import { Tooltip } from '@/components/ui/overlays';
import { cn } from '@/lib/cn';
import { log } from '@/lib/log';
import { metrics, useReportShown } from '@/lib/metrics';
import { useSuggestions } from '@/lib/queries';
import { railState, readHidden, whyText, writeHidden } from './suggestions';

const storage = (): Storage | undefined => {
  try {
    return window.localStorage;
  } catch {
    return undefined;
  }
};

/**
 * Ready-to-click questions above the composer. A click sends the text as the student's own
 * message through the ordinary turn — no suggestion ever posts by itself.
 */
export function SuggestionRail({ teacher, busy, onPick }: { teacher: TeacherId; busy: boolean; onPick: (text: string) => void }) {
  const query = useSuggestions(teacher);
  const [hidden, setHidden] = useState(() => readHidden(storage()));
  const wasBusy = useRef(busy);
  const { refetch, isError, error } = query;

  // A finished turn can change what is novel, so the bank is re-read once the answer lands.
  useEffect(() => {
    if (wasBusy.current && !busy) void refetch();
    wasBusy.current = busy;
  }, [busy, refetch]);

  useEffect(() => {
    if (isError) log.warn('suggestions_unavailable', { teacher, error: (error as Error).message });
  }, [isError, error, teacher]);

  const toggle = (next: boolean) => {
    setHidden(next);
    writeHidden(storage(), next);
  };

  const state = railState({ pending: query.isPending, data: query.data, hidden });
  useReportShown('suggestion_shown', state.kind === 'ready' ? state.questions.map((q) => ({ ref: q.id, tag: teacher })) : [], state.kind === 'ready');

  if (state.kind === 'hidden') {
    return (
      <button onClick={() => toggle(false)} className="mb-2 flex cursor-pointer items-center gap-1.5 text-[11.5px] text-night-500 transition hover:text-night-300">
        <Lightbulb className="size-3" /> Show suggestions
      </button>
    );
  }
  if (state.kind === 'loading') {
    return (
      <div className="mb-3 flex gap-2" aria-hidden>
        {['w-44', 'w-56', 'w-36'].map((w) => (
          <Skeleton key={w} className={cn('h-7 rounded-full', w)} />
        ))}
      </div>
    );
  }
  if (state.kind === 'empty') return null;

  return (
    <div className="mb-3 flex items-start gap-2">
      <ul aria-label="Suggested questions" className="flex min-w-0 flex-1 flex-wrap gap-2">
        {state.questions.map((q) => (
          <li key={q.id}>
            <Tooltip content={whyText(q, state.worded)}>
              <button
                onClick={() => {
                  metrics.report('suggestion_sent', q.id, teacher);
                  onPick(q.text);
                }}
                disabled={busy}
                className={cn(
                  'glass max-w-full cursor-pointer truncate rounded-full px-3 py-1.5 text-left text-[12.5px] text-night-300 transition',
                  'hover:border-white/[0.14] hover:text-night-100 disabled:cursor-not-allowed disabled:opacity-50',
                )}
              >
                {q.text}
              </button>
            </Tooltip>
          </li>
        ))}
      </ul>
      <Tooltip content="Hide suggestions">
        <button onClick={() => toggle(true)} aria-label="Hide suggestions" className="mt-1 cursor-pointer rounded-md p-1 text-night-600 transition hover:text-night-300">
          <X className="size-3.5" />
        </button>
      </Tooltip>
    </div>
  );
}
