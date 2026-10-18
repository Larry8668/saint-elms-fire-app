import assert from 'node:assert/strict';
import { test } from 'node:test';
import { installSequentially, progressLabel, resultSummary, type InstallProgress } from './install-all';

const courses = [
  { id: 'phy-101', title: 'Mechanics' },
  { id: 'phy-102', title: 'Waves' },
  { id: 'mat-101', title: 'Calculus' },
];

test('courses install one request at a time, in order, reporting progress before each', async () => {
  const events: string[] = [];
  let inFlight = 0;
  const progress: InstallProgress[] = [];
  const result = await installSequentially(
    courses,
    async (id) => {
      inFlight++;
      assert.equal(inFlight, 1, 'never more than one install request at once');
      events.push(id);
      await new Promise((resolve) => setTimeout(resolve, 1));
      inFlight--;
    },
    (p) => progress.push(p),
  );
  assert.deepEqual(events, ['phy-101', 'phy-102', 'mat-101']);
  assert.deepEqual(progress.map(progressLabel), ['Installing 1 of 3…', 'Installing 2 of 3…', 'Installing 3 of 3…']);
  assert.deepEqual(result, { total: 3, installed: ['phy-101', 'phy-102', 'mat-101'], failed: [] });
  assert.equal(resultSummary(result), 'Installed 3 courses — verified on this device');
});

test('one failed course is recorded and the rest still install', async () => {
  const result = await installSequentially(courses, async (id) => {
    if (id === 'phy-102') throw new Error('Signature did not verify');
  });
  assert.deepEqual(result.installed, ['phy-101', 'mat-101']);
  assert.deepEqual(result.failed, [{ courseId: 'phy-102', title: 'Waves', message: 'Signature did not verify' }]);
  assert.equal(resultSummary(result), 'Installed 2 of 3 courses — 1 failed');

  const none = await installSequentially(courses.slice(0, 1), async () => {
    throw new Error('offline');
  });
  assert.equal(resultSummary(none), 'None of the 1 course could be installed');
});
