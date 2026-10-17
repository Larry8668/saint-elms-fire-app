import assert from 'node:assert/strict';
import { createPublicKey, generateKeyPairSync, verify } from 'node:crypto';
import { mkdtemp, readdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { canonicalJson, CONTENT_SCHEMA_VERSION, courseMetadataOf, type PackageManifest } from '@sef/shared';
import { loadSigningKeys, publicKeyFingerprint, signingKeyEnvValue, signManifest } from './signing';

const manifest: PackageManifest = {
  schemaVersion: CONTENT_SCHEMA_VERSION,
  courseId: 'waves',
  version: 'abc123',
  issuedAt: '2026-10-14T00:00:00Z',
  issuer: 'Saint Elms University',
  metadata: courseMetadataOf({
    id: 'waves',
    title: 'Waves',
    subjectId: 'physics',
    semesterNumber: 1,
    lessonCount: 3,
    version: 'abc123',
    support: false,
  }),
  files: [{ path: 'lesson.md', sha256: 'deadbeef', bytes: 10 }],
};

const verifyWith = (pem: string, m: PackageManifest, sig: string) => verify(null, Buffer.from(canonicalJson(m)), createPublicKey(pem), Buffer.from(sig, 'base64'));

test('a signed manifest verifies with the published key and survives key reload', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'sef-keys-'));
  const keys = await loadSigningKeys(dir);
  const signature = signManifest(manifest, keys);
  assert.ok(verifyWith(keys.publicKeyPem, manifest, signature));

  const reloaded = await loadSigningKeys(dir);
  assert.equal(reloaded.publicKeyPem, keys.publicKeyPem);
});

test('any tampering with the manifest breaks the signature', async () => {
  const keys = await loadSigningKeys(await mkdtemp(path.join(tmpdir(), 'sef-keys-')));
  const signature = signManifest(manifest, keys);
  const tampered = { ...manifest, files: [{ ...manifest.files[0]!, sha256: 'cafebabe' }] };
  assert.equal(verifyWith(keys.publicKeyPem, tampered, signature), false);
});

const envPem = () => generateKeyPairSync('ed25519').privateKey;

test('an env-supplied key signs, verifies, and writes nothing to the keys dir', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'sef-keys-'));
  const privateKey = envPem();
  const keys = await loadSigningKeys(dir, signingKeyEnvValue(privateKey));
  assert.ok(verifyWith(keys.publicKeyPem, manifest, signManifest(manifest, keys)));
  assert.equal(keys.publicKeyPem, createPublicKey(privateKey).export({ type: 'spki', format: 'pem' }).toString());
  assert.deepEqual(await readdir(dir), []);
});

test('the env key has the same fingerprint across two boots, in base64 or raw PEM form', async () => {
  const privateKey = envPem();
  const dir = await mkdtemp(path.join(tmpdir(), 'sef-keys-'));
  const first = await loadSigningKeys(dir, signingKeyEnvValue(privateKey));
  const pem = privateKey.export({ type: 'pkcs8', format: 'pem' }).toString();
  const second = await loadSigningKeys(dir, pem);
  const escaped = await loadSigningKeys(dir, pem.replace(/\n/g, '\\n'));
  const fp = publicKeyFingerprint(first.publicKeyPem);
  assert.match(fp, /^[0-9a-f]{16}$/);
  assert.equal(publicKeyFingerprint(second.publicKeyPem), fp);
  assert.equal(publicKeyFingerprint(escaped.publicKeyPem), fp);
});

test('a malformed env key refuses to boot with a clear error that does not echo the value', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'sef-keys-'));
  const secretish = 'bm90LWEta2V5LWF0LWFsbA==';
  await assert.rejects(loadSigningKeys(dir, secretish), (error: Error) => {
    assert.match(error.message, /UNI_SIGNING_PRIVATE_KEY is set but is not a PEM private key/);
    assert.ok(!error.message.includes(secretish));
    return true;
  });
  const rsa = generateKeyPairSync('rsa', { modulusLength: 2048 }).privateKey.export({ type: 'pkcs8', format: 'pem' }).toString();
  await assert.rejects(loadSigningKeys(dir, rsa), /must be an ed25519 key/);
  assert.deepEqual(await readdir(dir), []);
});

test('an unset or blank env value keeps the file behaviour', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'sef-keys-'));
  const keys = await loadSigningKeys(dir, '  ');
  assert.deepEqual((await readdir(dir)).sort(), ['signing-private.pem', 'signing-public.pem']);
  assert.equal((await loadSigningKeys(dir, undefined)).publicKeyPem, keys.publicKeyPem);
});
