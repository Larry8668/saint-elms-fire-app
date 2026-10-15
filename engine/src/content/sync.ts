import { createHash, createPublicKey, verify } from 'node:crypto';
import { canonicalJson, CatalogueSchema, CoursePackageSchema, type Catalogue, type SyncStatus } from '@sef/shared';
import { log } from '../config';
import type { SettingsReader } from '../settings/store';
import { uniFetch, UniHttpError } from '../uni/client';
import { trustedUniKey } from '../uni/trust';
import type { ContentStore } from './store';

export class PackageVerificationError extends Error {}
export class SyncAuthError extends Error {}

/** Who is syncing. The uni decides the cohort from the token; cohortId here is only for display. */
export interface SyncIdentity {
  cohortId: string;
  uniToken?: string;
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
    const signatureOk = verify(null, Buffer.from(canonicalJson(pkg.manifest)), createPublicKey(keyPem), Buffer.from(pkg.signature, 'base64'));
    if (!signatureOk) throw new PackageVerificationError(`Signature check failed for ${courseId}`);

    const expected = new Map(pkg.manifest.files.map((f) => [f.path, f.sha256]));
    for (const file of pkg.files) {
      const hash = createHash('sha256').update(file.content).digest('hex');
      if (expected.get(file.path) !== hash) throw new PackageVerificationError(`Hash mismatch for ${file.path}`);
    }
    if (pkg.files.length !== expected.size) throw new PackageVerificationError('Package file count does not match manifest');

    await this.store.install({ ...course, version: pkg.manifest.version }, pkg.files);
    log.info('package_verified_and_installed', { courseId, version: pkg.manifest.version, files: pkg.files.length });
    return { courseId, version: pkg.manifest.version, files: pkg.files.length };
  }
}
