import path from 'node:path';
import { config, log } from '../config';
import { readText, writeFileAtomic } from '../lib/fs';
import { uniFetch } from './client';

const TRUSTED_KEY_FILE = path.join(config.paths.trust, 'uni-public.pem');
const TRUSTED_ISSUER_FILE = path.join(config.paths.trust, 'uni-issuer.txt');

export class UniKeyMismatchError extends Error {}

/**
 * Trust on first use, per device: the first signing key and issuer the uni presents are
 * pinned together from the same `/v1/keys` answer; a different value later is refused.
 * Used for course packages and offline entitlements. Devices that pinned only the key
 * (pre-issuer pins) pick the issuer up on the next key-matched response.
 */
export async function trustedUniKey(uniServerUrl: string): Promise<string> {
  const remote = await uniFetch<{ publicKeyPem: string; issuer: string }>(uniServerUrl, '/v1/keys');
  const pinned = await readText(TRUSTED_KEY_FILE);
  if (!pinned) {
    // Both pins or neither: a bad issuer answer must not leave a lone key pin behind.
    if (!remote.issuer?.trim()) throw new UniKeyMismatchError('University did not name an issuer. Refusing to pin trust.');
    await writeFileAtomic(TRUSTED_ISSUER_FILE, remote.issuer.trim());
    await writeFileAtomic(TRUSTED_KEY_FILE, remote.publicKeyPem);
    log.info('uni_key_pinned', { url: uniServerUrl });
    return remote.publicKeyPem;
  }
  if (pinned.trim() !== remote.publicKeyPem.trim()) {
    throw new UniKeyMismatchError('University signing key changed. Refusing to trust credentials.');
  }
  await assertIssuer(remote.issuer);
  return pinned;
}

/**
 * The pinned issuer without contacting the uni again: the pin is established by
 * `trustedUniKey`, so this throws rather than degrading when trust was never established
 * or the uni refuses to name an issuer. Callers must abort instead of comparing against
 * a placeholder.
 */
export async function trustedUniIssuer(uniServerUrl: string): Promise<string> {
  await trustedUniKey(uniServerUrl);
  const issuer = (await readText(TRUSTED_ISSUER_FILE))?.trim();
  if (!issuer) throw new UniKeyMismatchError('University issuer is not pinned. Refusing to trust packages.');
  return issuer;
}

async function pinIssuer(issuer: string): Promise<void> {
  if (!issuer?.trim()) throw new UniKeyMismatchError('University did not name an issuer. Refusing to pin trust.');
  await writeFileAtomic(TRUSTED_ISSUER_FILE, issuer.trim());
}

/** A pinned key with a missing issuer file migrates on the next verified `/v1/keys` answer. */
async function assertIssuer(remote: string): Promise<void> {
  if (!remote?.trim()) throw new UniKeyMismatchError('University did not name an issuer. Refusing to trust credentials.');
  const pinned = (await readText(TRUSTED_ISSUER_FILE))?.trim();
  if (!pinned) {
    await pinIssuer(remote);
    return;
  }
  if (pinned !== remote.trim()) {
    throw new UniKeyMismatchError('University issuer changed. Refusing to trust credentials.');
  }
}

/** The pinned key without contacting the uni — required for offline verification. */
export async function pinnedUniKey(): Promise<string | null> {
  const pinned = await readText(TRUSTED_KEY_FILE);
  return pinned?.trim() ? pinned : null;
}
