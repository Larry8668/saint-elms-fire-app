import type { WikiAskPage, WikiAskResult, WikiAskStreamEvent } from '@sef/shared';

/**
 * "Ask your brain" client state, kept pure so it can be tested without a DOM: the SSE
 * frame splitter, the reducer the panel folds stream events into, and the answer split
 * into prose and [[page-id]] citations for rendering.
 */

export type AskPhase = 'idle' | 'asking' | 'done' | 'error';

export interface AskState {
  phase: AskPhase;
  question: string;
  status: string | null;
  /** Streamed, citation-checked text; replaced wholesale by the done answer. */
  text: string;
  pagesRead: WikiAskPage[];
  result: WikiAskResult | null;
  error: string | null;
}

export const initialAsk: AskState = { phase: 'idle', question: '', status: null, text: '', pagesRead: [], result: null, error: null };

export type AskAction = { type: 'start'; question: string } | { type: 'event'; event: WikiAskStreamEvent } | { type: 'fail'; message: string } | { type: 'reset' };

export function askReducer(state: AskState, action: AskAction): AskState {
  switch (action.type) {
    case 'start':
      return { ...initialAsk, phase: 'asking', question: action.question, status: 'Searching your pages…' };
    case 'reset':
      return initialAsk;
    case 'fail':
      return { ...state, phase: 'error', status: null, error: action.message };
    case 'event': {
      const event = action.event;
      if (state.phase !== 'asking') return state;
      switch (event.type) {
        case 'status':
          return { ...state, status: event.message };
        case 'pages':
          return { ...state, pagesRead: event.pages };
        case 'delta':
          return { ...state, text: state.text + event.text };
        case 'done':
          return { ...state, phase: 'done', status: null, text: event.result.answer, pagesRead: event.result.pagesRead, result: event.result };
        case 'error':
          return { ...state, phase: 'error', status: null, error: event.message };
      }
    }
  }
  return state;
}

/** Splits a buffer of SSE text into complete JSON frames plus the unfinished remainder. */
export function splitFrames(buffer: string): { frames: WikiAskStreamEvent[]; rest: string } {
  const frames: WikiAskStreamEvent[] = [];
  let rest = buffer;
  let boundary: number;
  while ((boundary = rest.indexOf('\n\n')) >= 0) {
    const frame = rest.slice(0, boundary);
    rest = rest.slice(boundary + 2);
    const data = frame
      .split('\n')
      .filter((line) => line.startsWith('data:'))
      .map((line) => line.slice(5).trimStart())
      .join('\n');
    if (!data) continue;
    try {
      frames.push(JSON.parse(data) as WikiAskStreamEvent);
    } catch {
      // A malformed frame is skipped; the done frame still settles the answer.
    }
  }
  return { frames, rest };
}

export type AnswerPart = { kind: 'text'; text: string } | { kind: 'cite'; pageId: string; title: string; n: number };

/**
 * The answer as prose and numbered citations. A [[page-id]] the engine did not confirm
 * (not in `citations`) renders as nothing — it was already dropped server-side, this is
 * belt and braces for streamed text.
 */
export function answerParts(answer: string, citations: Pick<WikiAskPage, 'pageId' | 'title'>[], known?: ReadonlySet<string>): AnswerPart[] {
  const order = new Map<string, number>();
  const titles = new Map(citations.map((c) => [c.pageId, c.title]));
  const parts: AnswerPart[] = [];
  const pattern = /\[\[([^[\]\n]+)\]\]/g;
  let last = 0;
  for (const match of answer.matchAll(pattern)) {
    const id = match[1]!.trim();
    if (match.index! > last) parts.push({ kind: 'text', text: answer.slice(last, match.index) });
    last = match.index! + match[0].length;
    if (!titles.has(id) && !known?.has(id)) continue;
    if (!order.has(id)) order.set(id, order.size + 1);
    parts.push({ kind: 'cite', pageId: id, title: titles.get(id) ?? id, n: order.get(id)! });
  }
  if (last < answer.length) parts.push({ kind: 'text', text: answer.slice(last) });
  return parts;
}

/** Ids worth highlighting in a visualization: the cited pages once known, else what was read. */
export function highlightedPageIds(state: AskState): string[] {
  if (state.result?.citations.length) return state.result.citations.map((c) => c.pageId);
  return state.pagesRead.map((p) => p.pageId);
}
