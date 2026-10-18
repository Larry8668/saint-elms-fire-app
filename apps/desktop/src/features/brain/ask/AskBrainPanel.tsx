import { BookmarkPlus, Brain, CircleAlert, Loader2, Search, Sparkles, X } from 'lucide-react';
import { motion } from 'motion/react';
import { useEffect, useMemo, useReducer, useRef, useState } from 'react';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';
import { Badge, Panel } from '@/components/ui/primitives';
import { ProposalReviewDialog } from '@/features/contribute/ProposalReviewDialog';
import { streamWikiAsk } from '@/lib/api';
import { cn } from '@/lib/cn';
import { log } from '@/lib/log';
import { useSaveAskToWiki } from '@/lib/queries';
import { answerParts, askReducer, highlightedPageIds, initialAsk } from './ask-brain';

export type SearchMode = 'search' | 'ask';

/** The "Search | Ask" switch that sits beside a search input. */
export function AskModeToggle({ mode, onChange, className }: { mode: SearchMode; onChange: (mode: SearchMode) => void; className?: string }) {
  return (
    <span role="radiogroup" aria-label="Search or ask your brain" className={cn('inline-flex shrink-0 rounded-xl border border-white/[0.08] bg-black/25 p-0.5', className)}>
      {(
        [
          { value: 'search', label: 'Search', Icon: Search },
          { value: 'ask', label: 'Ask', Icon: Sparkles },
        ] as const
      ).map(({ value, label, Icon }) => (
        <button
          key={value}
          type="button"
          role="radio"
          aria-checked={mode === value}
          onClick={() => onChange(value)}
          className={cn(
            'inline-flex h-8 cursor-pointer items-center gap-1.5 rounded-[10px] px-3 text-[12.5px] font-medium transition',
            mode === value ? 'bg-beacon-500/25 text-beacon-100' : 'text-night-400 hover:text-night-200',
          )}
        >
          <Icon className="size-3.5" /> {label}
        </button>
      ))}
    </span>
  );
}

/** One submitted question; a new nonce re-asks the same words. */
export interface AskRequest {
  question: string;
  nonce: number;
}

/**
 * The answer area under the Brain search box when "Ask" is on. It streams one answer
 * composed only from the student's own pages, numbers each [[page]] citation, says so when
 * the pages don't cover the question, and offers "Save to wiki" — which files the answer
 * as a source and opens the proposal; nothing is written until the student accepts.
 */
export function AskBrainPanel({
  request,
  onOpenPage,
  onHighlight,
  onClose,
}: {
  request: AskRequest | null;
  onOpenPage: (pageId: string) => void;
  /** Pages to light up in a visualization: what was read, then what was cited. */
  onHighlight?: (pageIds: string[]) => void;
  onClose?: () => void;
}) {
  const [state, dispatch] = useReducer(askReducer, initialAsk);
  const [proposalId, setProposalId] = useState<string | null>(null);
  const [savedAskId, setSavedAskId] = useState<string | null>(null);
  const save = useSaveAskToWiki();
  const highlight = useRef(onHighlight);
  highlight.current = onHighlight;

  useEffect(() => {
    if (!request) return;
    const abort = new AbortController();
    dispatch({ type: 'start', question: request.question });
    setSavedAskId(null);
    streamWikiAsk(request.question, (event) => dispatch({ type: 'event', event }), abort.signal).catch((error: unknown) => {
      log.warn('wiki_ask_stream_failed', { error: String(error) });
      dispatch({ type: 'fail', message: 'The answer could not be read. Try asking again.' });
    });
    return () => abort.abort();
  }, [request]);

  const highlighted = useMemo(() => highlightedPageIds(state).join('|'), [state]);
  useEffect(() => {
    highlight.current?.(highlighted ? highlighted.split('|') : []);
  }, [highlighted]);

  const known = useMemo(() => new Set(state.pagesRead.map((p) => p.pageId)), [state.pagesRead]);
  const citations = state.result?.citations ?? [];
  const parts = useMemo(() => answerParts(state.text, citations.length ? citations : state.pagesRead, known), [state.text, citations, state.pagesRead, known]);
  const numbered = useMemo(() => {
    const seen = new Map<string, number>();
    for (const part of parts) if (part.kind === 'cite' && !seen.has(part.pageId)) seen.set(part.pageId, part.n);
    return seen;
  }, [parts]);

  if (state.phase === 'idle') return null;

  const result = state.result;
  const answered = result?.outcome === 'answered';
  const honest = result && result.outcome !== 'answered';
  const asking = state.phase === 'asking';

  const onSave = () => {
    if (!result?.askId) return;
    save.mutate(result.askId, {
      onSuccess: (compiled) => {
        setSavedAskId(result.askId);
        if (compiled.job.stage === 'awaiting_review' && compiled.proposalId) setProposalId(compiled.proposalId);
        else if (compiled.job.stage === 'no_changes') toast.info('The answer is kept as a source, but the keeper found nothing new to write from it.');
        else if (compiled.job.stage === 'failed') toast.error(compiled.job.error ?? 'The saved answer could not be drafted. It is kept under Add to my wiki for a retry.');
      },
    });
  };

  return (
    <motion.div initial={{ opacity: 0, y: 6 }} animate={{ opacity: 1, y: 0 }} aria-live="polite" data-testid="ask-brain-panel">
      <Panel className="p-5">
        <div className="mb-3 flex items-start gap-3">
          <span className="mt-0.5 grid size-8 shrink-0 place-items-center rounded-lg bg-beacon-500/15 text-beacon-300">
            <Brain className="size-4" />
          </span>
          <div className="min-w-0 flex-1">
            <div className="text-[11.5px] tracking-wide text-night-500 uppercase">Asked your brain</div>
            <div className="text-[14.5px] font-medium text-night-100">{state.question}</div>
          </div>
          {onClose && (
            <button type="button" onClick={onClose} aria-label="Close the answer" className="cursor-pointer rounded-lg p-1.5 text-night-500 hover:bg-white/[0.06] hover:text-night-200">
              <X className="size-4" />
            </button>
          )}
        </div>

        {asking && state.status && (
          <div className="mb-2 flex items-center gap-2 text-[12.5px] text-night-400">
            <Loader2 className="size-3.5 animate-spin" /> {state.status}
          </div>
        )}

        {state.phase === 'error' && (
          <div className="flex items-start gap-2 rounded-xl border border-ember-400/25 bg-ember-500/10 p-3 text-[13.5px] leading-6 text-ember-200">
            <CircleAlert className="mt-1 size-4 shrink-0" /> {state.error}
          </div>
        )}

        {state.text && (
          <p className={cn('text-[14.5px] leading-7 whitespace-pre-wrap', honest ? 'text-night-300' : 'text-night-100')} data-testid="ask-brain-answer">
            {parts.map((part, i) =>
              part.kind === 'text' ? (
                <span key={i}>{part.text}</span>
              ) : (
                <button
                  key={i}
                  type="button"
                  onClick={() => onOpenPage(part.pageId)}
                  title={part.title}
                  className="mx-0.5 inline-flex cursor-pointer items-center rounded-md bg-beacon-500/15 px-1.5 align-[1px] text-[11px] leading-5 font-semibold text-beacon-200 hover:bg-beacon-500/30"
                >
                  {part.n}
                </button>
              ),
            )}
            {asking && <span className="ml-0.5 inline-block h-4 w-1.5 animate-pulse rounded-sm bg-beacon-300/70 align-middle" />}
          </p>
        )}

        {answered && citations.length > 0 && (
          <div className="mt-4">
            <div className="mb-1.5 text-[11.5px] tracking-wide text-night-500 uppercase">From your pages</div>
            <ol className="space-y-1">
              {citations.map((page) => (
                <li key={page.pageId}>
                  <button type="button" onClick={() => onOpenPage(page.pageId)} className="flex cursor-pointer items-center gap-2 text-left text-[13px] text-night-200 hover:text-beacon-200">
                    <span className="grid size-5 shrink-0 place-items-center rounded-md bg-beacon-500/15 text-[11px] font-semibold text-beacon-200">{numbered.get(page.pageId) ?? '·'}</span>
                    <span className="truncate">{page.title}</span>
                    {page.generated && <Badge>saved note, not evidence</Badge>}
                  </button>
                </li>
              ))}
            </ol>
          </div>
        )}

        {result && (
          <div className="mt-4 flex flex-wrap items-center gap-x-3 gap-y-2 border-t border-white/[0.06] pt-3 text-[11.5px] text-night-500">
            <span>
              Searched {result.pagesSearched} page{result.pagesSearched === 1 ? '' : 's'}
              {result.pagesRead.length > 0 && `, read ${result.pagesRead.length}`}
              {result.searchMode === 'keyword_only' && ' (keyword search only)'}
            </span>
            {result.model && <span>· {result.model}</span>}
            <span>· from your own notes, not course material</span>
            {answered && citations.length === 0 && <Badge tone="ember">no citation survived the check</Badge>}
            {result.droppedCitations.length > 0 && (
              <span title={result.droppedCitations.join(', ')}>
                · {result.droppedCitations.length} unsupported citation{result.droppedCitations.length === 1 ? '' : 's'} removed
              </span>
            )}
            {answered && result.askId && (
              <Button size="sm" variant={savedAskId === result.askId ? 'ghost' : 'primary'} className="ml-auto" loading={save.isPending} disabled={savedAskId === result.askId} onClick={onSave}>
                <BookmarkPlus /> {savedAskId === result.askId ? 'Saved — review the proposal' : 'Save to wiki'}
              </Button>
            )}
          </div>
        )}
      </Panel>
      <ProposalReviewDialog proposalId={proposalId} onClose={() => setProposalId(null)} />
    </motion.div>
  );
}
