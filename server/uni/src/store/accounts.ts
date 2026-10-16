import path from 'node:path';
import { DEMO_ADMIN, DEMO_PASSWORD_DEFAULT, DEMO_PERSONAS, normalizeEmail, type Account, type AccountPatch, type NewAccount } from '@sef/shared';
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
  private readonly seedDemo: boolean;

  constructor(dataDir = config.dataDir, opts: { seedDemo?: boolean } = {}) {
    this.file = path.join(dataDir, 'accounts.json');
    this.seedDemo = opts.seedDemo ?? config.seedDemo;
  }

  /**
   * Loads accounts; on first boot seeds the operator admin and — while SEED_DEMO holds —
   * the three demo students. Returns true only when the file did not exist, so callers
   * can tell a first boot apart from an established store.
   */
  async load(): Promise<boolean> {
    const rows = await readJson<StoredAccount[] | null>(this.file, null);
    if (rows) {
      this.accounts = new Map(rows.map((a) => [a.id, a]));
      return false;
    }
    await this.seed();
    return true;
  }

  private async seed(): Promise<void> {
    // The admin is the bootstrap credential for the release-management API, so it seeds
    // even without demo mode. Seeding it with the publicly known password on a real
    // deployment is a credential leak, so production refuses to continue rather than
    // booting a server anyone can administer.
    if (process.env.NODE_ENV === 'production' && config.demoPassword === DEMO_PASSWORD_DEFAULT) {
      throw new Error(
        'Refusing to seed accounts with the public demo password in production. Set DEMO_PASSWORD to a private value (or accept demo-only use).',
      );
    }
    if (config.demoPassword === DEMO_PASSWORD_DEFAULT) {
      log.warn('demo_password_default', { hint: 'Seeded accounts use the public demo password. Set DEMO_PASSWORD before exposing this server.' });
    }
    const passwordHash = await hashPassword(config.demoPassword);
    const createdAt = new Date().toISOString();
    this.accounts.set(DEMO_ADMIN.id, { ...DEMO_ADMIN, role: 'admin', createdAt, passwordHash });
    if (this.seedDemo) {
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
    }
    await this.persist();
    log.info('accounts_seeded', { count: this.accounts.size, demo: this.seedDemo });
  }

  private persist(): Promise<void> {
    return writeJson(this.file, [...this.accounts.values()]);
  }

  /** Returns the account only if the password matches and the account is active. */
  async authenticate(email: string, password: string): Promise<Account | null> {
    const account = this.findByEmail(email);
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

  private findByEmail(email: string): StoredAccount | undefined {
    const wanted = normalizeEmail(email);
    return [...this.accounts.values()].find((a) => normalizeEmail(a.email) === wanted);
  }

  async create(input: NewAccount): Promise<Account> {
    const email = normalizeEmail(input.email);
    if (this.findByEmail(email)) throw new AccountExistsError(email);
    let id = idFromEmail(email);
    while (this.accounts.has(id)) id = `${id}-${Math.random().toString(36).slice(2, 6)}`;
    const { password, ...rest } = input;
    const stored: StoredAccount = { ...rest, email, id, createdAt: new Date().toISOString(), passwordHash: await hashPassword(password) };
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
