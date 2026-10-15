import { Hono, type Context } from 'hono';
import { CONTRACT_VERSION, type Catalogue, type CoursePackage, type PackageManifest, type ProgrammeCatalogue } from '@sef/shared';
import { requireCourseAccess, requireProgrammeAccess, requireSession, type AppEnv } from '../authorization';
import { config } from '../config';
import type { UniDeps } from '../deps';
import { log } from '../logger';
import { ShareBodySchema, ShareLimitError } from '../store/shares';
import { signManifest } from '../signing';

/**
 * Course delivery and peer shares. Legacy-token students are pinned to their token
 * cohort; session students are pinned to their live enrolment's cohort; staff may
 * pick a cohort explicitly. A session accessor's cohort must still exist in the
 * release plan — admission never silently widens it.
 */
export function studentRoutes(deps: UniDeps) {
  const app = new Hono<AppEnv>();
  const guard = requireCourseAccess(deps);
  const session = requireSession(deps);

  const cohortFor = (c: Context<AppEnv>): string | null => {
    const accessor = c.get('accessor');
    if (accessor.kind === 'legacy') {
      return accessor.claims.role === 'student'
        ? deps.releases.resolve(accessor.claims.cohortId)
        : deps.releases.resolve(c.req.query('cohort'));
    }
    const { admission } = accessor;
    if (admission.enrolment?.cohort_code && deps.releases.has(admission.enrolment.cohort_code)) {
      return admission.enrolment.cohort_code;
    }
    if (admission.staffRoles.length > 0) {
      const requested = c.req.query('cohort');
      return requested && deps.releases.has(requested) ? requested : null;
    }
    return null;
  };

  app.get('/catalogue', guard, (c) => {
    const cohortId = cohortFor(c);
    if (!cohortId) return c.json({ error: 'cohort_unavailable' }, 403);
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

  /**
   * What a verified applicant may see before being approved: the programme's identity only,
   * enough to apply and nothing more. The academic rows, semesters and release state stay
   * behind `requireProgrammeAccess`, so this cannot become a way to read the curriculum
   * before admission.
   */
  app.get('/programmes', session, (c) => {
    if (!c.get('principal').emailVerified) return c.json({ error: 'verification_required' }, 403);
    const programme = deps.programme?.programme;
    if (!programme) return c.json({ error: 'programme_unavailable' }, 503);
    const body: ProgrammeCatalogue = {
      schemaVersion: CONTRACT_VERSION,
      programmes: [{ id: programme.id, name: programme.name, institution: programme.institution }],
    };
    return c.json(body);
  });

  // Programme visibility requires staff access or a live approved enrolment.
  // Listing a row does not grant download permission; packages remain release-gated.
  app.get('/programme', requireProgrammeAccess(deps), (c) => {
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
    if (!cohortId) return c.json({ error: 'cohort_unavailable' }, 403);
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
    const accessor = c.get('accessor');
    if (accessor.kind === 'legacy' && accessor.claims.role === 'student') {
      await deps.dispersal.record({ accountId: accessor.claims.sub, cohortId, courseId, version: manifest.version });
    }
    log.info('package_served', { cohortId, courseId, version: manifest.version, files: manifest.files.length });
    return c.json(body);
  });

  app.get('/shares', guard, (c) => {
    const cohortId = cohortFor(c);
    if (!cohortId) return c.json({ error: 'cohort_unavailable' }, 403);
    return c.json(deps.shares.list(cohortId, c.req.query('since')));
  });

  app.post('/shares', guard, async (c) => {
    const accessor = c.get('accessor');
    // Session accessors are students (or staff previewing); publication stays a
    // student action until PR-23 introduces the reviewed sharing workflow.
    const author =
      accessor.kind === 'legacy'
        ? { isStudent: accessor.claims.role === 'student', name: accessor.claims.name, id: accessor.claims.sub }
        : { isStudent: accessor.admission.staffRoles.length === 0, name: accessor.principal.name, id: accessor.principal.userId };
    if (!author.isStudent) return c.json({ error: 'forbidden' }, 403);
    const cohortId = cohortFor(c);
    if (!cohortId) return c.json({ error: 'cohort_unavailable' }, 403);
    const parsed = ShareBodySchema.safeParse(await c.req.json().catch(() => null));
    if (!parsed.success) return c.json({ error: 'invalid_share', issues: parsed.error.issues }, 400);
    try {
      const share = await deps.shares.add({
        ...parsed.data,
        cohortId,
        fromStudent: author.name,
        fromAccountId: author.id,
      });
      await deps.audit.record(author.id, 'share_posted', `"${share.title}" to ${share.cohortId}`);
      return c.json(share, 201);
    } catch (error) {
      if (error instanceof ShareLimitError) return c.json({ error: 'rate_limited', message: error.message }, 429);
      throw error;
    }
  });

  return app;
}
