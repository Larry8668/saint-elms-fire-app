/**
 * Every vault error means the same thing: nothing was written. The vault fails closed,
 * so a caller that sees one of these must re-read the vault and decide again.
 */
export class VaultError extends Error {
  readonly code: string;

  constructor(code: string, message: string) {
    super(message);
    this.name = new.target.name;
    this.code = code;
  }
}

export type ConflictReason = 'exists' | 'missing' | 'revision_changed' | 'out_of_band' | 'newer_schema' | 'malformed' | 'conventions_changed';

export interface VaultConflictDetail {
  id: string;
  expected: string | null;
  found: string | null;
  reason: ConflictReason;
}

/** Optimistic concurrency lost, or the vault moved under a proposal. Nothing was written. */
export class VaultConflictError extends VaultError {
  readonly details: VaultConflictDetail[];

  constructor(message: string, details: VaultConflictDetail[] = []) {
    super('conflict', message);
    this.details = details;
  }
}

/** A record id, revision or path that would escape the vault root, or is not a vault identifier. */
export class VaultPathError extends VaultError {
  constructor(message: string) {
    super('invalid_path', message);
  }
}

/** Another writer holds the vault. Retry after it releases; never write through it. */
export class VaultLockError extends VaultError {
  constructor(message: string) {
    super('locked', message);
  }
}

/** On-disk data written by a newer layout. Downgrading it would lose fields, so we refuse. */
export class VaultSchemaError extends VaultError {
  constructor(message: string) {
    super('incompatible_schema', message);
  }
}

/** On-disk data does not match its own recorded hashes or metadata. */
export class VaultIntegrityError extends VaultError {
  constructor(message: string) {
    super('integrity', message);
  }
}
