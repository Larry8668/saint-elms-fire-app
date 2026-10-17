import type { SuggestedQuestion, SuggestionsResponse } from '@sef/shared';

const HIDDEN_KEY = 'sef.suggestions.hidden';

export type RailState = { kind: 'loading' } | { kind: 'hidden' } | { kind: 'empty' } | { kind: 'ready'; questions: SuggestedQuestion[]; worded: boolean };

/** What the rail shows. Errors and empty banks render nothing — suggestions are optional. */
export function railState(input: { pending: boolean; data?: SuggestionsResponse; hidden: boolean; now?: number }): RailState {
  if (input.hidden) return { kind: 'hidden' };
  if (input.pending) return { kind: 'loading' };
  const now = input.now ?? Date.now();
  const questions = (input.data?.questions ?? []).filter((q) => Date.parse(q.expiresAt) > now);
  if (!questions.length) return { kind: 'empty' };
  return { kind: 'ready', questions, worded: input.data?.mode !== 'templates' };
}

/** "Because …" provenance for the hover, with the model's part disclosed when it reworded. */
export function whyText(question: SuggestedQuestion, worded: boolean): string {
  return worded ? `Because: ${question.why}. Wording polished by your model.` : `Because: ${question.why}.`;
}

export function readHidden(storage: Pick<Storage, 'getItem'> | undefined): boolean {
  try {
    return storage?.getItem(HIDDEN_KEY) === '1';
  } catch {
    return false;
  }
}

export function writeHidden(storage: Pick<Storage, 'setItem' | 'removeItem'> | undefined, hidden: boolean): void {
  try {
    if (hidden) storage?.setItem(HIDDEN_KEY, '1');
    else storage?.removeItem(HIDDEN_KEY);
  } catch {
    // A refused write only means the choice is not remembered.
  }
}
