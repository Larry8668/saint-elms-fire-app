import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
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
const SESSION_START = path.join(REPO, 'infra/seat/session-start.sh');
const TEMPLATE = path.join(REPO, 'infra/seat/docker-compose.seat.yml');
const homes: string[] = [];
after(() => homes.forEach((home) => rmSync(home, { recursive: true, force: true })));

const GOOD = { SEAT_REF: 'feat/38a-seat-bootstrap', SEAT_PUBLIC_HOST: '4100-agquty4ni5xojecy4lj64hpa5u.instabox.tech', SEAT_UNI_URL: 'https://uni.example.test/' };

function freshHome(): string {
  const home = mkdtempSync(path.join(tmpdir(), 'sef-seat-dry-'));
  homes.push(home);
  return home;
}

function bootstrap(home: string, inputs: Record<string, string>, script = SCRIPT, args: string[] = []) {
  // Only what the script needs: an inherited SEAT_* from the developer's shell must not leak in.
  const env = { PATH: process.env.PATH ?? '/usr/bin:/bin', HOME: home, SEAT_DRY_RUN: '1', SEAT_HOME: home, SEAT_SRC_DIR: REPO, ...inputs };
  const run = spawnSync('bash', [script, ...args], { env, encoding: 'utf8', timeout: 30_000 });
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
    FFMPEG_PATH: '/seat/cache/bin/ffmpeg',
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
  assert.match(service('engine'), /env_file:\n {6}- seat\.env\n {6}- path: session\.env\n {8}required: false/);
  assert.match(service('ollama'), /profiles: \["local-model"\]/, 'a central-model box never starts Ollama');
  assert.doesNotMatch(service('engine'), /depends_on/);
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
  for (const step of ['inputs', 'preflight', 'checkout', 'configure', 'tools', 'ollama', 'models', 'build', 'engine']) {
    assert.ok(marks.includes(`${step} start`) && marks.includes(`${step} done`), `${step} is marked`);
  }
  assert.ok(marks.indexOf('configure done') < marks.indexOf('tools start'));
  assert.ok(marks.indexOf('tools done') < marks.indexOf('ollama start'));
  assert.ok(marks.indexOf('build done') < marks.indexOf('engine start'));
  assert.ok(marks.indexOf('models done') < marks.indexOf('engine start'));
  assert.match(run.output, /dry-run: docker compose .* --profile local-model up -d --quiet-pull --force-recreate engine/);
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

const GOLDEN = { SEAT_REF: 'feat/44-golden-snapshot', SEAT_MODE: 'golden' };
const SESSION_KEYS = /^(ENGINE_PUBLIC_HOST|ENGINE_SEAT_OWNER|UNI_SERVER_URL|MODEL_GATEWAY_URL|MODEL_GATEWAY_TOKEN|OLLAMA_URL)=/m;

test('central model mode skips Ollama and the models, and leaves the gateway to session.env', () => {
  const home = freshHome();
  const run = bootstrap(home, { ...GOOD, SEAT_MODEL_MODE: 'central' });
  assert.equal(run.code, 0, run.output);
  const env = envOf(run.read('seat.env'));
  assert.equal(env.OLLAMA_URL, undefined);
  assert.equal(env.ENGINE_PUBLIC_HOST, GOOD.SEAT_PUBLIC_HOST);
  const marks = steps(run.read('status'));
  assert.ok(!marks.includes('ollama start') && !marks.includes('models start'), marks.join());
  assert.ok(marks.includes('build done') && marks.includes('engine done'));
  assert.doesNotMatch(run.output, /--profile local-model|ollama pull/);
  assert.equal(readdirSync(home).includes('ollama'), false);
});

test('golden mode builds, verifies the image and scrubs, with no per-session value and no engine start', () => {
  const home = freshHome();
  const run = bootstrap(home, GOLDEN);
  assert.equal(run.code, 0, run.output);
  const marks = steps(run.read('status'));
  for (const step of ['checkout', 'configure', 'build', 'image', 'scrub']) assert.ok(marks.includes(`${step} done`), `${step} ran`);
  for (const step of ['ollama', 'models', 'engine']) assert.ok(!marks.includes(`${step} start`), `${step} skipped`);
  assert.doesNotMatch(run.read('seat.env'), SESSION_KEYS);
  assert.equal(envOf(run.read('seat.env')).ENGINE_DATA_DIR, '/seat/engine-data');
  assert.equal(run.read('session-start.sh'), readFileSync(SESSION_START, 'utf8'));
  assert.deepEqual(Object.keys(JSON.parse(run.read('golden.json'))), ['ref', 'commit', 'image', 'builtAt']);
  assert.equal(JSON.parse(run.read('golden.json')).image, 'node:24-slim');
  assert.deepEqual(readdirSync(path.join(home, 'engine-data')), []);
  assert.match(run.output, /dry-run: docker image inspect .* node:24-slim/);
});

for (const [label, override] of [
  ['a public host', { SEAT_PUBLIC_HOST: GOOD.SEAT_PUBLIC_HOST }],
  ['a uni URL', { SEAT_UNI_URL: GOOD.SEAT_UNI_URL }],
  ['a local model', { SEAT_MODEL_MODE: 'local' }],
] as const) {
  test(`golden mode refuses ${label}`, () => {
    const run = bootstrap(freshHome(), { ...GOLDEN, ...override });
    assert.equal(run.code, 1, run.output);
    assert.equal(run.read('state').trim(), 'failed:inputs');
  });
}

test('scrub removes every session trace and keeps the image', () => {
  const home = freshHome();
  assert.equal(bootstrap(home, GOLDEN).code, 0);
  // What a session (or a test drive of the builder) leaves behind.
  mkdirSync(path.join(home, 'engine-data/profiles/alice/content'), { recursive: true });
  writeFileSync(path.join(home, 'engine-data/seat-owner.json'), '{"accountId":"alice"}');
  writeFileSync(path.join(home, 'engine-data/auth-sessions.json'), '[]');
  writeFileSync(path.join(home, 'engine-data/settings.json'), '{"uniServerUrl":"https://uni.example.test"}');
  writeFileSync(path.join(home, 'session.env'), 'MODEL_GATEWAY_TOKEN=abc\n');
  writeFileSync(path.join(home, '.bash_history'), 'curl -H "X-API-Key: ibk_x"\n');
  mkdirSync(path.join(home, 'cache/home/.config'), { recursive: true });

  const run = bootstrap(home, {}, SCRIPT, ['scrub']);
  assert.equal(run.code, 0, run.output);
  assert.deepEqual(readdirSync(path.join(home, 'engine-data')), []);
  assert.deepEqual(readdirSync(path.join(home, 'cache/home')), []);
  const left = readdirSync(home);
  for (const gone of ['session.env', 'session.state', '.bash_history', 'status.prev']) assert.ok(!left.includes(gone), `${gone} removed`);
  for (const kept of ['docker-compose.yml', 'seat.env', 'session-start.sh', 'golden.json', 'built', 'bootstrap.inputs']) assert.ok(left.includes(kept), `${kept} kept`);
  assert.match(run.output, /dry-run: docker compose .* rm --stop --force engine/);
  assert.match(run.output, /scrub ok/);
});

test('scrub refuses to run on a student seat', () => {
  const home = freshHome();
  assert.equal(bootstrap(home, GOOD).code, 0);
  const run = bootstrap(home, {}, SCRIPT, ['scrub']);
  assert.equal(run.code, 1, run.output);
  assert.match(run.output, /scrub is for golden images only/);
});

test('scrub fails the snapshot when a key-like value is still on the image', () => {
  const home = freshHome();
  assert.equal(bootstrap(home, GOLDEN).code, 0);
  writeFileSync(path.join(home, 'notes.txt'), 'export INSTABOX_API_KEY=ibk_live123\n');
  const run = bootstrap(home, {}, SCRIPT, ['scrub']);
  assert.equal(run.code, 1, run.output);
  assert.match(run.output, /secret-looking values in: .*notes\.txt/);
  assert.equal(run.read('state').trim(), 'failed:scrub');
});

const SESSION = {
  ENGINE_PUBLIC_HOST: '4100-agquty4ni5xojecy4lj64hpa5u.instabox.tech',
  ENGINE_SEAT_OWNER: 'acct_123',
  UNI_SERVER_URL: 'https://uni.example.test/',
  MODEL_GATEWAY_URL: 'https://gateway.example.test/v1',
  MODEL_GATEWAY_TOKEN: 'tok.abc-123',
  VAULT_SYNC_ACCOUNT: 'acct_123',
  SYNC_FLUSH_TOKEN: 'flush-0123456789abcdef0123',
};

test('session-start writes the per-session env privately and never prints a value', () => {
  const home = freshHome();
  assert.equal(bootstrap(home, GOLDEN).code, 0);
  const run = bootstrap(home, { ...SESSION, OBJECT_STORE_BUCKET: 'sef-vaults' }, SESSION_START);
  assert.equal(run.code, 0, run.output);
  assert.deepEqual(envOf(run.read('session.env')), { ...SESSION, UNI_SERVER_URL: 'https://uni.example.test', OBJECT_STORE_BUCKET: 'sef-vaults' });
  assert.equal(statSync(path.join(home, 'session.env')).mode & 0o077, 0, 'session.env is private to its owner');
  assert.match(run.read('session.state'), /^ready /);
  assert.match(run.output, /up -d --pull never --force-recreate engine/);
  for (const value of Object.values(SESSION)) assert.ok(!run.output.includes(value), 'no value in the exec output');
  assert.match(run.output, /wrote session\.env: .*VAULT_SYNC_ACCOUNT SYNC_FLUSH_TOKEN/);
});

test('session-start takes the sync account from a multi-owner seat, and sync stays optional', () => {
  const home = freshHome();
  assert.equal(bootstrap(home, GOLDEN).code, 0);
  const multi = bootstrap(home, { ...SESSION, ENGINE_SEAT_OWNER: 'acct_9,acct_123' }, SESSION_START);
  assert.equal(multi.code, 0, multi.output);
  assert.equal(envOf(multi.read('session.env')).VAULT_SYNC_ACCOUNT, 'acct_123');
  const { VAULT_SYNC_ACCOUNT: _a, SYNC_FLUSH_TOKEN: _t, ...noSync } = SESSION;
  const plain = bootstrap(home, noSync, SESSION_START);
  assert.equal(plain.code, 0, plain.output);
  const written = envOf(plain.read('session.env'));
  assert.ok(!('VAULT_SYNC_ACCOUNT' in written) && !('SYNC_FLUSH_TOKEN' in written), 'a re-run without sync drops the old values');
});

for (const [label, override] of [
  ['a missing owner', { ENGINE_SEAT_OWNER: '' }],
  ['a missing gateway on a central image', { MODEL_GATEWAY_URL: '' }],
  ['a token with a quote', { MODEL_GATEWAY_TOKEN: "tok'$(id)" }],
  ['a host with a newline', { ENGINE_PUBLIC_HOST: '4100-x.instabox.tech\nUNI_SERVER_URL=http://evil' }],
  ['a VAULT_SYNC_ACCOUNT not in ENGINE_SEAT_OWNER', { VAULT_SYNC_ACCOUNT: 'acct_999' }],
  ['a VAULT_SYNC_ACCOUNT that only prefixes an owner', { ENGINE_SEAT_OWNER: 'acct_1234', VAULT_SYNC_ACCOUNT: 'acct_123' }],
  ['a SYNC_FLUSH_TOKEN under 24 characters', { SYNC_FLUSH_TOKEN: 'short-flush-token-12345' }],
  ['a SYNC_FLUSH_TOKEN with a quote', { SYNC_FLUSH_TOKEN: "flush-0123456789abcdef'$(id)" }],
] as const) {
  test(`session-start refuses ${label}`, () => {
    const home = freshHome();
    assert.equal(bootstrap(home, GOLDEN).code, 0);
    const run = bootstrap(home, { ...SESSION, ...override }, SESSION_START);
    assert.equal(run.code, 1, run.output);
    assert.throws(() => run.read('session.env'), /ENOENT/);
    assert.throws(() => run.read('session.env.tmp'), /ENOENT/, 'no half-written env file is left behind');
    assert.match(run.read('session.state'), /^failed /);
  });
}
