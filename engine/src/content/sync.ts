import { createHash, createPublicKey, verify } from 'node:crypto';
import path from 'node:path';
import { canonicalJson, CatalogueSchema, CoursePackageSchema, type Catalogue, type SyncStatus } from '@sef/shared';
import { config, log } from '../config';
import { readText, writeFileAtomic } from '../lib/fs';
import type { SettingsStore } from '../settings/store';
import type { ContentStore } from './store';

export class PackageVerificationError extends Error {}

const TRUSTED_KEY_FILE = () => path.join(config.paths.trust, 'uni-public.pem');
const FETCH_TIMEOUT_MS = 15000;

async function getJson(url: string): Promise<unknown> {
  const res = await fetch(url, { signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) });
  if (!res.ok) throw new Error(`${url} → HTTP ${res.status}`);
  return res.json();
}

/** Pulls catalogue + signed course packages from the university server. */
export class ContentSync {
  constructor(
    private readonly settings: SettingsStore,
    private readonly store: ContentStore,
  ) {}

  private async base() {
    const s = await this.settings.get();
    return { url: s.uniServerUrl.replace(/\/+$/, ''), cohort: s.cohortId };
  }

  async catalogue(): Promise<Catalogue | null> {
    const { url, cohort } = await this.base();
    try {
      return CatalogueSchema.parse(await getJson(`${url}/v1/catalogue?cohort=${encodeURIComponent(cohort)}`));
    } catch (error) {
      log.warn('uni_catalogue_unreachable', { url, error: (error as Error).message });
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
    return {
      uniReachable: Boolean(catalogue),
      courses: [...rows.values()].sort((a, b) => a.semesterNumber - b.semesterNumber || a.title.localeCompare(b.title)),
    };
  }

  /** Trust on first use: the first key seen is pinned; a different key later is refused. */
  private async trustedKey(): Promise<string> {
    const { url } = await this.base();
    const remote = (await getJson(`${url}/v1/keys`)) as { publicKeyPem: string };
    const pinned = await readText(TRUSTED_KEY_FILE());
    if (!pinned) {
      await writeFileAtomic(TRUSTED_KEY_FILE(), remote.publicKeyPem);
      log.info('uni_key_pinned', { url });
      return remote.publicKeyPem;
    }
    if (pinned.trim() !== remote.publicKeyPem.trim()) {
      throw new PackageVerificationError('University signing key changed since first sync. Refusing packages.');
    }
    return pinned;
  }

  async install(courseId: string): Promise<{ courseId: string; version: string; files: number }> {
    const { url, cohort } = await this.base();
    const catalogue = await this.catalogue();
    const course = catalogue?.courses.find((c) => c.id === courseId);
    if (!course) throw new Error(`Course ${courseId} is not released to cohort ${cohort}`);

    const pkg = CoursePackageSchema.parse(
      await getJson(`${url}/v1/courses/${encodeURIComponent(courseId)}/package?cohort=${encodeURIComponent(cohort)}`),
    );
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
