import { createHash, createPrivateKey, createPublicKey, generateKeyPairSync, sign, type KeyObject } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { canonicalJson, type PackageManifest } from '@sef/shared';
import { config } from './config';
import { log } from './logger';

export interface SigningKeys {
  privateKey: KeyObject;
  publicKeyPem: string;
}

/** Env var holding the signing key, so a host without a persistent disk keeps one identity. */
export const SIGNING_KEY_ENV = 'UNI_SIGNING_PRIVATE_KEY';

/** Short, stable identifier for a public key: sha256 of its SPKI DER, first 16 hex chars. */
export function publicKeyFingerprint(publicKeyPem: string): string {
  const der = createPublicKey(publicKeyPem).export({ type: 'spki', format: 'der' });
  return createHash('sha256').update(der).digest('hex').slice(0, 16);
}

/** The env value for a private key: base64 of its PKCS#8 PEM (one line, safe in any env store). */
export function signingKeyEnvValue(privateKey: KeyObject): string {
  return Buffer.from(privateKey.export({ type: 'pkcs8', format: 'pem' }).toString(), 'utf8').toString('base64');
}

/**
 * Parses `UNI_SIGNING_PRIVATE_KEY`: base64 of the PEM (preferred) or the PEM itself, with
 * real or `\n`-escaped newlines. Anything that is not an ed25519 private key is refused,
 * and the error never echoes the value.
 */
export function parseSigningKeyEnv(raw: string): KeyObject {
  const value = raw.trim();
  const pem = value.includes('-----BEGIN')
    ? value.replace(/\\n/g, '\n')
    : Buffer.from(value.replace(/\s+/g, ''), 'base64').toString('utf8');
  let privateKey: KeyObject;
  try {
    if (!pem.includes('-----BEGIN')) throw new Error('not a PEM');
    privateKey = createPrivateKey(pem);
  } catch {
    throw new Error(`${SIGNING_KEY_ENV} is set but is not a PEM private key (or base64 of one). Refusing to boot.`);
  }
  if (privateKey.asymmetricKeyType !== 'ed25519') {
    throw new Error(`${SIGNING_KEY_ENV} must be an ed25519 key, got ${privateKey.asymmetricKeyType}. Refusing to boot.`);
  }
  return privateKey;
}

function keysFrom(privateKey: KeyObject): SigningKeys {
  return { privateKey, publicKeyPem: createPublicKey(privateKey).export({ type: 'spki', format: 'pem' }).toString() };
}

/**
 * Loads the university's ed25519 key pair. `UNI_SIGNING_PRIVATE_KEY`, when set, wins and no
 * files are read or written; otherwise the key is read from `dir`, generated and persisted
 * on first boot.
 */
export async function loadSigningKeys(dir = config.keysDir, envValue = process.env[SIGNING_KEY_ENV]): Promise<SigningKeys> {
  if (envValue?.trim()) {
    const keys = keysFrom(parseSigningKeyEnv(envValue));
    log.info('signing_keys_from_env', { fingerprint: publicKeyFingerprint(keys.publicKeyPem) });
    return keys;
  }
  const privatePath = path.join(dir, 'signing-private.pem');
  try {
    const pem = await readFile(privatePath, 'utf8');
    return keysFrom(createPrivateKey(pem));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
  }
  await mkdir(dir, { recursive: true });
  const { privateKey, publicKey } = generateKeyPairSync('ed25519');
  await writeFile(privatePath, privateKey.export({ type: 'pkcs8', format: 'pem' }).toString(), { mode: 0o600 });
  const publicKeyPem = publicKey.export({ type: 'spki', format: 'pem' }).toString();
  await writeFile(path.join(dir, 'signing-public.pem'), publicKeyPem);
  log.info('signing_keys_generated', { dir });
  return { privateKey, publicKeyPem };
}

export function signManifest(manifest: PackageManifest, keys: SigningKeys): string {
  return sign(null, Buffer.from(canonicalJson(manifest)), keys.privateKey).toString('base64');
}
