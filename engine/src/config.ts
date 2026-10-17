import { createHash } from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createLogger, DEMO_PASSWORD_DEFAULT } from '@sef/shared';
import { envInt, envPort } from '@sef/shared/node';

export { errorFields } from '@sef/shared';

const here = path.dirname(fileURLToPath(import.meta.url));

function env(name: string, fallback: string): string {
  const value = process.env[name]?.trim();
  return value ? value : fallback;
}

/**
 * The operator's model gateway for hosted sessions (PR-43); null unless MODEL_GATEWAY_URL is set.
 * `url` is the gateway root: the engine speaks Ollama's native `/api/*` surface to it.
 */
export interface ModelGateway {
  url: string;
  token?: string;
}

export function parseModelGateway(environment: NodeJS.ProcessEnv = process.env): ModelGateway | null {
  const url = environment.MODEL_GATEWAY_URL?.trim();
  if (!url) return null;
  if (!/^https?:\/\/[^\s/]+/.test(url)) throw new Error('MODEL_GATEWAY_URL must be an http(s) URL');
  const token = environment.MODEL_GATEWAY_TOKEN?.trim();
  // The orchestrator hands out the OpenAI-style `<root>/v1`; the native surface lives at the root.
  const root = url.replace(/\/+$/, '').replace(/\/(?:v1|api)$/, '');
  return { url: root, ...(token ? { token } : {}) };
}

const dataDir = path.resolve(env('ENGINE_DATA_DIR', path.join(here, '../../.data/engine')));

/** Everything one student owns on this device. Profiles never read each other's folders. */
export interface ProfilePaths {
  root: string;
  content: string;
  brain: string;
  sessions: string;
  quizzes: string;
  /** Private, non-portable settings (including provider credentials). */
  privateSettings: string;
}

function profileDirectory(profileId: string): string {
  if (!profileId) throw new Error('Profile id must not be empty');
  if (/^[a-z0-9][a-z0-9_-]{0,127}$/.test(profileId)) return profileId;
  return `~${createHash('sha256').update(profileId).digest('hex')}`;
}

export const profilePaths = (profileId: string, rootDir = dataDir): ProfilePaths => {
  const root = path.join(rootDir, 'profiles', profileDirectory(profileId));
  return {
    root,
    content: path.join(root, 'content'),
    brain: path.join(root, 'brain'),
    sessions: path.join(root, 'sessions'),
    quizzes: path.join(root, 'quizzes'),
    privateSettings: path.join(root, 'private-settings.json'),
  };
};

export const config = {
  port: envPort('ENGINE_PORT', 4100),
  host: env('ENGINE_HOST', '127.0.0.1'),
  version: '0.2.0',
  /** Device-level files, shared by every profile on this machine. */
  paths: {
    data: dataDir,
    settings: path.join(dataDir, 'settings.json'),
    trust: path.join(dataDir, 'trust'),
    profiles: path.join(dataDir, 'profiles.json'),
    authSessions: path.join(dataDir, 'auth-sessions.json'),
  },
  /** Engine session lifetime on this device; offline sign-in issues the same kind of session. */
  sessionHours: envInt('ENGINE_SESSION_HOURS', 24 * 14),
  /** Seed demo profiles (offline-ready) on first boot so the app works without the uni server. Opt-in: deploys fail closed. */
  seedDemo: env('SEED_DEMO', 'false') === 'true',
  demoPassword: env('DEMO_PASSWORD', DEMO_PASSWORD_DEFAULT),
  /** Repo courseware used only to preload demo profiles offline. Real students sync signed packages. */
  demoCoursewareDir: path.resolve(env('COURSEWARE_DIR', path.join(here, '../../courseware'))),
  /** Set on a hosted session: the `uni` provider becomes this gateway for every role (settings/store.ts). */
  modelGateway: parseModelGateway(),
  /** Defaults used the first time settings.json is created. */
  defaults: {
    uniServerUrl: env('UNI_SERVER_URL', 'http://localhost:4200'),
    searxngUrl: env('SEARXNG_URL', 'http://localhost:8888'),
    ollamaUrl: env('OLLAMA_URL', 'http://localhost:11434'),
    tutorModel: env('TUTOR_MODEL', 'gemma4:e4b'),
    brainModel: env('BRAIN_MODEL', 'gemma4:e4b'),
    visionModel: env('VISION_MODEL', 'gemma4:e4b'),
    embedModel: env('EMBED_MODEL', 'embeddinggemma'),
    /** The on-device safety model used to screen peer shares — advisory only, never a teacher. */
    safetyModel: env('SAFETY_MODEL', 'shieldgemma:2b'),
  },
};

export const log = createLogger('engine', process.env.LOG_LEVEL === 'debug');
