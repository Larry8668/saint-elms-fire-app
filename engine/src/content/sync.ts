import { createHash, createPublicKey, verify } from 'node:crypto';
import {
  canonicalJson,
  CatalogueSchema,
  CONTENT_SCHEMA_VERSION,
  CoursePackageSchema,
  deriveContentVersion,
  courseMetadataOf,
  hasSignedMetadata,
  type Catalogue,
  type CourseSummary,
  type PackageFile,
  type PackageManifest,
  type SyncStatus,
} from '@sef/shared';
import { log } from '../config';
import type { SettingsReader } from '../settings/store';
import { uniFetch, UniHttpError } from '../uni/client';
import { trustedUniIssuer, trustedUniKey } from '../uni/trust';
import type { ContentStore } from './store';

export class PackageVerificationError extends Error {}
export class SyncAuthError extends Error {}

/** Who is syncing. The uni decides the cohort from the token; cohortId here is only for display. */
export interface SyncIdentity {
  cohortId: string;
  uniToken?: string;
}

/**
 * Everything that must hold before a single byte is written. A package that fails any of
 * these leaves the existing installation untouched.
 */
export interface VerifiedPackage {
  courseId: string;
  version: string;
  files: Array<{ path: string; content: string }>;
  /** False when the manifest predates signed metadata; still installable, but flagged. */
  signedMetadata: boolean;
}

/** Rejects absolute paths, `..` segments and anything that would land outside the course dir. */
export const isTraversalSafePath = (candidate: string): boolean =>
  candidate.length > 0 &&
  !candidate.startsWith('/') &&
  !candidate.includes('\0') &&
  !candidate.split(/[\\/]/).includes('..');

export function verifyPackage(pkg: { manifest: PackageManifest; signature: string; files: Array<{ path: string; content: string }> }, keyPem: string, requestedCourseId: string, expectedIssuer: string): VerifiedPackage {
  const { manifest } = pkg;

  // Identity before signature: a package for a different course is not worth verifying twice.
  if (manifest.courseId !== requestedCourseId) {
    throw new PackageVerificationError(`Package is for ${manifest.courseId}, not ${requestedCourseId}`);
  }
  // An empty anchor would admit a package whose manifest issuer is also empty.
  if (!expectedIssuer.trim()) {
    throw new PackageVerificationError('No pinned issuer for this university');
  }
  if (manifest.issuer !== expectedIssuer) {
    throw new PackageVerificationError(`Package issuer ${manifest.issuer} does not match this university`);
  }
  if (manifest.schemaVersion > CONTENT_SCHEMA_VERSION) {
    throw new PackageVerificationError(`Package schema v${manifest.schemaVersion} is newer than this app understands`);
  }

  const signatureOk = verify(null, Buffer.from(canonicalJson(manifest)), createPublicKey(keyPem), Buffer.from(pkg.signature, 'base64'));
  if (!signatureOk) throw new PackageVerificationError(`Signature check failed for ${requestedCourseId}`);

  const manifestPaths = new Set<string>();
  const expected = new Map<string, PackageFile>();
  for (const file of manifest.files) {
    if (!isTraversalSafePath(file.path)) throw new PackageVerificationError(`Unsafe path in manifest: ${file.path}`);
    // A repeated path would let one file satisfy two entries while the set stays "unique".
    if (manifestPaths.has(file.path)) throw new PackageVerificationError(`Duplicate path in manifest: ${file.path}`);
    manifestPaths.add(file.path);
    expected.set(file.path, file);
  }

  const seen = new Set<string>();
  for (const file of pkg.files) {
    if (!isTraversalSafePath(file.path)) throw new PackageVerificationError(`Unsafe path in package: ${file.path}`);
    const declared = expected.get(file.path);
    if (!declared) throw new PackageVerificationError(`Package carries a file the manifest does not list: ${file.path}`);
    if (seen.has(file.path)) throw new PackageVerificationError(`Duplicate file in package: ${file.path}`);
    seen.add(file.path);

    const bytes = Buffer.from(file.content, 'utf8');
    if (bytes.byteLength !== declared.bytes) {
      throw new PackageVerificationError(`Size mismatch for ${file.path}: expected ${declared.bytes}, got ${bytes.byteLength}`);
    }
    if (createHash('sha256').update(bytes).digest('hex') !== declared.sha256) {
      throw new PackageVerificationError(`Hash mismatch for ${file.path}`);
    }
  }

  // Count equality alone would pass if one listed file were missing and another repeated;
  // comparing the sets catches both directions.
  const missing = [...manifestPaths].filter((p) => !seen.has(p));
  if (missing.length) throw new PackageVerificationError(`Package is missing ${missing.length} file(s) the manifest lists, e.g. ${missing[0]}`);

  const signedMetadata = hasSignedMetadata(manifest);
  if (signedMetadata && manifest.metadata!.lessonCount < 0) {
    throw new PackageVerificationError('Signed metadata has a negative lesson count');
  }

  // The version is derived from files and metadata together, so a metadata-only change is
  // visible as a new version instead of a silent no-op.
  const derived = deriveContentVersion(manifest.files, manifest.metadata);
  if (derived !== manifest.version) {
    throw new PackageVerificationError(`Manifest version ${manifest.version} does not match its own contents (${derived})`);
  }

  return { courseId: manifest.courseId, version: manifest.version, files: pkg.files, signedMetadata };
}

/** Pulls catalogue + signed course packages from the university server for one profile. */
export class ContentSync {
  private authRejected = false;

  constructor(
    private readonly settings: SettingsReader,
    private readonly store: ContentStore,
    private readonly identity: () => Promise<SyncIdentity>,
  ) {}

  private async request<T>(pathname: string): Promise<T> {
    const { uniServerUrl } = await this.settings.get();
    const { uniToken } = await this.identity();
    if (!uniToken) throw new SyncAuthError('This profile has no university session. Sign in while online to sync.');
    try {
      const body = await uniFetch<T>(uniServerUrl, pathname, { token: uniToken });
      this.authRejected = false;
      return body;
    } catch (error) {
      if (error instanceof UniHttpError && error.status === 401) {
        this.authRejected = true;
        throw new SyncAuthError('The university no longer accepts this session. Sign out and sign in again while online.');
      }
      throw error;
    }
  }

  async catalogue(): Promise<Catalogue | null> {
    try {
      return CatalogueSchema.parse(await this.request('/v1/catalogue'));
    } catch (error) {
      log.warn('uni_catalogue_unavailable', { error: (error as Error).message });
      return null;
    }
  }

  async status(): Promise<SyncStatus> {
    const [catalogue, installed] = await Promise.all([this.catalogue(), this.store.installed()]);
    const rows = new Map<string, SyncStatus['courses'][number]>();
    for (const course of catalogue?.courses ?? []) {
      const local = installed[course.id];
      rows.set(course.id, {
        id: course.id,
        title: course.title,
        semesterNumber: course.semesterNumber,
        subjectId: course.subjectId,
        lessonCount: course.lessonCount,
        remoteVersion: course.version,
        localVersion: local?.version,
        state: !local ? 'available' : local.version === course.version ? 'installed' : 'update',
        support: course.support,
        signedMetadata: local ? local.signedMetadata : undefined,
      });
    }
    for (const local of Object.values(installed)) {
      if (rows.has(local.id)) continue;
      rows.set(local.id, {
        id: local.id,
        title: local.title,
        semesterNumber: local.semesterNumber,
        subjectId: local.subjectId,
        lessonCount: local.lessonCount,
        localVersion: local.version,
        state: 'local-only',
        support: local.support,
        signedMetadata: local.signedMetadata,
      });
    }
    const identity = await this.identity();
    return {
      uniReachable: Boolean(catalogue),
      authRequired: this.authRejected || !identity.uniToken,
      cohortId: catalogue?.cohortId ?? identity.cohortId,
      courses: [...rows.values()].sort((a, b) => a.semesterNumber - b.semesterNumber || a.title.localeCompare(b.title)),
    };
  }

  private async trustedKey(): Promise<string> {
    const { uniServerUrl } = await this.settings.get();
    return trustedUniKey(uniServerUrl);
  }

  async install(courseId: string): Promise<{ courseId: string; version: string; files: number }> {
    const catalogue = await this.catalogue();
    const course = catalogue?.courses.find((c) => c.id === courseId);
    if (!course) throw new Error(`Course ${courseId} is not released to your cohort`);

    const pkg = CoursePackageSchema.parse(await this.request(`/v1/courses/${encodeURIComponent(courseId)}/package`));
    const keyPem = await this.trustedKey();
    const verified = verifyPackage(pkg, keyPem, courseId, await this.issuer());

    await this.store.install({ ...course, version: verified.version } satisfies CourseSummary, verified.files, verified.signedMetadata);
    if (!verified.signedMetadata) {
      // Honest about what this install is: hashes were verified, academic metadata was not signed.
      log.warn('package_installed_without_signed_metadata', { courseId, version: verified.version });
    }
    log.info('package_verified_and_installed', {
      courseId,
      version: verified.version,
      files: verified.files.length,
      signedMetadata: verified.signedMetadata,
    });
    return { courseId, version: verified.version, files: verified.files.length };
  }

  /** The issuer this device trusts: pinned beside the signing key, so a network failure aborts the install. */
  private async issuer(): Promise<string> {
    const { uniServerUrl } = await this.settings.get();
    return trustedUniIssuer(uniServerUrl);
  }
}

export { courseMetadataOf };
