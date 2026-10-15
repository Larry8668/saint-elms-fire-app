import assert from 'node:assert/strict';
import { generateKeyPairSync } from 'node:crypto';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { createServer, type Server } from 'node:http';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { after, test } from 'node:test';
import type { AddressInfo } from 'node:net';

const dataDir = await mkdtemp(path.join(tmpdir(), 'sef-engine-trust-'));
process.env.ENGINE_DATA_DIR = dataDir;
/** Port 9 (discard) refuses connections, which is exactly "the uni is unreachable". */
process.env.UNI_SERVER_URL = 'http://127.0.0.1:9';

const { trustedUniIssuer, trustedUniKey, UniKeyMismatchError } = await import('./trust');
const { config } = await import('../config');

const uniKeys = generateKeyPairSync('ed25519');
const UNI_KEY_PEM = uniKeys.publicKey.export({ type: 'spki', format: 'pem' }).toString();
const ISSUER = 'Saint Elms University';

const TRUSTED_KEY_FILE = path.join(config.paths.trust, 'uni-public.pem');
const TRUSTED_ISSUER_FILE = path.join(config.paths.trust, 'uni-issuer.txt');

/** A stub uni whose `/v1/keys` answer the test controls between requests. */
async function fakeUni(answer: () => { publicKeyPem: string; issuer?: string }): Promise<{ url: string; close: () => Promise<void> }> {
  const server: Server = createServer((req, res) => {
    if (req.url === '/v1/keys') {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ issuer: 'uni', algorithm: 'ed25519', ...answer() }));
      return;
    }
    res.writeHead(404).end();
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as AddressInfo;
  return {
    url: `http://127.0.0.1:${port}`,
    close: () => new Promise((resolve) => server.close(() => resolve())),
  };
}

async function cleanTrust() {
  await rm(TRUSTED_KEY_FILE, { force: true });
  await rm(TRUSTED_ISSUER_FILE, { force: true });
}

after(async () => {
  await rm(dataDir, { recursive: true, force: true });
});

test('first contact pins the key and the issuer together', async () => {
  await cleanTrust();
  const uni = await fakeUni(() => ({ publicKeyPem: UNI_KEY_PEM, issuer: ISSUER }));
  try {
    assert.equal(await trustedUniIssuer(uni.url), ISSUER);
  } finally {
    await uni.close();
  }
});

test('a device that pinned only the key migrates on the next key-matched answer', async () => {
  await cleanTrust();
  await writeFile(TRUSTED_KEY_FILE, UNI_KEY_PEM);
  const uni = await fakeUni(() => ({ publicKeyPem: UNI_KEY_PEM, issuer: ISSUER }));
  try {
    assert.equal(await trustedUniIssuer(uni.url), ISSUER);
  } finally {
    await uni.close();
  }
});

test('a changed issuer under the same key is refused', async () => {
  await cleanTrust();
  let remoteIssuer = ISSUER;
  const uni = await fakeUni(() => ({ publicKeyPem: UNI_KEY_PEM, issuer: remoteIssuer }));
  try {
    await trustedUniKey(uni.url);
    remoteIssuer = 'Someone Else University';
    await assert.rejects(() => trustedUniIssuer(uni.url), UniKeyMismatchError);
  } finally {
    await uni.close();
  }
});

test('a changed key is refused regardless of issuer', async () => {
  await cleanTrust();
  const otherKeys = generateKeyPairSync('ed25519');
  const uni = await fakeUni(() => ({
    publicKeyPem: otherKeys.publicKey.export({ type: 'spki', format: 'pem' }).toString(),
    issuer: ISSUER,
  }));
  try {
    await writeFile(TRUSTED_KEY_FILE, UNI_KEY_PEM);
    await writeFile(TRUSTED_ISSUER_FILE, ISSUER);
    await assert.rejects(() => trustedUniIssuer(uni.url), UniKeyMismatchError);
  } finally {
    await uni.close();
  }
});

test('a uni that names no issuer is refused rather than pinned to the empty string', async () => {
  await cleanTrust();
  const uni = await fakeUni(() => ({ publicKeyPem: UNI_KEY_PEM, issuer: '' }));
  try {
    await assert.rejects(() => trustedUniIssuer(uni.url), UniKeyMismatchError);
  } finally {
    await uni.close();
  }
});

test('an unreachable uni with no pins fails closed instead of returning a placeholder', async () => {
  await cleanTrust();
  await assert.rejects(() => trustedUniIssuer(process.env.UNI_SERVER_URL!));
});
