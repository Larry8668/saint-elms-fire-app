import { Hono } from 'hono';
import { z } from 'zod';
import {
  AccountPatchSchema,
  NewAccountSchema,
  type AdminCourse,
  type AdminLesson,
  type AdminOverview,
  type AdminShare,
  type CohortSummary,
} from '@sef/shared';
import { requireRole, type AppEnv } from '../auth';
import { config } from '../config';
import type { UniDeps } from '../deps';
import { countPublishedSharesSince } from '../shares';
import { AccountExistsError } from '../store/accounts';

const WEEK_MS = 7 * 24 * 60 * 60 * 1000;

const ReleaseToggleSchema = z.object({
  courseIds: z.array(z.string().min(1)).min(1),
  released: z.boolean(),
});

const NewCohortSchema = z.object({
  id: z.string().regex(/^[a-z0-9-]+$/).max(60),
  name: z.string().trim().min(1).max(120),
  copyFrom: z.string().optional(),
});

export function adminRoutes(deps: UniDeps) {
  const app = new Hono<AppEnv>();
  // Session-authenticated requests share this prefix and fall through to staffRoutes;
  // the guard is per-route so only sef1 admin bearers reach these handlers.
  const admin = requireRole(deps.keys, 'admin');
  const actor = (c: { get: (k: 'claims') => { sub: string } }) => c.get('claims').sub;

  const currentVersion = (courseId: string) => deps.courseware.courses.get(courseId)?.summary.version;
  const isRecent = (iso: string) => Date.now() - Date.parse(iso) < WEEK_MS;

  const cohortSummaries = (): CohortSummary[] => {
    const students = deps.accounts.list().filter((a) => a.role === 'student');
    return deps.releases.cohorts().map((cohort) => ({
      id: cohort.id,
      name: cohort.name,
      courses: cohort.courses,
      students: students.filter((s) => s.cohortId === cohort.id).length,
    }));
  };

  app.get('/overview', admin, async (c) => {
    const dispersal = deps.dispersal.all();
    const cohorts = cohortSummaries();
    // With the database up, the stat reflects the authenticated share surface;
    // without it only the quarantined file relay exists to count.
    const sharesLast7Days = deps.pool
      ? await countPublishedSharesSince(deps.pool, new Date(Date.now() - WEEK_MS))
      : deps.shares.all().filter((s) => isRecent(s.createdAt)).length;
    const body: AdminOverview = {
      issuer: config.issuer,
      programmeName: deps.courseware.programmeName,
      students: deps.accounts.list().filter((a) => a.role === 'student').length,
      cohorts: cohorts.length,
      courses: deps.courseware.courses.size,
      releasedCourseSlots: cohorts.reduce((n, cohort) => n + cohort.courses.filter((id) => id !== '*').length, 0),
      syncsLast7Days: dispersal.filter((d) => isRecent(d.at)).length,
      outdatedInstalls: dispersal.filter((d) => d.version !== currentVersion(d.courseId)).length,
      sharesLast7Days,
      recentAudit: deps.audit.recent(8),
    };
    return c.json(body);
  });

  app.get('/cohorts', admin, (c) => c.json(cohortSummaries()));

  app.post('/cohorts', admin, async (c) => {
    const parsed = NewCohortSchema.safeParse(await c.req.json().catch(() => null));
    if (!parsed.success) return c.json({ error: 'invalid_request', issues: parsed.error.issues }, 400);
    if (deps.releases.has(parsed.data.id)) return c.json({ error: 'cohort_exists' }, 409);
    const courses = parsed.data.copyFrom
      ? (deps.releases.cohorts().find((x) => x.id === parsed.data.copyFrom)?.courses ?? [])
      : [];
    await deps.releases.createCohort(parsed.data.id, parsed.data.name, courses);
    await deps.audit.record(actor(c), 'cohort_created', `${parsed.data.id} (${courses.length} courses)`);
    return c.json(cohortSummaries().find((x) => x.id === parsed.data.id), 201);
  });

  app.put('/cohorts/:cohortId/releases', admin, async (c) => {
    const cohortId = c.req.param('cohortId');
    if (!deps.releases.has(cohortId)) return c.json({ error: 'not_found' }, 404);
    const parsed = ReleaseToggleSchema.safeParse(await c.req.json().catch(() => null));
    if (!parsed.success) return c.json({ error: 'invalid_request', issues: parsed.error.issues }, 400);
    const unknown = parsed.data.courseIds.filter((id) => !deps.courseware.courses.has(id));
    if (unknown.length) return c.json({ error: 'unknown_courses', courseIds: unknown }, 400);
    await deps.releases.setReleased(cohortId, parsed.data.courseIds, parsed.data.released);
    const verb = parsed.data.released ? 'released' : 'withdrawn';
    await deps.audit.record(actor(c), `courses_${verb}`, `${parsed.data.courseIds.join(', ')} for ${cohortId}`);
    return c.json(cohortSummaries().find((x) => x.id === cohortId));
  });

  app.get('/courses', admin, (c) => {
    const cohorts = deps.releases.cohorts();
    const body: AdminCourse[] = [...deps.courseware.courses.values()]
      .map(({ summary }) => ({
        id: summary.id,
        title: summary.title,
        code: summary.code,
        semesterNumber: summary.semesterNumber,
        subjectId: summary.subjectId,
        lessonCount: summary.lessonCount,
        version: summary.version,
        support: summary.support,
        cohorts: cohorts.filter((x) => deps.releases.isReleased(x.id, summary.id)).map((x) => x.id),
      }))
      .sort((a, b) => a.semesterNumber - b.semesterNumber || a.title.localeCompare(b.title));
    return c.json(body);
  });

  app.get('/courses/:courseId/lessons', admin, (c) => {
    const course = deps.courseware.courses.get(c.req.param('courseId'));
    if (!course) return c.json({ error: 'not_found' }, 404);
    const body: AdminLesson[] = course.lessons.map((l) => ({
      id: l.id,
      title: l.title,
      moduleName: l.moduleName,
      order: l.order,
      concepts: l.concepts,
      summary: l.summary,
    }));
    return c.json(body);
  });

  app.get('/accounts', admin, (c) => c.json(deps.accounts.list()));

  app.post('/accounts', admin, async (c) => {
    const parsed = NewAccountSchema.safeParse(await c.req.json().catch(() => null));
    if (!parsed.success) return c.json({ error: 'invalid_request', issues: parsed.error.issues }, 400);
    if (parsed.data.cohortId && !deps.releases.has(parsed.data.cohortId)) return c.json({ error: 'unknown_cohort' }, 400);
    try {
      const account = await deps.accounts.create(parsed.data);
      await deps.audit.record(actor(c), 'account_created', `${account.email} (${account.role})`);
      return c.json(account, 201);
    } catch (error) {
      if (error instanceof AccountExistsError) return c.json({ error: 'email_taken' }, 409);
      throw error;
    }
  });

  app.patch('/accounts/:id', admin, async (c) => {
    const parsed = AccountPatchSchema.safeParse(await c.req.json().catch(() => null));
    if (!parsed.success) return c.json({ error: 'invalid_request', issues: parsed.error.issues }, 400);
    if (parsed.data.cohortId && !deps.releases.has(parsed.data.cohortId)) return c.json({ error: 'unknown_cohort' }, 400);
    const id = c.req.param('id');
    if (id === actor(c) && parsed.data.disabled) return c.json({ error: 'cannot_disable_self' }, 400);
    const account = await deps.accounts.update(id, parsed.data);
    if (!account) return c.json({ error: 'not_found' }, 404);
    const fields = Object.keys(parsed.data).map((k) => (k === 'password' ? 'password reset' : k));
    await deps.audit.record(actor(c), 'account_updated', `${account.email}: ${fields.join(', ')}`);
    return c.json(account);
  });

  app.get('/dispersal', admin, (c) =>
    c.json(
      deps.dispersal.all().map((d) => ({ ...d, current: d.version === currentVersion(d.courseId) })),
    ),
  );

  app.get('/audit', admin, (c) => c.json(deps.audit.recent(Number(c.req.query('limit') ?? 200))));

  // The pre-admission file relay is quarantined: it stays readable here so old
  // items can be reviewed and deleted, but nothing is ever re-attributed to an
  // account. Moderation of the authenticated share surface lives in staff.ts.
  app.get('/shares', admin, (c) => {
    const body: AdminShare[] = deps.shares.all().map(({ image: _image, fromAccountId: _id, ...share }) => share);
    return c.json(body);
  });

  app.delete('/shares/:id', admin, async (c) => {
    const removed = await deps.shares.remove(c.req.param('id'));
    if (!removed) return c.json({ error: 'not_found' }, 404);
    await deps.audit.record(actor(c), 'share_removed', `"${removed.title}" by ${removed.fromStudent}`);
    return c.body(null, 204);
  });

  return app;
}
