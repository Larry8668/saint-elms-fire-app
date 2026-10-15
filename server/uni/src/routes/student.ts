import { Hono, type Context } from 'hono';
import type { Catalogue, CoursePackage, PackageManifest } from '@sef/shared';
import { requireRole, type AppEnv } from '../auth';
import { config } from '../config';
import type { UniDeps } from '../deps';
import { log } from '../logger';
import { ShareBodySchema, ShareLimitError } from '../store/shares';
import { signManifest } from '../signing';

/** Course delivery and peer shares. Students are pinned to their token's cohort; staff may pick one. */
export function studentRoutes(deps: UniDeps) {
  const app = new Hono<AppEnv>();
  const guard = requireRole(deps.keys, 'student', 'admin');

  const cohortFor = (c: Context<AppEnv>) => {
    const claims = c.get('claims');
    return claims.role === 'student' ? deps.releases.resolve(claims.cohortId) : deps.releases.resolve(c.req.query('cohort'));
  };

  app.get('/catalogue', guard, (c) => {
    const cohortId = cohortFor(c);
    const courses = [...deps.courseware.courses.values()]
      .filter((course) => deps.releases.isReleased(cohortId, course.summary.id))
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

  // Interim until PR-05 adds live enrolment state: replace this admin-only gate
  // with an approved-enrolment check while preserving visibility into future rows.
  // Listing a row does not grant download permission; packages remain release-gated.
  app.get('/programme', requireRole(deps.keys, 'admin'), (c) => {
    const programme = deps.programme;
    if (!programme) return c.json({ error: 'programme_unavailable' }, 503);
    return c.json({
      programme: programme.programme,
      semesters: programme.semesters,
      derivedCounts: programme.derivedCounts,
      availability: deps.availability ?? {},
    });
  });

  app.get('/courses/:courseId/package', guard, async (c) => {
    const cohortId = cohortFor(c);
    const courseId = c.req.param('courseId');
    const course = deps.courseware.courses.get(courseId);
    if (!course) return c.json({ error: 'not_found' }, 404);
    if (!deps.releases.isReleased(cohortId, courseId)) {
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
    const claims = c.get('claims');
    if (claims.role === 'student') {
      await deps.dispersal.record({ accountId: claims.sub, cohortId, courseId, version: manifest.version });
    }
    log.info('package_served', { cohortId, courseId, version: manifest.version, files: manifest.files.length });
    return c.json(body);
  });

  app.get('/shares', guard, (c) => c.json(deps.shares.list(cohortFor(c), c.req.query('since'))));

  app.post('/shares', guard, async (c) => {
    const claims = c.get('claims');
    if (claims.role !== 'student') return c.json({ error: 'forbidden' }, 403);
    const parsed = ShareBodySchema.safeParse(await c.req.json().catch(() => null));
    if (!parsed.success) return c.json({ error: 'invalid_share', issues: parsed.error.issues }, 400);
    try {
      const share = await deps.shares.add({
        ...parsed.data,
        cohortId: cohortFor(c),
        fromStudent: claims.name,
        fromAccountId: claims.sub,
      });
      await deps.audit.record(claims.sub, 'share_posted', `"${share.title}" to ${share.cohortId}`);
      return c.json(share, 201);
    } catch (error) {
      if (error instanceof ShareLimitError) return c.json({ error: 'rate_limited', message: error.message }, 429);
      throw error;
    }
  });

  return app;
}
