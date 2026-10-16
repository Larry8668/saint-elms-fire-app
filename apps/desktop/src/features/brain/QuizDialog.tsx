import { useMutation } from '@tanstack/react-query';
import { Check, X } from 'lucide-react';
import { useEffect, useState } from 'react';
import { toast } from 'sonner';
import { Markdown } from '@/components/Markdown';
import { Button } from '@/components/ui/button';
import { Dialog } from '@/components/ui/overlays';
import { WorkingLabel } from '@/components/ui/loading';
import { Skeleton } from '@/components/ui/primitives';
import { api, type QuizPayload, type QuizResult } from '@/lib/api';
import { cn } from '@/lib/cn';
import { useInvalidateBrain } from '@/lib/queries';
import { BrainDiff } from './BrainDiff';

/** Generates a short check for one concept; the score is one limited signal that nudges status. */
export function QuizDialog({ conceptKey, conceptLabel, open, onOpenChange }: { conceptKey: string; conceptLabel: string; open: boolean; onOpenChange: (open: boolean) => void }) {
  const [quiz, setQuiz] = useState<QuizPayload | null>(null);
  const [answers, setAnswers] = useState<number[]>([]);
  const [result, setResult] = useState<QuizResult | null>(null);
  const [attemptId, setAttemptId] = useState('');
  const invalidateBrain = useInvalidateBrain();

  const create = useMutation({
    mutationFn: () => api.createQuiz(conceptKey),
    onSuccess: (q) => {
      setQuiz(q);
      setAnswers(q.questions.map(() => -1));
      setResult(null);
      // One attempt id per served set: a retried submit replays its stored result, never a second mark.
      setAttemptId(crypto.randomUUID());
    },
    onError: (e) => toast.error((e as Error).message),
  });

  const submit = useMutation({
    mutationFn: () => api.submitQuiz(quiz!.id, answers, attemptId),
    onSuccess: (r) => {
      setResult(r);
      invalidateBrain();
    },
    onError: (e) => toast.error((e as Error).message),
  });

  useEffect(() => {
    if (open) {
      setQuiz(null);
      setResult(null);
      create.mutate();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, conceptKey]);

  return (
    <Dialog
      open={open}
      onOpenChange={onOpenChange}
      title={`Check: ${conceptLabel}`}
      description="Written from your lesson text by the quiz agent. The score is one limited signal — it can nudge a star's status, but a generated check never certifies mastery."
    >
      {create.isPending && (
        <div className="space-y-5">
          <WorkingLabel label="Writing questions from your lesson" startedAt={create.submittedAt || undefined} className="text-beacon-300" />
          {[0, 1].map((i) => (
            <div key={i} className="space-y-2.5">
              <Skeleton className="h-4 w-4/5" />
              {[0, 1, 2].map((o) => (
                <Skeleton key={o} className="h-10 w-full rounded-xl" />
              ))}
            </div>
          ))}
        </div>
      )}
      {quiz && (
        <div className="space-y-6">
          {quiz.questions.map((q, qi) => {
            const review = result?.review[qi];
            return (
              <div key={qi}>
                <Markdown variant="chat" className="mb-2 font-medium text-night-100">{`${qi + 1}. ${q.question}`}</Markdown>
                <div className="grid gap-2">
                  {q.options.map((option, oi) => {
                    const chosen = answers[qi] === oi;
                    const correct = review && review.correct === oi;
                    const wrong = review && chosen && review.correct !== oi;
                    return (
                      <button
                        key={oi}
                        disabled={Boolean(result)}
                        onClick={() => setAnswers((a) => a.map((v, i) => (i === qi ? oi : v)))}
                        className={cn(
                          'flex cursor-pointer items-center gap-3 rounded-xl border px-3.5 py-2.5 text-left text-sm transition',
                          'border-white/[0.08] bg-white/[0.03] hover:border-beacon-400/40 hover:bg-beacon-500/10',
                          chosen && !result && 'border-beacon-400/60 bg-beacon-500/15',
                          correct && 'border-aurora-400/60 bg-aurora-500/15',
                          wrong && 'border-rose-400/60 bg-rose-400/10',
                        )}
                      >
                        <span className="grid size-6 shrink-0 place-items-center rounded-lg border border-white/10 text-xs text-night-300">
                          {correct ? <Check className="size-3.5 text-aurora-300" /> : wrong ? <X className="size-3.5 text-rose-400" /> : String.fromCharCode(65 + oi)}
                        </span>
                        <Markdown variant="chat" className="[&_p]:my-0">
                          {option}
                        </Markdown>
                      </button>
                    );
                  })}
                </div>
                {review && <Markdown variant="chat" className="mt-2 text-[13px] text-night-400">{review.explanation}</Markdown>}
              </div>
            );
          })}
          {!result ? (
            <div className="flex items-center justify-between">
              <span className="text-xs text-night-500">{quiz.model}</span>
              <Button variant="primary" disabled={answers.some((a) => a < 0)} loading={submit.isPending} onClick={() => submit.mutate()}>
                Submit answers
              </Button>
            </div>
          ) : (
            <div className="space-y-4 border-t border-white/[0.07] pt-5">
              <div className="font-display text-3xl text-night-100">
                {result.score} / {result.outOf}
              </div>
              {result.replayed && <p className="text-[12px] text-night-500">That attempt was already recorded — this is its stored result, not a second mark.</p>}
              <BrainDiff diff={result.diff} applied={[]} rejected={[]} />
              <div className="flex justify-end gap-2">
                <Button variant="ghost" onClick={() => create.mutate()}>
                  Another set
                </Button>
                <Button variant="primary" onClick={() => onOpenChange(false)}>
                  Done
                </Button>
              </div>
            </div>
          )}
        </div>
      )}
    </Dialog>
  );
}
