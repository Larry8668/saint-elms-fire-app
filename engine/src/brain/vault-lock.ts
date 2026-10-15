import { randomUUID } from 'node:crypto';
import { mkdir, open, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { log } from '../config';
import { readText } from '../lib/fs';
import { VaultLockError } from './vault-errors';
import { META_DIRECTORY, WRITER_LOCK_FILE, vaultPath } from './vault-layout';

export interface VaultLockOptions {
  /** How long a writer waits for the vault before giving up. */
  lockTimeoutMs?: number;
  /** How long a lock file may sit unowned before another writer may break it. */
  lockStaleMs?: number;
  lockPollMs?: number;
}

interface LockHolder {
  pid: number;
  host: string;
  token: string;
  at: string;
}

const DEFAULTS = { lockTimeoutMs: 5_000, lockStaleMs: 60_000, lockPollMs: 25 };

/**
 * One writer per vault. Operations queue in-process, and a lock file keeps a second engine
 * process out: the vault is the student's only copy, so two writers must never interleave.
 */
export class VaultLock {
  private tail: Promise<void> = Promise.resolve();

  constructor(
    private readonly root: string,
    private readonly options: VaultLockOptions = {},
  ) {}

  get lockFile(): string {
    return vaultPath(this.root, META_DIRECTORY, WRITER_LOCK_FILE);
  }

  async run<T>(operation: () => Promise<T>): Promise<T> {
    const previous = this.tail;
    let release!: () => void;
    this.tail = new Promise<void>((resolve) => {
      release = resolve;
    });
    await previous;
    let holder: LockHolder | null = null;
    try {
      holder = await this.acquire();
      return await operation();
    } finally {
      if (holder) await this.release(holder);
      release();
    }
  }

  private async acquire(): Promise<LockHolder> {
    const { lockTimeoutMs, lockStaleMs, lockPollMs } = { ...DEFAULTS, ...this.options };
    const holder: LockHolder = { pid: process.pid, host: os.hostname(), token: randomUUID(), at: new Date().toISOString() };
    await mkdir(path.dirname(this.lockFile), { recursive: true });
    const deadline = Date.now() + lockTimeoutMs;
    for (;;) {
      try {
        const handle = await open(this.lockFile, 'wx');
        try {
          await handle.writeFile(JSON.stringify(holder));
        } finally {
          await handle.close();
        }
        return holder;
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
      }
      if (await this.breakStale(lockStaleMs)) continue;
      if (Date.now() >= deadline) {
        throw new VaultLockError(`Vault at ${this.root} is locked by another writer; retry when it finishes.`);
      }
      await delay(lockPollMs);
    }
  }

  private async release(holder: LockHolder): Promise<void> {
    const current = await this.readHolder();
    if (current && current.token !== holder.token) {
      log.warn('vault_lock_not_owned', { root: this.root, holderPid: current.pid });
      return;
    }
    await rm(this.lockFile, { force: true });
  }

  private async breakStale(staleMs: number): Promise<boolean> {
    const current = await this.readHolder();
    if (!current) return true;
    // A lock from another machine cannot be judged from here: wait rather than break it.
    if (current.host !== os.hostname()) return false;
    if (Date.now() - Date.parse(current.at) < staleMs) return false;
    if (isProcessAlive(current.pid)) return false;
    log.warn('vault_lock_broken', { root: this.root, holderPid: current.pid });
    await rm(this.lockFile, { force: true });
    return true;
  }

  private async readHolder(): Promise<LockHolder | null> {
    const raw = await readText(this.lockFile);
    if (!raw) return null;
    try {
      const parsed = JSON.parse(raw) as Partial<LockHolder>;
      if (typeof parsed.pid !== 'number' || typeof parsed.token !== 'string' || typeof parsed.at !== 'string') return null;
      return { pid: parsed.pid, token: parsed.token, at: parsed.at, host: parsed.host ?? '' };
    } catch {
      return null;
    }
  }
}

function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'EPERM';
  }
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
