import assert from 'node:assert/strict';
import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { BrainService } from './service';

test('quizResults reads stored results (res_*.json) and ignores quiz definitions and junk', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'sef-quiz-results-'));
  await writeFile(path.join(dir, 'res_abc123.json'), JSON.stringify({ id: 'res_abc123', quizId: 'q1', key: 'entropy', score: 4, outOf: 5, at: '2026-10-14T12:00:00.000Z', answers: [] }));
  await writeFile(path.join(dir, 'q1.json'), JSON.stringify({ id: 'q1', key: 'entropy', concept: 'Entropy', questions: [] }));
  await writeFile(path.join(dir, 'res_broken.json'), JSON.stringify({ id: 'res_broken' }));
  const brain = new BrainService(null as never, null as never, null as never, dir, null as never);
  assert.deepEqual(await brain.quizResults(), [{ pageId: 'entropy', at: '2026-10-14T12:00:00.000Z' }]);
  assert.deepEqual(await new BrainService(null as never, null as never, null as never, path.join(dir, 'missing'), null as never).quizResults(), []);
});
