import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createLogger } from '@sef/shared';

export { errorFields } from '@sef/shared';

const here = path.dirname(fileURLToPath(import.meta.url));

function env(name: string, fallback: string): string {
  const value = process.env[name]?.trim();
  return value ? value : fallback;
}

const dataDir = path.resolve(env('ENGINE_DATA_DIR', path.join(here, '../../.data/engine')));

export const config = {
  port: Number(env('ENGINE_PORT', '4100')),
  host: env('ENGINE_HOST', '127.0.0.1'),
  version: '0.1.0',
  paths: {
    data: dataDir,
    content: path.join(dataDir, 'content'),
    brain: path.join(dataDir, 'brain'),
    sessions: path.join(dataDir, 'sessions'),
    quizzes: path.join(dataDir, 'quizzes'),
    trust: path.join(dataDir, 'trust'),
    settings: path.join(dataDir, 'settings.json'),
  },
  /** Defaults used the first time settings.json is created. */
  defaults: {
    studentName: env('STUDENT_NAME', 'Student'),
    cohortId: env('COHORT_ID', 'bsc-pma-2026'),
    uniServerUrl: env('UNI_SERVER_URL', 'http://localhost:4200'),
    searxngUrl: env('SEARXNG_URL', 'http://localhost:8888'),
    ollamaUrl: env('OLLAMA_URL', 'http://localhost:11434'),
    tutorModel: env('TUTOR_MODEL', 'gemma4:e4b'),
    brainModel: env('BRAIN_MODEL', 'gemma4:e4b'),
    visionModel: env('VISION_MODEL', 'gemma4:e4b'),
  },
};

export const log = createLogger('engine', process.env.LOG_LEVEL === 'debug');
