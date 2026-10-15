import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { test } from 'node:test';

const dataRoot = await mkdtemp(path.join(tmpdir(), 'sef-anonymous-data-'));
process.env.ENGINE_DATA_DIR = dataRoot;

const { profilePaths } = await import('../config');
const { AnonymousDataManager, AnonymousDataClaimedError } = await import('./anonymous');

const profile = (id: string) => ({ id, name: id, email: `${id}@example.test`, cohortId: 'cohort-a', offlineReady: true });

async function clearAnonymousFiles() {
  for (const category of ['content', 'brain', 'sessions', 'quizzes']) {
    await rm(path.join(dataRoot, category), { recursive: true, force: true });
  }
  await rm(path.join(dataRoot, 'anonymous-backups'), { recursive: true, force: true });
  await rm(path.join(dataRoot, 'anonymous-claim.json'), { force: true });
}

async function makeAnonymousFiles() {
  await clearAnonymousFiles();
  const files: Record<string, string> = {
    'content/courses/course-a/lesson.md': '# Released lesson\n',
    'brain/concepts/forces.md': '# My notes\n',
    'sessions/same-session.json': '{"id":"same-session"}',
    'quizzes/quiz-a.json': '{"id":"quiz-a"}',
  };
  for (const [relative, content] of Object.entries(files)) {
    const target = path.join(dataRoot, relative);
    await mkdir(path.dirname(target), { recursive: true });
    await writeFile(target, content);
  }
  await writeFile(path.join(dataRoot, 'settings.json'), '{"providers":[{"apiKey":"do-not-export"}]}');
  await writeFile(path.join(dataRoot, 'profiles.json'), '[{"verifier":"do-not-export"}]');
  await writeFile(path.join(dataRoot, 'auth-sessions.json'), '{"token":"do-not-export"}');
  const privateSettings = path.join(dataRoot, 'profiles/alice/private-settings.json');
  await mkdir(path.dirname(privateSettings), { recursive: true });
  await writeFile(privateSettings, '{"providers":[{"apiKey":"do-not-export"}]}');
}

test('anonymous data is previewed and backed up without device or provider secrets', async () => {
  await makeAnonymousFiles();
  const anonymous = new AnonymousDataManager(dataRoot);
  const preview = await anonymous.preview();

  assert.equal(preview.available, true);
  assert.deepEqual(preview.categories.map((c) => c.name), ['content', 'brain', 'sessions', 'quizzes']);
  assert.equal(preview.fileCount, 4);

  const backup = await anonymous.backup();
  assert.equal(backup.fileCount, 4);
  const backupDir = path.join(dataRoot, 'anonymous-backups', backup.id);
  assert.equal(await readFile(path.join(backupDir, 'brain/concepts/forces.md'), 'utf8'), '# My notes\n');
  await assert.rejects(readFile(path.join(backupDir, 'settings.json'), 'utf8'));
  await assert.rejects(readFile(path.join(backupDir, 'profiles.json'), 'utf8'));
  await assert.rejects(readFile(path.join(backupDir, 'auth-sessions.json'), 'utf8'));
  await assert.rejects(readFile(path.join(backupDir, 'profiles/alice/private-settings.json'), 'utf8'));
});

test('claim imports a selected backup only into the authenticated profile and keeps source data', async () => {
  await makeAnonymousFiles();
  const anonymous = new AnonymousDataManager(dataRoot);
  const backup = await anonymous.backup();
  const alicePaths = profilePaths('alice');
  await mkdir(alicePaths.sessions, { recursive: true });
  await writeFile(path.join(alicePaths.sessions, 'same-session.json'), 'profile-owned');

  const result = await anonymous.claim(profile('alice'), alicePaths, backup.id);
  assert.equal(result.profileId, 'alice');
  assert.equal(result.importedFiles, 3);
  assert.equal(result.skippedFiles, 1);
  assert.equal(await readFile(path.join(alicePaths.sessions, 'same-session.json'), 'utf8'), 'profile-owned');
  assert.equal(await readFile(path.join(alicePaths.brain, 'concepts/forces.md'), 'utf8'), '# My notes\n');
  assert.equal(await readFile(path.join(dataRoot, 'brain/concepts/forces.md'), 'utf8'), '# My notes\n');

  await assert.rejects(
    anonymous.claim(profile('bob'), profilePaths('bob'), backup.id),
    AnonymousDataClaimedError,
  );
  await assert.rejects(readFile(path.join(profilePaths('bob').brain, 'concepts/forces.md'), 'utf8'));
});

test('claim requires an explicit backup and refuses an empty anonymous workspace', async () => {
  await clearAnonymousFiles();
  const anonymous = new AnonymousDataManager(dataRoot);
  await assert.rejects(anonymous.claim(profile('alice'), profilePaths('alice'), 'missing-backup'));
  await assert.rejects(anonymous.backup(), /No anonymous student data/);
});
