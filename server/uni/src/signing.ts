import { createPrivateKey, createPublicKey, generateKeyPairSync, sign, type KeyObject } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { canonicalJson, type PackageManifest } from '@sef/shared';
import { config } from './config';
import { log } from './logger';

export interface SigningKeys {
  privateKey: KeyObject;
  publicKeyPem: string;
}

/** Loads the university's ed25519 key pair, generating and persisting one on first boot. */
export async function loadSigningKeys(dir = config.keysDir): Promise<SigningKeys> {
  const privatePath = path.join(dir, 'signing-private.pem');
  try {
    const pem = await readFile(privatePath, 'utf8');
    const privateKey = createPrivateKey(pem);
    return { privateKey, publicKeyPem: createPublicKey(privateKey).export({ type: 'spki', format: 'pem' }).toString() };
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
