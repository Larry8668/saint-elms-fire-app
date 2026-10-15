import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, readdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import type { CourseSummary } from '@sef/shared';
import { ContentStore } from './store';

const course = (over: Partial<CourseSummary> = {}): CourseSummary => ({
  id: 'waves',
  title: 'Waves',
  subjectId: 'physics',
  semesterNumber: 1,
  lessonCount: 1,
  version: 'v1-a',
  support: false,
  ...over,
});

const harness = async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'sef-content-'));
  return { dir, store: new ContentStore(dir) };
};

test('a course installs and is recorded in the index', async () => {
  const { store, dir } = await harness();
  await store.install(course(), [{ path: 'a.md', content: 'alpha' }]);
  assert.equal((await store.installed()).waves?.version, 'v1-a');
  assert.equal(await readFile(path.join(dir, 'courses', 'waves', 'a.md'), 'utf8'), 'alpha');
});

test('replacing a course swaps every file and leaves no staging or retired directories', async () => {
  const { store, dir } = await harness();
  await store.install(course(), [{ path: 'a.md', content: 'alpha' }, { path: 'b.md', content: 'beta' }]);
  await store.install(course({ version: 'v1-b' }), [{ path: 'a.md', content: 'gamma' }]);

  assert.deepEqual(await readdir(path.join(dir, 'courses')), ['waves'], 'no .staging-* or .retired-* leftovers');

  const installed = await store.installed();
  assert.equal(installed.waves?.version, 'v1-b');
  assert.equal(await readFile(path.join(dir, 'courses', 'waves', 'a.md'), 'utf8'), 'gamma');
});

test('a rejected path leaves the previous installation completely intact', async () => {
  const { store, dir } = await harness();
  await store.install(course({ version: 'v1-good' }), [{ path: 'a.md', content: 'working content' }]);

  // The traversal check rejects before the live tree is touched.
  await assert.rejects(() => store.install(course({ version: 'v1-bad' }), [{ path: '../../escape.md', content: 'bad' }]), /outside course dir/);

  const installed = await store.installed();
  assert.equal(installed.waves?.version, 'v1-good', 'the index still points at the good version');
  assert.equal(await readFile(path.join(dir, 'courses', 'waves', 'a.md'), 'utf8'), 'working content');
  assert.deepEqual(await readdir(path.join(dir, 'courses')), ['waves']);
});

test('an empty file set does not erase an existing course', async () => {
  const { store, dir } = await harness();
  await store.install(course({ version: 'v1-good' }), [{ path: 'a.md', content: 'keep me' }]);
  await store.install(course({ version: 'v1-empty' }), []);
  assert.equal((await store.installed()).waves?.version, 'v1-empty');
  assert.deepEqual(await readdir(path.join(dir, 'courses', 'waves')), []);
});

test('the signed-metadata flag is recorded so a legacy install is never presented as verified', async () => {
  const { store } = await harness();
  await store.install(course(), [{ path: 'a.md', content: 'alpha' }], false);
  assert.equal((await store.installed()).waves?.signedMetadata, false);

  await store.install(course({ version: 'v1-b' }), [{ path: 'a.md', content: 'beta' }], true);
  assert.equal((await store.installed()).waves?.signedMetadata, true);
});

test('a crash between staging and swap leaves the old tree and cleans the staging dir', async () => {
  const { store, dir } = await harness();
  await store.install(course({ version: 'v1-good' }), [{ path: 'a.md', content: 'intact' }]);

  // Simulate the process dying after staging was written but before the swap.
  const coursesDir = path.join(dir, 'courses');
  await mkdir(path.join(coursesDir, 'waves.staging-crash'), { recursive: true });
  await writeFile(path.join(coursesDir, 'waves.staging-crash', 'a.md'), 'never committed');

  assert.equal(await readFile(path.join(coursesDir, 'waves', 'a.md'), 'utf8'), 'intact');
  assert.deepEqual(await readdir(coursesDir), ['waves', 'waves.staging-crash']);
  // A later successful install is unaffected by the abandoned staging directory.
  await store.install(course({ version: 'v1-next' }), [{ path: 'a.md', content: 'next' }]);
  assert.equal(await readFile(path.join(coursesDir, 'waves', 'a.md'), 'utf8'), 'next');
});
