import { createPrivateKey } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { config } from '../config';
import { loadSigningKeys, publicKeyFingerprint, SIGNING_KEY_ENV, signingKeyEnvValue } from '../signing';

/**
 * Prints `UNI_SIGNING_PRIVATE_KEY=<base64 PEM>` for the keys in KEYS_DIR (generating a pair
 * there on first use), on stdout only, so it can be redirected straight into an env file:
 *   pnpm -s keys:uni:export >> ~/.config/sef/render.env
 * The fingerprint and any log lines go to stderr.
 */
console.log = (...args: unknown[]) => console.error(...args);
const keys = await loadSigningKeys(config.keysDir, '');
const pem = await readFile(path.join(config.keysDir, 'signing-private.pem'), 'utf8');
process.stdout.write(`${SIGNING_KEY_ENV}=${signingKeyEnvValue(createPrivateKey(pem))}\n`);
process.stderr.write(`fingerprint ${publicKeyFingerprint(keys.publicKeyPem)} (keys dir ${config.keysDir})\n`);
