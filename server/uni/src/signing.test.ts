import assert from 'node:assert/strict';
import { createPublicKey, verify } from 'node:crypto';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { canonicalJson, CONTENT_SCHEMA_VERSION, courseMetadataOf, type PackageManifest } from '@sef/shared';
import { loadSigningKeys, signManifest } from './signing';

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
