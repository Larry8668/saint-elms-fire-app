/**
 * Writing a quiz outlives a hosted edge's request timeout (the model can take well over a
 * minute through the gateway), so the engine answers the create call with a job at once and
 * the dialog polls it here until the quiz is ready or the model gave up.
 */

export interface QuizJobStart {
  jobId: string;
  key: string;
}

export interface QuizJobState<Q> {
  stage: 'writing' | 'ready' | 'failed';
  quiz?: Q;
  error?: string;
}

export interface WaitOptions {
  intervalMs?: number;
  timeoutMs?: number;
  /** Injected in tests; real timers otherwise. */
  sleep?: (ms: number) => Promise<void>;
  now?: () => number;
}

export const QUIZ_POLL_MS = 2_000;
export const QUIZ_TIMEOUT_MS = 3 * 60_000;
export const QUIZ_FAILED_FALLBACK = 'The model did not produce any well-formed questions. Try again.';
export const QUIZ_TIMED_OUT = 'The quiz is taking too long to write. Try again in a moment.';

/** Starts a quiz job and polls it every `intervalMs` until it is ready, failed, or out of time. */
export async function waitForQuiz<Q>(
  start: () => Promise<QuizJobStart>,
  poll: (jobId: string) => Promise<QuizJobState<Q>>,
  { intervalMs = QUIZ_POLL_MS, timeoutMs = QUIZ_TIMEOUT_MS, sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms)), now = Date.now }: WaitOptions = {},
): Promise<Q> {
  const { jobId } = await start();
  const deadline = now() + timeoutMs;
  for (;;) {
    await sleep(intervalMs);
    const job = await poll(jobId);
    if (job.stage === 'ready' && job.quiz) return job.quiz;
    if (job.stage === 'failed' || job.stage === 'ready') throw new Error(job.error || QUIZ_FAILED_FALLBACK);
    if (now() >= deadline) throw new Error(QUIZ_TIMED_OUT);
  }
}
