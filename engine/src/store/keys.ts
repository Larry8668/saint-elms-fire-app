/**
 * Object keys for one student's vault. Every key the engine writes goes through these helpers,
 * so a hostile path or account id can never address another student's prefix.
 *
 *   vaults/<accountId>/files/<relPath>          the vault tree (pages, .meta, .history)
 *   vaults/<accountId>/blobs/sha256/<hh>/<hash> content-addressed media
 */
export const VAULTS_PREFIX = 'vaults/';

const ACCOUNT_ID = /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/;
const SHA256_HEX = /^[0-9a-f]{64}$/;
// C0/C1 controls, DEL, and separators that some tools treat as path or line breaks.
const FORBIDDEN_CHARS = /[\u0000-\u001f\u007f-\u009f\\\u2028\u2029]/;
/** S3 caps keys at 1024 UTF-8 bytes; leave room for the prefix. */
const MAX_REL_PATH_BYTES = 900;
const MAX_SEGMENT_BYTES = 255;

export class ObjectKeyError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ObjectKeyError';
  }
}

const utf8Length = (value: string) => Buffer.byteLength(value, 'utf8');

/** Account ids are used verbatim (case-sensitive), never transformed, so two ids cannot collide. */
export function assertAccountId(accountId: string): string {
  if (typeof accountId !== 'string' || !ACCOUNT_ID.test(accountId)) {
    throw new ObjectKeyError('Account id must be 1–128 characters of [A-Za-z0-9_-], starting with a letter or digit');
  }
  return accountId;
}

/** The prefix every object of one student lives under. */
export function accountPrefix(accountId: string): string {
  return `${VAULTS_PREFIX}${assertAccountId(accountId)}/`;
}

/**
 * A vault-relative POSIX path (`concepts/photosynthesis.md`). Rejects absolute paths, `.`/`..`,
 * empty segments, control characters, backslashes and non-NFC Unicode (macOS hands out NFD
 * names; one spelling per name keeps two devices from writing two keys for the same file).
 */
export function assertVaultRelPath(relPath: string): string {
  if (typeof relPath !== 'string' || relPath.length === 0) throw new ObjectKeyError('Vault path must not be empty');
  if (relPath.normalize('NFC') !== relPath) throw new ObjectKeyError('Vault path must be NFC-normalized Unicode');
  if (FORBIDDEN_CHARS.test(relPath)) throw new ObjectKeyError('Vault path contains a control character or backslash');
  if (utf8Length(relPath) > MAX_REL_PATH_BYTES) throw new ObjectKeyError(`Vault path exceeds ${MAX_REL_PATH_BYTES} bytes`);
  for (const segment of relPath.split('/')) {
    if (segment === '') throw new ObjectKeyError('Vault path must be relative, with no empty segments');
    if (segment === '.' || segment === '..') throw new ObjectKeyError('Vault path must not contain . or .. segments');
    if (utf8Length(segment) > MAX_SEGMENT_BYTES) throw new ObjectKeyError(`Vault path segment exceeds ${MAX_SEGMENT_BYTES} bytes`);
  }
  return relPath;
}

export function vaultKey(accountId: string, relPath: string): string {
  return `${accountPrefix(accountId)}files/${assertVaultRelPath(relPath)}`;
}

/** Content-addressed media: the same upload is stored once, and its key proves its bytes. */
export function blobKey(accountId: string, sha256: string): string {
  if (typeof sha256 !== 'string' || !SHA256_HEX.test(sha256)) {
    throw new ObjectKeyError('Blob hash must be 64 lowercase hex characters (sha256)');
  }
  return `${accountPrefix(accountId)}blobs/sha256/${sha256.slice(0, 2)}/${sha256}`;
}
