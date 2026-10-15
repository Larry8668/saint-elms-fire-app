import assert from 'node:assert/strict';
import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { CONTRACT_VERSION, ProgrammeSchema, type CourseAvailability, type Programme } from '@sef/shared';
import { hashPassword, signToken, TokenError, verifyPassword, verifyToken } from '@sef/shared/node';
import { createApp } from './app';
import { config } from './config';
import type { CoursewareIndex, ProgrammeManifestResult } from './courseware';
import { loadSigningKeys } from './signing';
import { AccountStore } from './store/accounts';
import { AuditLog } from './store/audit';
import { DispersalStore } from './store/dispersal';
import { ReleaseStore } from './store/releases';
import { ShareStore } from './store/shares';

const course = (id: string, semesterNumber: number) => ({
  summary: { id, title: id, subjectId: 'physics', semesterNumber, lessonCount: 0, version: `v-${id}`, support: false },
  files: [],
  lessons: [],
});

async function harness() {
  const dir = await mkdtemp(path.join(tmpdir(), 'sef-uni-'));
  const seed = path.join(dir, 'releases.seed.json');
  await writeFile(
    seed,
    JSON.stringify({
      defaultCohort: 'bsc-pma-2026',
      cohorts: { 'bsc-pma-2026': { name: 'S1', courses: ['mechanics'] }, 'bsc-pma-2025': { name: 'S3', courses: ['mechanics', 'real-analysis'] } },
    }),
  );
  const courseware: CoursewareIndex = {
    programmeId: 'p',
    programmeName: 'P',
    courses: new Map([
      ['mechanics', course('mechanics', 1)],
      ['real-analysis', course('real-analysis', 3)],
    ]),
    skipped: [],
  };
  const programme: Programme = ProgrammeSchema.parse({
    schemaVersion: CONTRACT_VERSION,
    id: 'p',
    name: 'P',
    institution: 'Test University',
    manifestVersion: 'v1',
    sourceDocuments: ['syllabus.pdf'],
    rows: [
      {
        schemaVersion: CONTRACT_VERSION,
        rowId: 'row-mechanics',
        courseId: 'mechanics',
        courseCode: 'PHY-101',
        courseName: 'Mechanics',
        subjectId: 'physics',
        semesterNumber: 1,
        courseType: 'Major Core',
        hoursPerWeek: 4,
        credits: 4,
        optionGroup: null,
        deliveryMode: 'authored-courseware',
        prerequisites: [],
        status: 'released',
      },
    ],
    optionGroups: [],
  });
  const programmeResult: ProgrammeManifestResult = {
    programme,
    semesters: [{ id: 'sem-1', name: 'Semester 1', number: 1, rowIds: ['row-mechanics'] }],
    declaredCounts: { total: 1, bySemester: { 'sem-1': 1 }, byStatus: { released: 1 } },
    derivedCounts: {
      rows: 1,
      bySemester: { 1: 1 },
      byStatus: { released: 1 },
      degreeRows: 1,
      degreeCredits: { min: 4, max: 4 },
    },
    diagnostics: [],
    resolveContentDir: () => null,
  };
  const availability: Record<string, CourseAvailability> = {
    'row-mechanics': { content: 'authored', release: 'released', selection: 'required' },
  };
  const releases = new ReleaseStore(seed, dir);
  const accounts = new AccountStore(dir);
  const audit = new AuditLog(dir);
  const dispersal = new DispersalStore(dir);
  const shares = new ShareStore(dir);
  const keys = await loadSigningKeys(path.join(dir, 'keys'));
  await Promise.all([releases.load(), accounts.load(), audit.load(), dispersal.load(), shares.load()]);
  const app = createApp({ courseware, programme: programmeResult, availability, releases, accounts, audit, dispersal, shares, keys });

  const login = async (email: string) => {
    const res = await app.request('/v1/auth/login', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ email, password: config.demoPassword }),
    });
    assert.equal(res.status, 200);
    return ((await res.json()) as { token: string }).token;
  };
  const get = (url: string, token?: string) =>
    app.request(url, { headers: token ? { authorization: `Bearer ${token}` } : {} });
  return { app, keys, login, get };
}

test('scrypt hashes verify only the right password', async () => {
  const stored = await hashPassword('harbor-lantern');
  assert.equal(await verifyPassword('harbor-lantern', stored), true);
  assert.equal(await verifyPassword('harbor-lantern!', stored), false);
});

test('tokens reject tampering and expiry', async () => {
  const { keys } = await harness();
  const now = Math.floor(Date.now() / 1000);
  const claims = { iss: 'x', sub: 'ananya', role: 'student' as const, name: 'A', email: 'a@x', iat: now, exp: now + 60 };
  const token = signToken(claims, keys.privateKey);
  assert.equal(verifyToken(token, keys.publicKeyPem).sub, 'ananya');

  const [prefix, , sig] = token.split('.');
  const forged = Buffer.from(JSON.stringify({ ...claims, role: 'admin' })).toString('base64url');
  assert.throws(() => verifyToken(`${prefix}.${forged}.${sig}`, keys.publicKeyPem), TokenError);
  assert.throws(() => verifyToken(token, keys.publicKeyPem, Date.now() + 120_000), /expired/);
});

test('validly signed tokens with malformed claims are rejected, never treated as non-expiring', async () => {
  const { keys } = await harness();
  const now = Math.floor(Date.now() / 1000);
  const base = { iss: 'x', sub: 'ananya', role: 'student' as const, name: 'A', email: 'a@x', iat: now, exp: now + 60 };
  const { exp: _exp, ...noExp } = base;
  for (const claims of [noExp, { ...base, exp: 'later' }, { ...base, role: 'root' }]) {
    const token = signToken(claims as never, keys.privateKey);
    assert.throws(() => verifyToken(token, keys.publicKeyPem), /malformed claims/);
  }
  const [prefix, payload] = signToken(base, keys.privateKey).split('.');
  assert.throws(() => verifyToken(`${prefix}.${payload}.!!not-base64!!`, keys.publicKeyPem), TokenError);
});

test('emails are unique regardless of case', async () => {
  const { app, login } = await harness();
  const admin = await login('admin@saintelms.local');
  const create = (email: string) =>
    app.request('/v1/admin/accounts', {
      method: 'POST',
      headers: { authorization: `Bearer ${admin}`, 'content-type': 'application/json' },
      body: JSON.stringify({ email, name: 'Dee', password: 'long-enough-pw', role: 'student', cohortId: 'bsc-pma-2026' }),
    });
  assert.equal((await create('Dee@Saintelms.local')).status, 201);
  assert.equal((await create('dee@saintelms.local')).status, 409);
});

test('students only see their own cohort and cannot reach admin routes', async () => {
  const { login, get } = await harness();
  assert.equal((await get('/v1/catalogue')).status, 401);

  const ananya = await login('ananya@saintelms.local');
  const catalogue = (await (await get('/v1/catalogue?cohort=bsc-pma-2025', ananya)).json()) as { courses: { id: string }[] };
  assert.deepEqual(catalogue.courses.map((c) => c.id), ['mechanics']);
  assert.equal((await get('/v1/courses/real-analysis/package', ananya)).status, 403);
  assert.equal((await get('/v1/admin/overview', ananya)).status, 403);
});

test('the programme endpoint requires auth and exposes the normalized manifest', async () => {
  const { login, get } = await harness();
  assert.equal((await get('/v1/programme')).status, 401);
  const ananya = await login('ananya@saintelms.local');
  const body = (await (await get('/v1/programme', ananya)).json()) as {
    programme: { id: string; rows: Array<{ rowId: string }> };
    derivedCounts: { rows: number };
    availability: Record<string, { content: string }>;
  };
  assert.equal(body.programme.id, 'p');
  assert.equal(body.programme.rows[0]!.rowId, 'row-mechanics');
  assert.equal(body.derivedCounts.rows, 1);
  assert.equal(body.availability['row-mechanics']!.content, 'authored');
});

test('admin release toggles change what a cohort can download', async () => {
  const { app, login, get } = await harness();
  const admin = await login('admin@saintelms.local');
  const res = await app.request('/v1/admin/cohorts/bsc-pma-2026/releases', {
    method: 'PUT',
    headers: { authorization: `Bearer ${admin}`, 'content-type': 'application/json' },
    body: JSON.stringify({ courseIds: ['real-analysis'], released: true }),
  });
  assert.equal(res.status, 200);
  const ananya = await login('ananya@saintelms.local');
  assert.equal((await get('/v1/courses/real-analysis/package', ananya)).status, 200);

  const audit = (await (await get('/v1/admin/audit', admin)).json()) as { action: string }[];
  assert.ok(audit.some((e) => e.action === 'courses_released'));
});
