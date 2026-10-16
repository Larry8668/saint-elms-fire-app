import { randomBytes } from 'node:crypto';
import { createServer } from 'node:net';
import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const packageDir = path.resolve(scriptDir, '..');
const repoDir = path.resolve(packageDir, '../..');
const composeFile = path.join(repoDir, 'docker-compose.db-test.yml');

function run(command, args, options = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { stdio: 'inherit', ...options });
    child.once('error', reject);
    child.once('exit', (code, signal) => {
      if (code === 0) resolve();
      else reject(new Error(`${command} exited ${signal ? `with ${signal}` : `with status ${code}`}`));
    });
  });
}

async function reserveLoopbackPort() {
  const server = createServer();
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('Could not reserve a loopback port');
  const { port } = address;
  await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  return port;
}

const project = `sef-uni-db-test-${process.pid}-${randomBytes(4).toString('hex')}`;
const password = randomBytes(32).toString('base64url');
const port = await reserveLoopbackPort();
const composeEnv = { ...process.env, UNI_TEST_DB_PASSWORD: password, UNI_TEST_DB_PORT: String(port) };
const composeArgs = ['compose', '-f', composeFile, '-p', project];
let started = false;

try {
  started = true;
  await run('docker', [...composeArgs, 'up', '-d', '--wait', '--wait-timeout', '90'], { cwd: repoDir, env: composeEnv });
  const databaseUrl = new URL(`postgresql://sef_test:${password}@127.0.0.1:${port}/sef_uni_test`).toString();
  const cliEnv = { ...process.env, UNI_DATABASE_URL: databaseUrl };
  for (const command of ['db:migrate', 'db:status', 'db:check']) {
    await run('pnpm', ['--filter', '@sef/uni-server', command], { cwd: repoDir, env: cliEnv });
  }
  await run('pnpm', [
    'exec', 'node', '--import', 'tsx', '--test',
    'src/db/integration.test.ts',
    'src/db/backup.integration.test.ts',
    'src/account-auth.integration.test.ts',
    'src/admission.integration.test.ts',
    'src/shares.integration.test.ts',
  ], {
    cwd: packageDir,
    env: {
      ...process.env,
      UNI_TEST_DATABASE_URL: databaseUrl,
      UNI_DB_TEST_RUNNER: 'compose-ephemeral',
    },
  });
} catch (error) {
  console.error(error instanceof Error ? error.message : 'Isolated PostgreSQL integration tests failed');
  process.exitCode = 1;
} finally {
  if (started) {
    try {
      await run('docker', [...composeArgs, 'down', '--volumes', '--remove-orphans'], { cwd: repoDir, env: composeEnv });
    } catch {
      console.error('Could not clean up the isolated PostgreSQL test project');
      process.exitCode = 1;
    }
  }
}
