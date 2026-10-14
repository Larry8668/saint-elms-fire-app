import path from 'node:path';
import { DEMO_ADMIN, DEMO_PERSONAS, type Account, type AccountPatch, type NewAccount } from '@sef/shared';
import { hashPassword, verifyPassword } from '@sef/shared/node';
import { config } from '../config';
import { log } from '../logger';
import { readJson, writeJson } from './json-file';

interface StoredAccount extends Account {
  passwordHash: string;
}

export class AccountExistsError extends Error {}

const toPublic = ({ passwordHash: _hash, ...account }: StoredAccount): Account => account;
const idFromEmail = (email: string) => email.split('@')[0]!.replace(/[^a-z0-9-]/g, '-');

export class AccountStore {
  private accounts = new Map<string, StoredAccount>();
  private readonly file: string;

  constructor(dataDir = config.dataDir) {
    this.file = path.join(dataDir, 'accounts.json');
  }

  /** Loads accounts; on first boot seeds the admin and the three demo students. Returns true if seeded. */
  async load(): Promise<boolean> {
    const rows = await readJson<StoredAccount[] | null>(this.file, null);
    if (rows) {
      this.accounts = new Map(rows.map((a) => [a.id, a]));
      return false;
    }
    await this.seedDemo();
    return true;
  }

  private async seedDemo(): Promise<void> {
    const passwordHash = await hashPassword(config.demoPassword);
    const createdAt = new Date().toISOString();
    this.accounts.set(DEMO_ADMIN.id, { ...DEMO_ADMIN, role: 'admin', createdAt, passwordHash });
    for (const p of DEMO_PERSONAS) {
      this.accounts.set(p.id, {
        id: p.id,
        email: p.email,
        name: p.name,
        role: 'student',
        cohortId: p.cohortId,
        stage: p.stage,
        persona: p.persona,
        createdAt,
        passwordHash,
      });
    }
    await this.persist();
    log.info('accounts_seeded', { count: this.accounts.size });
  }

  private persist(): Promise<void> {
    return writeJson(this.file, [...this.accounts.values()]);
  }

  /** Returns the account only if the password matches and the account is active. */
  async authenticate(email: string, password: string): Promise<Account | null> {
    const account = [...this.accounts.values()].find((a) => a.email === email);
    if (!account || account.disabled) return null;
    return (await verifyPassword(password, account.passwordHash)) ? toPublic(account) : null;
  }

  get(id: string): Account | undefined {
    const account = this.accounts.get(id);
    return account ? toPublic(account) : undefined;
  }

  list(): Account[] {
    return [...this.accounts.values()].map(toPublic).sort((a, b) => a.name.localeCompare(b.name));
  }

  async create(input: NewAccount): Promise<Account> {
    if ([...this.accounts.values()].some((a) => a.email === input.email)) throw new AccountExistsError(input.email);
    let id = idFromEmail(input.email);
    while (this.accounts.has(id)) id = `${id}-${Math.random().toString(36).slice(2, 6)}`;
    const { password, ...rest } = input;
    const stored: StoredAccount = { ...rest, id, createdAt: new Date().toISOString(), passwordHash: await hashPassword(password) };
    this.accounts.set(id, stored);
    await this.persist();
    return toPublic(stored);
  }

  async update(id: string, patch: AccountPatch): Promise<Account | undefined> {
    const current = this.accounts.get(id);
    if (!current) return undefined;
    const { password, ...rest } = patch;
    const next: StoredAccount = { ...current, ...rest };
    if (password) next.passwordHash = await hashPassword(password);
    this.accounts.set(id, next);
    await this.persist();
    return toPublic(next);
  }
}
