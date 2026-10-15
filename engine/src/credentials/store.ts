import { spawnSync } from 'node:child_process';
import { log } from '../config';

/**
 * Where device credentials live. Uni session tokens, entitlement tokens and legacy
 * uni tokens must never land in settings.json, profiles.json, the vault or the
 * browser — the OS secret store holds them, and where none exists we keep them in
 * memory only (the student just signs in again after a restart).
 */
export interface CredentialStore {
  readonly kind: 'os' | 'memory';
  get(key: string): Promise<string | null>;
  /** False when the OS store refused the write (locked keychain, no agent). */
  set(key: string, value: string): Promise<boolean>;
  delete(key: string): Promise<void>;
}

export class MemoryCredentialStore implements CredentialStore {
  readonly kind = 'memory';
  private readonly values = new Map<string, string>();

  get(key: string) {
    return Promise.resolve(this.values.get(key) ?? null);
  }
  set(key: string, value: string) {
    this.values.set(key, value);
    return Promise.resolve(true);
  }
  delete(key: string) {
    this.values.delete(key);
    return Promise.resolve();
  }
}

export interface CommandResult {
  status: number | null;
  stdout: string;
}
export type CommandRunner = (command: string, args: string[], input?: string) => CommandResult;

const defaultRunner: CommandRunner = (command, args, input = '') => {
  const result = spawnSync(command, args, { input, encoding: 'utf8', maxBuffer: 1024 * 1024, timeout: 5000 });
  if (result.error) return { status: null, stdout: '' };
  return { status: result.status, stdout: result.stdout ?? '' };
};

const SERVICE = 'sef-engine';
/** Keys are engine-generated; the pattern keeps hostile input out of CLI arguments. */
const KEY_PATTERN = /^[a-zA-Z0-9_.:-]{1,128}$/;

const validKey = (key: string): boolean => KEY_PATTERN.test(key);

/** macOS Keychain via the `security` CLI. */
export class KeychainCredentialStore implements CredentialStore {
  readonly kind = 'os';

  constructor(private readonly run: CommandRunner = defaultRunner) {}

  get(key: string): Promise<string | null> {
    if (!validKey(key)) return Promise.resolve(null);
    const result = this.run('security', ['find-generic-password', '-s', SERVICE, '-a', key, '-w']);
    if (result.status !== 0) return Promise.resolve(null);
    return Promise.resolve(result.stdout.replace(/\n$/, ''));
  }

  set(key: string, value: string): Promise<boolean> {
    if (!validKey(key)) return Promise.resolve(false);
    // -U updates an existing item. The secret rides in argv — the alternative stdin
    // channel does not exist on this CLI; the process list exposure window is short.
    const result = this.run('security', ['add-generic-password', '-U', '-s', SERVICE, '-a', key, '-w', value]);
    if (result.status === 0) return Promise.resolve(true);
    log.warn('credential_store_write_refused', { backend: 'keychain', status: result.status });
    return Promise.resolve(false);
  }

  delete(key: string): Promise<void> {
    if (!validKey(key)) return Promise.resolve();
    this.run('security', ['delete-generic-password', '-s', SERVICE, '-a', key]);
    return Promise.resolve();
  }
}

/** Linux Secret Service via `secret-tool` (reads the secret from stdin). */
export class SecretToolCredentialStore implements CredentialStore {
  readonly kind = 'os';

  constructor(private readonly run: CommandRunner = defaultRunner) {}

  get(key: string): Promise<string | null> {
    if (!validKey(key)) return Promise.resolve(null);
    const result = this.run('secret-tool', ['lookup', 'service', SERVICE, 'key', key]);
    if (result.status !== 0) return Promise.resolve(null);
    return Promise.resolve(result.stdout.replace(/\n$/, ''));
  }

  set(key: string, value: string): Promise<boolean> {
    if (!validKey(key)) return Promise.resolve(false);
    const result = this.run('secret-tool', ['store', `--label=Saint Elms Fire: ${key}`, 'service', SERVICE, 'key', key], value);
    if (result.status === 0) return Promise.resolve(true);
    log.warn('credential_store_write_refused', { backend: 'secret-tool', status: result.status });
    return Promise.resolve(false);
  }

  delete(key: string): Promise<void> {
    if (!validKey(key)) return Promise.resolve();
    this.run('secret-tool', ['clear', 'service', SERVICE, 'key', key]);
    return Promise.resolve();
  }
}

/**
 * Picks the OS-backed store for this platform, verified by a real probe; anything
 * unexpected falls back to memory-only, which is strictly safer than a plaintext file.
 */
export function createCredentialStore(
  run: CommandRunner = defaultRunner,
  platform: NodeJS.Platform = process.platform,
): CredentialStore {
  if (platform === 'darwin') {
    const probe = run('security', ['find-generic-password', '-s', SERVICE, '-a', 'sef-probe', '-w']);
    if (probe.status === 0 || probe.status === 44) return new KeychainCredentialStore(run);
  } else if (platform === 'linux') {
    const probe = run('secret-tool', ['--version']);
    if (probe.status === 0) return new SecretToolCredentialStore(run);
  }
  log.warn('credential_store_memory_only', { platform });
  return new MemoryCredentialStore();
}
