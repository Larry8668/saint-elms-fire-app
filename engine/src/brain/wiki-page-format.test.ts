import assert from 'node:assert/strict';
import { test } from 'node:test';
import { CONTRACT_VERSION, CourseConceptRefSchema, type ConceptPage } from '@sef/shared';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { serializePage } from './page-format';
import { legacyPage, PROFILE, T0 } from './testing/fixtures';
import { rawRelativePath, pageRelativePath, sourceExtension } from './vault-layout';
import { VaultPathError } from './vault-errors';
import {
  conceptPageFromWikiPage,
  contentRevision,
  pageContent,
  readPageFile,
  revisionMatches,
  serializePageFile,
  wikiContentFromConceptPage,
  type PageMetadataInput,
} from './wiki-page-format';

process.env.ENGINE_DATA_DIR = await mkdtemp(path.join(tmpdir(), 'sef-wiki-format-'));

const metadata = (overrides: Partial<PageMetadataInput> = {}): PageMetadataInput => ({
  schemaVersion: CONTRACT_VERSION,
  id: 'newton-second-law',
  kind: 'concept',
  state: 'committed',
  title: "Newton's second law",
  summary: 'Force is the rate of change of momentum.',
  updatedAt: T0,
  courseRefs: [CourseConceptRefSchema.parse({ programmeId: PROFILE.programmeId, courseId: 'classical-mechanics', conceptKey: 'newtons-second-law' })],
  claims: [],
  links: [],
  learner: { inMyWords: 'F = dp/dt', stuck: 'Satellites keep moving.', connections: 'Impulse.', evidenceIds: ['source-note'] },
  sourceIds: [],
  provenance: null,
  ...overrides,
});

const legacyBodyOf = (page: ConceptPage): string => (serializePage(page).split('---\n')[2] ?? '').trimEnd();

test('a typed page round-trips through the markdown file with its revision intact', () => {
  const content = pageContent(metadata(), '# Body heading\n\nSome prose.');
  const file = serializePageFile(content);
  const parsed = readPageFile(file);

  assert.equal(parsed.format, 2);
  if (parsed.format !== 2) return;
  assert.deepEqual(parsed.metadata, content.metadata);
  assert.equal(parsed.body, content.body);
  assert.equal(revisionMatches(parsed.metadata, parsed.body), true, 'the file carries the revision of its own content');
  assert.match(file, /^---\nid: newton-second-law\nkind: concept\nschemaVersion: 2\nrevision: rev-[a-f0-9]{40}\n/);
  assert.match(file, /---\n# Body heading/, 'the body keeps the student\u2019s markdown');
});

test('revisions are content-addressed: same content, same revision; any edit changes it', () => {
  const first = contentRevision({ metadata: metadata(), body: 'Body' });
  const again = contentRevision({ metadata: metadata(), body: 'Body' });
  const edited = contentRevision({ metadata: metadata({ updatedAt: '2026-10-16T10:00:00.000Z' }), body: 'Body' });
  const bodyEdited = contentRevision({ metadata: metadata(), body: 'Body!' });

  assert.equal(first, again);
  assert.notEqual(first, edited, 'metadata changes the revision');
  assert.notEqual(first, bodyEdited, 'the body changes the revision');
  assert.equal(first.startsWith('rev-'), true);
});

test('malformed frontmatter and newer schemas are reported, never guessed at', () => {
  const reason = (read: ReturnType<typeof readPageFile>) => (read.format === 'unknown' ? read.reason : `format-${read.format}`);

  assert.equal(reason(readPageFile('just a body')), 'malformed');
  assert.equal(reason(readPageFile('---\n- a\n- b\n---\nbody')), 'malformed', 'a list is not a mapping');
  assert.equal(reason(readPageFile('---\nid: [unclosed\n---\nbody')), 'malformed', 'broken YAML is rejected');
  assert.equal(reason(readPageFile('---\nschemaVersion: 2\nid: newton-second-law\n---\nbody')), 'malformed', 'an incomplete typed page is rejected');
  assert.equal(reason(readPageFile('---\nschemaVersion: 3\nid: newton-second-law\nkind: concept\n---\nbody')), 'newer_schema');
  assert.equal(reason(readPageFile('---\nschemaVersion: 2\nid: newton-second-law\nkind: spell\nstate: committed\n---\nbody')), 'malformed', 'an unknown page kind is not accepted');
});

test('a page still in the earlier concept format reads as version 1', () => {
  const legacy = legacyPage('newton-second-law');
  const parsed = readPageFile(serializePage(legacy));

  assert.equal(parsed.format, 1);
  if (parsed.format !== 1) return;
  assert.equal(parsed.legacy.key, 'newton-second-law');
  assert.match(parsed.body, /## In my words/);
});

test('migration in and back out is lossless, including unresolved provenance', () => {
  const legacy = legacyPage('newton-second-law');
  const content = wikiContentFromConceptPage(legacy, T0);
  const file = serializePageFile(content);
  const parsed = readPageFile(file);
  assert.equal(parsed.format, 2);
  if (parsed.format !== 2) return;

  const back = conceptPageFromWikiPage(parsed.metadata, parsed.body);
  assert.deepEqual(back, legacy, 'every legacy field comes back unchanged');
  assert.equal(parsed.metadata.learner?.inMyWords, legacy.sections.in_my_words);
  assert.deepEqual(parsed.metadata.provenance?.evidence, legacy.evidence);
  assert.deepEqual(parsed.metadata.provenance?.misconceptions, legacy.misconceptions);
  assert.deepEqual(parsed.metadata.provenance?.links, legacy.links);
  assert.deepEqual(parsed.metadata.provenance?.legacyCourseRefs, legacy.courseRefs);
  assert.equal(parsed.metadata.provenance?.legacyStatus, 'shaky');
  assert.deepEqual(parsed.metadata.links, [], 'an unevidenced legacy link is not upgraded into a typed link');
  assert.deepEqual(parsed.metadata.learner?.evidenceIds, ['quiz-1', 'session-1']);
  assert.equal(parsed.body, legacyBodyOf(legacy), 'the student\u2019s prose is untouched');
});

test('a migrated page keeps its prose byte for byte', () => {
  const legacy: ConceptPage = legacyPage('damping', { sections: { in_my_words: '', where_i_got_stuck: '', connections: '' }, links: [], evidence: [], misconceptions: [] });
  const content = wikiContentFromConceptPage(legacy, T0);
  assert.equal(content.body, legacyBodyOf(legacy));
  assert.equal(content.metadata.summary, 'Concept damping — migrated from the earlier concept vault.');
});

test('vault paths reject identifiers and revisions that would escape the vault', () => {
  assert.throws(() => pageRelativePath('concept', '../../etc/passwd'), VaultPathError);
  assert.throws(() => pageRelativePath('concept', '..'), VaultPathError);
  assert.throws(() => pageRelativePath('concept', '.hidden'), VaultPathError);
  assert.throws(() => pageRelativePath('concept', 'a/b'), VaultPathError);
  assert.throws(() => rawRelativePath('source-a', '../escape', 'text/markdown'), VaultPathError);
  assert.equal(pageRelativePath('concept', 'newton-second-law'), 'concepts/newton-second-law.md');
  assert.equal(rawRelativePath('source-a', 'rev-1', 'application/x-sef-session'), 'raw/source-a/rev-1.xsefsession');
  assert.equal(sourceExtension(''), 'bin');
  assert.equal(sourceExtension('text/../../etc/passwd'), 'bin', 'a media type can never contribute a path fragment');
});
