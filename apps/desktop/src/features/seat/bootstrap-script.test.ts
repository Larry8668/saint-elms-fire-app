import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { after, test } from 'node:test';

/**
 * Dry-run fixture for infra/seat/bootstrap.sh: the script writes every file it would write on
 * a real box but runs no git, docker or network command, so the rendered compose and env
 * files, the step markers and the input validation are all checked here.
 */

const REPO = path.resolve(import.meta.dirname, '../../../../..');
const SCRIPT = path.join(REPO, 'infra/seat/bootstrap.sh');
const TEMPLATE = path.join(REPO, 'infra/seat/docker-compose.seat.yml');
const homes: string[] = [];
after(() => homes.forEach((home) => rmSync(home, { recursive: true, force: true })));

const GOOD = { SEAT_REF: 'feat/38a-seat-bootstrap', SEAT_PUBLIC_HOST: '4100-agquty4ni5xojecy4lj64hpa5u.instabox.tech', SEAT_UNI_URL: 'https://uni.example.test/' };

function freshHome(): string {
  const home = mkdtempSync(path.join(tmpdir(), 'sef-seat-dry-'));
  homes.push(home);
  return home;
}

function bootstrap(home: string, inputs: Record<string, string>) {
  // Only what the script needs: an inherited SEAT_* from the developer's shell must not leak in.
  const env = { PATH: process.env.PATH ?? '/usr/bin:/bin', HOME: home, SEAT_DRY_RUN: '1', SEAT_HOME: home, SEAT_SRC_DIR: REPO, ...inputs };
  const run = spawnSync('bash', [SCRIPT], { env, encoding: 'utf8', timeout: 30_000 });
  const read = (name: string) => readFileSync(path.join(home, name), 'utf8');
  return { code: run.status, output: `${run.stdout}${run.stderr}`, read };
}

const envOf = (text: string): Record<string, string> =>
  Object.fromEntries(
    text
      .split('\n')
      .filter((line) => line && !line.startsWith('#'))
      .map((line) => [line.slice(0, line.indexOf('=')), line.slice(line.indexOf('=') + 1)]),
  );

const steps = (status: string) => status.trim().split('\n').map((line) => line.split(' ').slice(1, 3).join(' '));

test('a dry run renders the engine env for the published host and the given uni', () => {
  const home = freshHome();
  const run = bootstrap(home, GOOD);
  assert.equal(run.code, 0, run.output);
  assert.equal(run.read('state').trim(), 'done');
  assert.deepEqual(envOf(run.read('seat.env')), {
    ENGINE_HOST: '127.0.0.1',
    ENGINE_PORT: '4100',
    ENGINE_PUBLIC_HOST: GOOD.SEAT_PUBLIC_HOST,
    ENGINE_TRUST_PROXY: '1',
    ENGINE_TRUSTED_PROXIES: '127.0.0.0/8,::1',
    ENGINE_STATIC_DIR: '/seat/src/apps/desktop/dist',
    ENGINE_DATA_DIR: '/seat/engine-data',
    UNI_SERVER_URL: 'https://uni.example.test',
    OLLAMA_URL: 'http://127.0.0.1:11434',
    TUTOR_MODEL: 'gemma4:e2b',
    BRAIN_MODEL: 'gemma4:e2b',
    VISION_MODEL: 'gemma4:e2b',
    EMBED_MODEL: 'embeddinggemma',
    SEED_DEMO: 'false',
    NODE_ENV: 'production',
  });
});

test('the compose file is the template verbatim, with both services surviving a stop/start', () => {
  const home = freshHome();
  const run = bootstrap(home, GOOD);
  assert.equal(run.code, 0, run.output);
  const compose = run.read('docker-compose.yml');
  assert.equal(compose, readFileSync(TEMPLATE, 'utf8'));
  const service = (name: string) => compose.slice(compose.indexOf(`\n  ${name}:\n`) + 1).split(/\n {2}\w[\w-]*:\n/)[0]!;
  for (const name of ['ollama', 'engine']) assert.match(service(name), /restart: unless-stopped/, `${name} must restart with the Docker daemon`);
  assert.match(service('engine'), /network_mode: host/);
  assert.match(service('engine'), /env_file: \[seat\.env\]/);
  assert.match(service('ollama'), /"127\.0\.0\.1:11434:11434"/, 'Ollama binds loopback only');
  assert.match(service('build'), /VITE_ENGINE_URL: same-origin/);
  assert.match(service('build'), /VITE_DEMO_MODE: "false"/);
});

test('steps run in order and each one is marked started and done', () => {
  const home = freshHome();
  const run = bootstrap(home, GOOD);
  assert.equal(run.code, 0, run.output);
  const marks = steps(run.read('status'));
  assert.equal(marks[0], 'bootstrap start');
  assert.equal(marks.at(-1), 'bootstrap done');
  for (const step of ['inputs', 'preflight', 'checkout', 'configure', 'ollama', 'models', 'build', 'engine']) {
    assert.ok(marks.includes(`${step} start`) && marks.includes(`${step} done`), `${step} is marked`);
  }
  assert.ok(marks.indexOf('configure done') < marks.indexOf('ollama start'));
  assert.ok(marks.indexOf('build done') < marks.indexOf('engine start'));
  assert.ok(marks.indexOf('models done') < marks.indexOf('engine start'));
  assert.match(run.output, /dry-run: docker compose .* up -d --force-recreate engine/);
});

test('a bare re-run reuses the saved inputs; a re-run with a new value reconfigures', () => {
  const home = freshHome();
  assert.equal(bootstrap(home, GOOD).code, 0);
  const first = bootstrap(home, {});
  assert.equal(first.code, 0, first.output);
  assert.equal(envOf(first.read('seat.env')).ENGINE_PUBLIC_HOST, GOOD.SEAT_PUBLIC_HOST);
  assert.equal(steps(first.read('status'))[0], 'bootstrap start', 'each run starts a fresh status file');
  assert.match(first.read('status.prev'), /bootstrap done/);

  const moved = bootstrap(home, { SEAT_UNI_URL: 'https://registry.example.test' });
  assert.equal(moved.code, 0, moved.output);
  assert.equal(envOf(moved.read('seat.env')).UNI_SERVER_URL, 'https://registry.example.test');
  assert.equal(envOf(moved.read('seat.env')).ENGINE_PUBLIC_HOST, GOOD.SEAT_PUBLIC_HOST);
});

const HOSTILE: Array<[string, Record<string, string>]> = [
  ['a host with a shell metacharacter', { SEAT_PUBLIC_HOST: '4100-x.instabox.tech;reboot' }],
  ['a host that is not a hostname', { SEAT_PUBLIC_HOST: 'http://4100-x.instabox.tech' }],
  ['a uni URL with a quote', { SEAT_UNI_URL: "https://uni.example.test/'$(id)" }],
  ['a uni URL with a sed separator', { SEAT_UNI_URL: 'https://uni.example.test/a|b' }],
  ['a ref that walks up', { SEAT_REF: 'main/../../etc' }],
  ['a ref starting with a dash', { SEAT_REF: '--upload-pack=x' }],
  ['a model name with a space', { SEAT_CHAT_MODEL: 'gemma4:e2b rm' }],
];

for (const [label, override] of HOSTILE) {
  test(`refuses ${label} before writing anything`, () => {
    const home = freshHome();
    const run = bootstrap(home, { ...GOOD, ...override });
    assert.equal(run.code, 1, run.output);
    assert.equal(run.read('state').trim(), 'failed:inputs');
    assert.throws(() => run.read('seat.env'), /ENOENT/);
  });
}

test('missing required inputs fail the inputs step with a reason', () => {
  const home = freshHome();
  const run = bootstrap(home, { SEAT_REF: 'main' });
  assert.equal(run.code, 1);
  assert.match(run.output, /SEAT_PUBLIC_HOST is missing/);
  assert.match(run.read('status'), /inputs fail exit=1/);
});
