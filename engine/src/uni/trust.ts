import path from 'node:path';
import { config, log } from '../config';
import { readText, writeFileAtomic } from '../lib/fs';
import { uniFetch } from './client';

const TRUSTED_KEY_FILE = path.join(config.paths.trust, 'uni-public.pem');

export class UniKeyMismatchError extends Error {}

/**
 * Trust on first use, per device: the first signing key the uni presents is pinned;
 * a different key later is refused. Used for course packages and offline entitlements.
 */
export async function trustedUniKey(uniServerUrl: string): Promise<string> {
  const remote = await uniFetch<{ publicKeyPem: string }>(uniServerUrl, '/v1/keys');
  const pinned = await readText(TRUSTED_KEY_FILE);
  if (!pinned) {
    await writeFileAtomic(TRUSTED_KEY_FILE, remote.publicKeyPem);
    log.info('uni_key_pinned', { url: uniServerUrl });
    return remote.publicKeyPem;
  }
  if (pinned.trim() !== remote.publicKeyPem.trim()) {
    throw new UniKeyMismatchError('University signing key changed. Refusing to trust credentials.');
  }
  return pinned;
}

/** The pinned key without contacting the uni — required for offline verification. */
export async function pinnedUniKey(): Promise<string | null> {
  const pinned = await readText(TRUSTED_KEY_FILE);
  return pinned?.trim() ? pinned : null;
}
