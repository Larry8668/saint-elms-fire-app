import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  createCredentialStore,
  KeychainCredentialStore,
  MemoryCredentialStore,
  SecretToolCredentialStore,
  type CommandRunner,
} from './store';

/** A fake CLI: emulates `security`/`secret-tool` over an in-memory map. */
function fakeCli(failWrites = false): { run: CommandRunner; secrets: Map<string, string>; argv: string[][] } {
  const secrets = new Map<string, string>();
  const argv: string[][] = [];
  const run: CommandRunner = (command, args, input = '') => {
    argv.push([command, ...args]);
    const [service, account] = args.includes('-s')
      ? [args[args.indexOf('-s') + 1]!, args[args.indexOf('-a') + 1]!]
      : [args[args.indexOf('service') + 1]!, args[args.indexOf('key') + 1]!];
    const key = `${service}/${account}`;
    const op = args[0];
    if (op === '--version') return { status: 0, stdout: 'secret-tool 0.0' };
    if (op === 'find-generic-password' || op === 'lookup') {
      const value = secrets.get(key);
      return value === undefined ? { status: op === 'lookup' ? 1 : 44, stdout: '' } : { status: 0, stdout: `${value}\n` };
    }
    if (op === 'add-generic-password' || op === 'store') {
      if (failWrites) return { status: 1, stdout: '' };
      // security passes the secret via -w; secret-tool via stdin.
      const value = op === 'store' ? input : args[args.indexOf('-w') + 1]!;
      secrets.set(key, value);
      return { status: 0, stdout: '' };
    }
    if (op === 'delete-generic-password' || op === 'clear') {
      secrets.delete(key);
      return { status: 0, stdout: '' };
    }
    return { status: 2, stdout: '' };
  };
  return { run, secrets, argv };
}

test('memory store round-trips and deletes', async () => {
  const store = new MemoryCredentialStore();
  assert.equal(await store.get('k'), null);
  await store.set('k', 'secret');
  assert.equal(await store.get('k'), 'secret');
  await store.delete('k');
  assert.equal(await store.get('k'), null);
  assert.equal(store.kind, 'memory');
});

test('keychain store persists via the security CLI', async () => {
  const { run } = fakeCli();
  const store = new KeychainCredentialStore(run);
  assert.equal(store.kind, 'os');
  assert.equal(await store.get('uni-session:u1'), null);
  assert.equal(await store.set('uni-session:u1', 'token-1'), true);
  assert.equal(await store.get('uni-session:u1'), 'token-1');
  await store.delete('uni-session:u1');
  assert.equal(await store.get('uni-session:u1'), null);
});

test('keychain store reports refused writes instead of pretending', async () => {
  const { run } = fakeCli(true);
  const store = new KeychainCredentialStore(run);
  assert.equal(await store.set('k', 'v'), false);
});

test('secret-tool store keeps the secret out of argv', async () => {
  const { run, argv } = fakeCli();
  const store = new SecretToolCredentialStore(run);
  await store.set('entitlement:u1', 'signed-entitlement');
  assert.equal(await store.get('entitlement:u1'), 'signed-entitlement');
  const storeCall = argv.find((a) => a[1] === 'store')!;
  assert.ok(!storeCall.includes('signed-entitlement'), 'secret must travel via stdin, not argv');
});

test('credential keys reject characters hostile to CLI arguments', async () => {
  const { run } = fakeCli();
  const store = new KeychainCredentialStore(run);
  assert.equal(await store.set('bad key;rm -rf', 'x'), false);
  assert.equal(await store.get('bad key'), null);
});

test('createCredentialStore picks the platform backend or falls back to memory', async () => {
  const { run } = fakeCli();
  assert.equal(createCredentialStore(run, 'darwin').kind, 'os');
  assert.equal(createCredentialStore(run, 'linux').kind, 'os');
  assert.equal(createCredentialStore(run, 'win32').kind, 'memory');

  const dead: CommandRunner = () => ({ status: null, stdout: '' });
  assert.equal(createCredentialStore(dead, 'darwin').kind, 'memory');
  assert.equal(createCredentialStore(dead, 'linux').kind, 'memory');
});
