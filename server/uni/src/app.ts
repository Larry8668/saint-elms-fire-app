import { Hono } from 'hono';
import { cors } from 'hono/cors';
import type { Catalogue, CoursePackage, PackageManifest } from '@sef/shared';
import { config } from './config';
import type { CoursewareIndex } from './courseware';
import { errorFields, log } from './logger';
import { isReleased, resolveCohort, type Releases } from './releases';
import { NewShareSchema, ShareLimitError, type ShareStore } from './shares';
import { signManifest, type SigningKeys } from './signing';

export interface UniDeps {
  courseware: CoursewareIndex;
  releases: Releases;
  keys: SigningKeys;
  shares: ShareStore;
}

export function createApp(deps: UniDeps) {
  const app = new Hono();
  app.use('*', cors());

  app.use('*', async (c, next) => {
    const started = Date.now();
    await next();
    log.info('request', { method: c.req.method, path: c.req.path, status: c.res.status, ms: Date.now() - started });
  });

  app.onError((error, c) => {
    log.error('request_failed', { path: c.req.path, ...errorFields(error) });
    return c.json({ error: 'internal_error', message: error.message }, 500);
  });

  app.get('/health', (c) =>
    c.json({ ok: true, service: 'uni', issuer: config.issuer, courses: deps.courseware.courses.size }),
  );

  app.get('/v1/keys', (c) => c.json({ issuer: config.issuer, algorithm: 'ed25519', publicKeyPem: deps.keys.publicKeyPem }));

  app.get('/v1/cohorts', (c) =>
    c.json(Object.entries(deps.releases.cohorts).map(([id, cohort]) => ({ id, name: cohort.name }))),
  );

  app.get('/v1/catalogue', (c) => {
    const cohortId = resolveCohort(deps.releases, c.req.query('cohort'));
    const courses = [...deps.courseware.courses.values()]
      .filter((course) => isReleased(deps.releases, cohortId, course.summary.id))
      .map((course) => course.summary)
      .sort((a, b) => a.semesterNumber - b.semesterNumber || a.title.localeCompare(b.title));
    const body: Catalogue = {
      programmeId: deps.courseware.programmeId,
      programmeName: deps.courseware.programmeName,
      cohortId,
      generatedAt: new Date().toISOString(),
      courses,
    };
    return c.json(body);
  });

  app.get('/v1/courses/:courseId/package', (c) => {
    const cohortId = resolveCohort(deps.releases, c.req.query('cohort'));
    const courseId = c.req.param('courseId');
    const course = deps.courseware.courses.get(courseId);
    if (!course) return c.json({ error: 'not_found' }, 404);
    if (!isReleased(deps.releases, cohortId, courseId)) {
      log.warn('package_refused_unreleased', { cohortId, courseId });
      return c.json({ error: 'not_released' }, 403);
    }
    const manifest: PackageManifest = {
      courseId,
      version: course.summary.version,
      issuedAt: new Date().toISOString(),
      issuer: config.issuer,
      files: course.files.map(({ path, sha256, bytes }) => ({ path, sha256, bytes })),
    };
    const body: CoursePackage = {
      manifest,
      signature: signManifest(manifest, deps.keys),
      files: course.files.map(({ path, content }) => ({ path, content })),
    };
    log.info('package_served', { cohortId, courseId, version: manifest.version, files: manifest.files.length });
    return c.json(body);
  });

  app.get('/v1/shares', (c) => {
    const cohortId = resolveCohort(deps.releases, c.req.query('cohort'));
    return c.json(deps.shares.list(cohortId, c.req.query('since')));
  });

  app.post('/v1/shares', async (c) => {
    const parsed = NewShareSchema.safeParse(await c.req.json().catch(() => null));
    if (!parsed.success) return c.json({ error: 'invalid_share', issues: parsed.error.issues }, 400);
    try {
      const share = await deps.shares.add(parsed.data);
      log.info('share_relayed', { id: share.id, cohortId: share.cohortId, from: share.fromStudent });
      return c.json(share, 201);
    } catch (error) {
      if (error instanceof ShareLimitError) return c.json({ error: 'rate_limited', message: error.message }, 429);
      throw error;
    }
  });

  return app;
}
