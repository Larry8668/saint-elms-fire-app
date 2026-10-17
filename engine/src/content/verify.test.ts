import assert from 'node:assert/strict';
import { createHash, generateKeyPairSync, sign as cryptoSign } from 'node:crypto';
import { test } from 'node:test';
import {
  canonicalJson,
  CONTENT_SCHEMA_VERSION,
  courseMetadataOf,
  deriveContentVersion,
  type CourseMetadata,
  type CourseSummary,
  type PackageFile,
  type PackageManifest,
} from '@sef/shared';
import { isTraversalSafePath, PackageVerificationError, verifyPackage } from './sync';

const ISSUER = 'Saint Elms University';
const { privateKey, publicKey } = generateKeyPairSync('ed25519');
const PUBLIC_PEM = publicKey.export({ type: 'spki', format: 'pem' }).toString();

const summary: CourseSummary = {
  id: 'waves',
  title: 'Waves',
  subjectId: 'physics',
  semesterNumber: 1,
  lessonCount: 2,
  version: 'ignored',
  support: false,
};

const metadata = (over: Partial<CourseMetadata> = {}): CourseMetadata => ({ ...courseMetadataOf(summary), ...over });

const sha = (content: string) => createHash('sha256').update(Buffer.from(content, 'utf8')).digest('hex');

const files: PackageFile[] = [
  { path: 'a.md', sha256: sha('alpha'), bytes: 5 },
  { path: 'b.md', sha256: sha('beta'), bytes: 4 },
];
const contents: Array<{ path: string; content: string }> = [
  { path: 'a.md', content: 'alpha' },
  { path: 'b.md', content: 'beta' },
];

interface Built {
  manifest: PackageManifest;
  signature: string;
  files: Array<{ path: string; content: string }>;
}

function build(
  over: {
    files?: PackageFile[];
    contents?: Array<{ path: string; content: string }>;
    metadata?: CourseMetadata;
    /** Build a schemaVersion 1 manifest with no metadata at all. */
    legacy?: boolean;
    courseId?: string;
    issuer?: string;
    schemaVersion?: number;
    /** Corrupt a field the signature covers, after signing. */
    tamper?: (manifest: PackageManifest) => void;
  } = {},
): Built {
  const manifestFiles = over.files ?? files;
  const meta = over.legacy ? undefined : (over.metadata ?? metadata());
  const manifest: PackageManifest = {
    schemaVersion: over.schemaVersion ?? (over.legacy ? 1 : CONTENT_SCHEMA_VERSION),
    courseId: over.courseId ?? 'waves',
    version: deriveContentVersion(manifestFiles, meta),
    issuedAt: '2026-10-15T00:00:00.000Z',
    issuer: over.issuer ?? ISSUER,
    ...(meta ? { metadata: meta } : {}),
    files: manifestFiles,
  };
  const signature = cryptoSign(null, Buffer.from(canonicalJson(manifest)), privateKey).toString('base64');
  over.tamper?.(manifest);
  return { manifest, signature, files: over.contents ?? contents };
}

const check = (pkg: Built, courseId = 'waves', issuer = ISSUER) => verifyPackage(pkg, PUBLIC_PEM, courseId, issuer);
const rejects = (pkg: Built, matcher: RegExp, courseId = 'waves') => {
  assert.throws(() => check(pkg, courseId), matcher);
};

test('a well-formed package verifies and reports its signed metadata', () => {
  const result = check(build());
  assert.equal(result.courseId, 'waves');
  assert.equal(result.signedMetadata, true);
  assert.equal(result.files.length, 2);
});

test('tampered metadata is caught, because the signature covers it', () => {
  // A field with no separate pre-signature check, so only the signature can catch it.
  rejects(build({ tamper: (m) => { m.metadata!.credits = 99; } }), /Signature check failed/);
});

test('tampering with the issuer is caught before verification even runs', () => {
  rejects(build({ tamper: (m) => { m.issuer = 'Someone Else University'; } }), /does not match this university/);
});

test('a package for a different course is refused before verification', () => {
  rejects(build({ courseId: 'optics' }), /Package is for optics, not waves/);
});

test('a package from another university is refused', () => {
  rejects(build({ issuer: 'Other University' }), /does not match this university/);
});

test('a manifest from a newer app generation is refused rather than guessed at', () => {
  rejects(build({ schemaVersion: CONTENT_SCHEMA_VERSION + 1 }), /newer than this app/);
});

test('a wrong signature is refused', () => {
  const pkg = build();
  rejects({ ...pkg, signature: Buffer.from('not-a-signature').toString('base64') }, /Signature check failed/);
});

test('a file whose content does not match its hash is refused', () => {
  // Same length as the original, so the byte-count check passes and the hash is what catches it.
  rejects(build({ contents: [{ path: 'a.md', content: 'ALPHA' }, contents[1]!] }), /Hash mismatch for a\.md/);
});

test('a file whose byte length disagrees with the manifest is refused', () => {
  const wrongSize: PackageFile[] = [{ path: 'a.md', sha256: files[0]!.sha256, bytes: 99 }, files[1]!];
  rejects(build({ files: wrongSize }), /Size mismatch for a\.md/);
});

test('a duplicate file cannot satisfy two manifest entries', () => {
  const duplicated = [contents[0]!, contents[0]!];
  rejects(build({ contents: duplicated }), /Duplicate file in package|missing/);
});

test('a duplicate path in the manifest is refused', () => {
  const dup: PackageFile[] = [files[0]!, files[0]!, files[1]!];
  rejects(build({ files: dup }), /Duplicate path in manifest/);
});

test('a missing file is refused even when the count happens to match', () => {
  // Three manifest entries, two files, one repeated: length alone would have passed.
  const three: PackageFile[] = [files[0]!, files[1]!, { path: 'c.md', sha256: sha('gamma'), bytes: 5 }];
  rejects(build({ files: three, contents: [contents[0]!, contents[0]!] }), /missing|Duplicate file/);
});

test('a file the manifest does not list is refused', () => {
  rejects(build({ contents: [...contents, { path: 'extra.md', content: 'surprise' }] }), /does not list/);
});

test('a traversal path is refused in both the manifest and the payload', () => {
  rejects(build({ files: [{ path: '../escape.md', sha256: sha('x'), bytes: 1 }, files[1]!] }), /Unsafe path in manifest/);
  rejects(build({ contents: [{ path: '../../etc/passwd', content: 'x' }, contents[1]!] }), /Unsafe path in (manifest|package)/);
});

test('path safety rejects the shapes that actually escape', () => {
  for (const bad of ['../x', 'a/../../x', '/etc/passwd', '', 'a\0b']) assert.equal(isTraversalSafePath(bad), false, bad);
  for (const good of ['a.md', 'sub/dir/b.md', 'dots..in-name.md']) assert.equal(isTraversalSafePath(good), true, good);
});

test('a version that disagrees with its own contents is refused', () => {
  const pkg = build();
  rejects({ ...pkg, manifest: { ...pkg.manifest, version: 'v1-deadbeefdeadbeef' } }, /does not match its own contents|Signature check failed/);
});

test('a metadata-only change produces a different version', () => {
  const before = deriveContentVersion(files, metadata());
  const after = deriveContentVersion(files, metadata({ credits: 5 }));
  assert.notEqual(before, after, 'a corrected credit total must change the version');
});

test('a file-only change produces a different version', () => {
  const before = deriveContentVersion(files, metadata());
  const after = deriveContentVersion([{ ...files[0]!, sha256: sha('changed') }, files[1]!], metadata());
  assert.notEqual(before, after);
});

test('the version is stable for identical inputs regardless of file order', () => {
  const a = deriveContentVersion(files, metadata());
  const b = deriveContentVersion([files[1]!, files[0]!], metadata());
  assert.equal(a, b);
});

test('a legacy manifest without signed metadata still installs, but is flagged', () => {
  const result = check(build({ legacy: true }));
  assert.equal(result.signedMetadata, false, 'it must not claim metadata was signed');
});

test('a legacy manifest cannot smuggle in metadata after signing', () => {
  // Adding metadata changes the canonical bytes the signature covered, so it must fail.
  const forged = build({ legacy: true, tamper: (m) => { m.metadata = metadata(); } });
  assert.throws(() => check(forged), PackageVerificationError);
});

test('a legacy manifest cannot claim a version derived from metadata it never carried', () => {
  const forged = build({ legacy: true, tamper: (m) => { m.metadata = metadata({ credits: 7 }); } });
  assert.throws(() => check(forged), PackageVerificationError);
});

test('an empty trust anchor refuses instead of matching a blank issuer', () => {
  // A failed anchor lookup must abort, not weaken the comparison to ''.
  assert.throws(() => check(build({ issuer: '' }), 'waves', ''), /No pinned issuer/);
  assert.throws(() => check(build(), 'waves', ''), /No pinned issuer/);
});

test('subject feeds ride in signed metadata: reported when signed, refused when tampered, absent for legacy', () => {
  const feeds = [{ url: 'https://www.nasa.gov/feed/', title: 'NASA news' }];
  assert.deepEqual(check(build({ metadata: metadata({ subjectFeeds: feeds }) })).subjectFeeds, feeds);
  rejects(build({ metadata: metadata({ subjectFeeds: feeds }), tamper: (m) => { m.metadata!.subjectFeeds = [{ url: 'https://evil.example/feed', title: 'x' }]; } }), /Signature check failed/);
  assert.equal(check(build({ legacy: true })).subjectFeeds, undefined);
});

test('a course without feeds keeps the same content version as before feeds existed', () => {
  const { subjectFeeds: _none, ...withoutKey } = metadata();
  assert.equal(deriveContentVersion(files, metadata()), deriveContentVersion(files, withoutKey as CourseMetadata));
});
