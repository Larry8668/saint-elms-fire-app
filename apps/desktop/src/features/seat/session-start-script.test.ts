import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { after, test } from 'node:test';

/**
 * infra/seat/session-start.sh in dry run against a fixture SEAT_HOME: which session values
 * reach session.env. Here only ENGINE_ALLOWED_ORIGINS (the web app on its own origin); main's
 * bootstrap-script.test.ts covers the rest.
 */

const REPO = path.resolve(import.meta.dirname, '../../../../..');
const SCRIPT = path.join(REPO, 'infra/seat/session-start.sh');
const homes: string[] = [];
after(() => homes.forEach((home) => rmSync(home, { recursive: true, force: true })));

const BASE = { ENGINE_PUBLIC_HOST: '4100-m1.instabox.tech', ENGINE_SEAT_OWNER: 'u_1', UNI_SERVER_URL: 'https://uni.example.test' };

function sessionStart(inputs: Record<string, string>) {
  const home = mkdtempSync(path.join(tmpdir(), 'sef-session-start-'));
  homes.push(home);
  // A prepared image: seat.env with a local model (no gateway needed) and the compose file.
  writeFileSync(path.join(home, 'seat.env'), 'OLLAMA_URL=http://127.0.0.1:11434\n');
  writeFileSync(path.join(home, 'docker-compose.yml'), 'services: {}\n');
  const run = spawnSync('bash', [SCRIPT], {
    env: { PATH: process.env.PATH ?? '/usr/bin:/bin', HOME: home, SEAT_HOME: home, SEAT_DRY_RUN: '1', ...BASE, ...inputs },
    encoding: 'utf8',
    timeout: 30_000,
  });
  let env = '';
  try {
    env = readFileSync(path.join(home, 'session.env'), 'utf8');
  } catch {
    // No env file: the run refused.
  }
  return { status: run.status, output: `${run.stdout}${run.stderr}`, env };
}

test('session-start passes the web app origin(s) through as ENGINE_ALLOWED_ORIGINS', () => {
  const one = sessionStart({ ENGINE_ALLOWED_ORIGINS: 'https://sef.vercel.app' });
  assert.equal(one.status, 0, one.output);
  assert.match(one.env, /^ENGINE_ALLOWED_ORIGINS=https:\/\/sef\.vercel\.app$/m);
  assert.doesNotMatch(one.output, /sef\.vercel\.app/, 'names only, never values, in the exec output');

  const two = sessionStart({ ENGINE_ALLOWED_ORIGINS: 'https://sef.vercel.app,https://preview-1.sef.example.test:8443' });
  assert.equal(two.status, 0, two.output);
  assert.match(two.env, /^ENGINE_ALLOWED_ORIGINS=https:\/\/sef\.vercel\.app,https:\/\/preview-1\.sef\.example\.test:8443$/m);

  const none = sessionStart({});
  assert.equal(none.status, 0, none.output);
  assert.doesNotMatch(none.env, /ENGINE_ALLOWED_ORIGINS/, 'optional: unset writes nothing');
});

for (const bad of ['*', 'null', 'http://sef.vercel.app', 'https://sef.vercel.app/', 'https://sef.vercel.app/path', 'https://*.vercel.app', 'https://a.test, https://b.test', 'https://a.test,', 'https://a.test"$(id)', 'https://A.test']) {
  test(`session-start refuses ENGINE_ALLOWED_ORIGINS=${JSON.stringify(bad)}`, () => {
    const run = sessionStart({ ENGINE_ALLOWED_ORIGINS: bad });
    assert.equal(run.status, 1, run.output);
    assert.match(run.output, /ENGINE_ALLOWED_ORIGINS is not valid/);
    assert.equal(run.env, '', 'no session.env is written');
  });
}
