import assert from 'node:assert/strict';
import { test } from 'node:test';
import { QUIZ_FAILED_FALLBACK, QUIZ_TIMED_OUT, waitForQuiz, type QuizJobState } from './quiz-job';

type Quiz = { id: string };

/** A fake clock: every sleep advances time by exactly what was asked. */
const clock = () => {
  let t = 0;
  const sleeps: number[] = [];
  return { sleeps, now: () => t, sleep: async (ms: number) => void (sleeps.push(ms), (t += ms)) };
};

test('the job is polled every 2 s until it is ready, then the quiz is returned', async () => {
  const c = clock();
  const states: Array<QuizJobState<Quiz>> = [{ stage: 'writing' }, { stage: 'writing' }, { stage: 'ready', quiz: { id: 'q1' } }];
  const polled: string[] = [];
  let started = 0;
  const quiz = await waitForQuiz<Quiz>(
    async () => (started++, { jobId: 'qjob_1', key: 'momentum' }),
    async (id) => (polled.push(id), states.shift()!),
    c,
  );
  assert.deepEqual(quiz, { id: 'q1' });
  assert.equal(started, 1, 'the create route is called once');
  assert.deepEqual(polled, ['qjob_1', 'qjob_1', 'qjob_1']);
  assert.deepEqual(c.sleeps, [2000, 2000, 2000]);
});

test('a failed job throws its own message; one with no message gets the honest fallback', async () => {
  const c = clock();
  await assert.rejects(
    waitForQuiz<Quiz>(async () => ({ jobId: 'j', key: 'k' }), async () => ({ stage: 'failed', error: 'Could not reach the model.' }), c),
    /Could not reach the model\./,
  );
  await assert.rejects(waitForQuiz<Quiz>(async () => ({ jobId: 'j', key: 'k' }), async () => ({ stage: 'failed' }), c), new RegExp(QUIZ_FAILED_FALLBACK.replace('.', '\\.')));
});

test('polling gives up after 3 minutes', async () => {
  const c = clock();
  let polls = 0;
  await assert.rejects(
    waitForQuiz<Quiz>(async () => ({ jobId: 'j', key: 'k' }), async () => (polls++, { stage: 'writing' }), c),
    new RegExp(QUIZ_TIMED_OUT),
  );
  assert.equal(polls, 90, '3 min / 2 s');
});

test('a create or poll error (a 404 after an engine restart, say) surfaces as-is', async () => {
  const c = clock();
  await assert.rejects(waitForQuiz<Quiz>(async () => { throw new Error('Unknown concept x'); }, async () => ({ stage: 'writing' }), c), /Unknown concept x/);
  await assert.rejects(
    waitForQuiz<Quiz>(async () => ({ jobId: 'j', key: 'k' }), async () => { throw new Error('That quiz is no longer being written'); }, c),
    /no longer being written/,
  );
});
