import assert from 'node:assert/strict';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import type { EngineSettings } from '@sef/shared';
import type { generateStructured } from '../../agents/factory';
import type { ContentStore } from '../../content/store';
import type { SettingsReader } from '../../settings/store';
import { BrainService, QUIZ_MALFORMED } from '../../brain/service';
import { SourceIngestor } from '../../brain/sources/ingest';
import { BrainVault } from '../../brain/vault';
import { PROFILE, tempRoot, vault } from '../../brain/testing/fixtures';
import { studentRoutes } from './student';

process.env.ENGINE_DATA_DIR = await mkdtemp(path.join(tmpdir(), 'sef-quiz-routes-'));

const LESSONS = [
  {
    id: 'lesson-momentum',
    courseId: 'classical-mechanics',
    courseName: 'Classical Mechanics',
    moduleId: 'm1',
    moduleName: 'Mechanics I',
    subjectId: 'physics',
    semesterNumber: 1,
    order: 1,
    title: 'Momentum and Its Conservation',
    concepts: ['momentum'],
    prerequisites: [],
    tags: [],
    markdown: `Momentum is mass times velocity. ${'x'.repeat(5000)}`,
  },
];

const settings: SettingsReader = {
  get: async () =>
    ({
      uniServerUrl: 'https://uni.example.test',
      searxngUrl: '',
      thinking: true,
      providers: [{ id: 'p', kind: 'ollama', label: 'Test model', baseUrl: 'http://127.0.0.1:9' }],
      roles: { tutor: { provider: 'p', model: 'm' }, brain: { provider: 'p', model: 'm' }, vision: { provider: 'p', model: 'm' } },
    }) as EngineSettings,
};
const content = { academicLessons: async () => LESSONS, installed: async () => ({}) } as unknown as ContentStore;
const AUTH = { authorization: 'Bearer valid', 'content-type': 'application/json' };

const GOOD = {
  questions: [
    { question: 'What is momentum?', options: ['m v', 'm a', 'F t', 'v / t'], correct_option: 'm v', explanation: 'p = mv' },
    { question: 'Unit of momentum?', options: ['kg m/s', 'N', 'J', 'W'], correct_option: 'kg m/s' },
    { question: 'Momentum is conserved when?', options: ['No net external force', 'Always', 'Never', 'At rest'], correct_option: 'No net external force' },
  ],
};
/** Options that never contain the stated answer: finalizeQuestions keeps none of them. */
const MALFORMED = { questions: [{ question: 'Broken?', options: ['a', 'b', 'c', 'd'], correct_option: 'z' }] };

type Generate = typeof generateStructured;

async function harness(prefix: string, generate: Generate) {
  const store = await vault(prefix);
  const sources = new SourceIngestor(store, async () => PROFILE);
  const vaultView = new BrainVault(store.root);
  await vaultView.init();
  const brain = new BrainService(content, vaultView, settings, await tempRoot(`${prefix}-quizzes`), { wiki: store, sources, identity: async () => PROFILE, generate });
  const profile = { id: PROFILE.studentId, name: 'Student', email: 's@example.test', cohortId: 'cohort-a', programmeId: PROFILE.programmeId };
  const ws = { profile, sources, wiki: store, vault: vaultView, brain, settings, content };
  const deps = {
    settings: {},
    auth: { resolve: async (token: string) => (token === 'valid' ? { profile, mode: 'offline' as const } : null) },
    workspaces: { get: async () => ws },
  } as never;
  return studentRoutes(deps);
}

type JobState = { stage: 'writing' | 'ready' | 'failed'; quiz?: { id: string; questions: Array<{ question: string; options: string[] }> }; error?: string };

const start = async (app: Awaited<ReturnType<typeof harness>>, key = 'momentum') => {
  const res = await app.request(`/quiz/${key}`, { method: 'POST', headers: AUTH });
  return { status: res.status, body: (await res.json()) as { jobId: string; key: string; error?: string } };
};
const poll = async (app: Awaited<ReturnType<typeof harness>>, jobId: string): Promise<JobState> => {
  for (let i = 0; i < 200; i++) {
    const res = await app.request(`/quiz/jobs/${jobId}`, { headers: AUTH });
    assert.equal(res.status, 200);
    const job = (await res.json()) as JobState;
    if (job.stage !== 'writing') return job;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  throw new Error('quiz job never finished');
};

test('POST answers 202 with a job at once; the job turns ready with the quiz, which submits as before', async () => {
  let release!: () => void;
  const gate = new Promise<void>((resolve) => (release = resolve));
  const prompts: string[] = [];
  let think: unknown;
  const app = await harness('quiz-ready', (async (req) => {
    prompts.push(req.prompt);
    think = (req.resolved.providerOptions.ollama as { think?: boolean } | undefined)?.think;
    await gate;
    return { object: GOOD, ms: 1 };
  }) as Generate);

  const created = await start(app);
  assert.equal(created.status, 202);
  assert.equal(created.body.key, 'momentum');
  assert.match(created.body.jobId, /^qjob_/);

  const writing = (await (await app.request(`/quiz/jobs/${created.body.jobId}`, { headers: AUTH })).json()) as JobState;
  assert.deepEqual(writing, { stage: 'writing' }, 'the model is still writing');

  release();
  const job = await poll(app, created.body.jobId);
  assert.equal(job.stage, 'ready');
  assert.equal(job.quiz?.questions.length, 3);
  assert.deepEqual(Object.keys(job.quiz!.questions[0]!).sort(), ['options', 'question'], 'answers never leave the engine');

  // The prompt is trimmed: one lesson's text is capped, and thinking is off even when the setting is on.
  assert.equal(prompts.length, 1);
  assert.ok(prompts[0]!.length < 2_600, `prompt is ${prompts[0]!.length} chars`);
  assert.match(prompts[0]!, /exactly 3 questions/);
  assert.equal(think, undefined, 'no think flag is sent');

  const submitted = await app.request(`/quiz/${job.quiz!.id}/submit`, { method: 'POST', headers: AUTH, body: JSON.stringify({ answers: [0, 0, 0], attemptId: 'a1' }) });
  assert.equal(submitted.status, 200);
  assert.equal(((await submitted.json()) as { score: number }).score, 3);
});

test('a malformed result is retried once, then the job fails with an honest message', async () => {
  let calls = 0;
  const app = await harness('quiz-failed', (async () => {
    calls++;
    return { object: MALFORMED, ms: 1 };
  }) as Generate);
  const created = await start(app);
  assert.equal(created.status, 202);
  const job = await poll(app, created.body.jobId);
  assert.deepEqual(job, { stage: 'failed', error: QUIZ_MALFORMED });
  assert.equal(calls, 2, 'one internal retry before failing');

  let second = 0;
  const recovering = await harness('quiz-retry', (async () => (++second === 1 ? { object: MALFORMED, ms: 1 } : { object: GOOD, ms: 1 })) as Generate);
  const retried = await poll(recovering, (await start(recovering)).body.jobId);
  assert.equal(retried.stage, 'ready', 'the retry recovers');
});

test('a second POST for the same concept while one is writing joins the running job', async () => {
  let release!: () => void;
  const gate = new Promise<void>((resolve) => (release = resolve));
  let calls = 0;
  const app = await harness('quiz-join', (async () => {
    calls++;
    await gate;
    return { object: GOOD, ms: 1 };
  }) as Generate);
  const first = await start(app);
  const second = await start(app);
  assert.equal(second.status, 202);
  assert.equal(second.body.jobId, first.body.jobId, 'the same job');
  release();
  assert.equal((await poll(app, first.body.jobId)).stage, 'ready');
  assert.equal(calls, 1, 'the model ran once');

  const third = await start(app);
  assert.notEqual(third.body.jobId, first.body.jobId, 'once finished, a new POST writes a fresh set');
  await poll(app, third.body.jobId);
});

test('an unknown concept is refused up front; an unknown job answers 404', async () => {
  const app = await harness('quiz-unknown', (async () => ({ object: GOOD, ms: 1 })) as Generate);
  const created = await start(app, 'no-such-concept');
  assert.equal(created.status, 404);
  const missing = await app.request('/quiz/jobs/qjob_missing', { headers: AUTH });
  assert.equal(missing.status, 404);
  assert.equal(((await missing.json()) as { code: string }).code, 'quiz_job_not_found');
});
