import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import {
  CONTRACT_VERSION,
  SourceRecordSchema,
  WikiProposalSchema,
  type ConceptPage,
  type ProfileIdentity,
  type SourceRecord,
  type WikiEdit,
  type WikiPageDraft,
  type WikiProposal,
} from '@sef/shared';
import { sha256Hex } from '../../lib/hash';
import { emptyPage, serializePage } from '../page-format';
import { WikiStore, type WikiStoreOptions } from '../wiki-store';

export const PROFILE: ProfileIdentity = { issuer: 'https://uni.example.test', studentId: 'student-a', programmeId: 'bsc-physics' };
export const T0 = '2026-10-15T10:00:00.000Z';

/** Deterministic clock: every commit gets a distinct, reproducible timestamp. */
export function clock(from = T0, stepMs = 1_000): () => Date {
  let at = Date.parse(from);
  return () => new Date((at += stepMs));
}

export async function tempRoot(prefix: string): Promise<string> {
  return mkdtemp(path.join(tmpdir(), `sef-${prefix}-`));
}

export async function vault(prefix: string, options: WikiStoreOptions = {}): Promise<WikiStore> {
  const store = new WikiStore(await tempRoot(prefix), { now: clock(), lockTimeoutMs: 1_000, ...options });
  await store.init();
  return store;
}

type ConceptDraft = Extract<WikiPageDraft, { kind: 'concept' }>;

export function conceptDraft(id: string, overrides: Partial<ConceptDraft> = {}): WikiPageDraft {
  return {
    kind: 'concept',
    id,
    title: `Concept ${id}`,
    summary: `What ${id} says in one line.`,
    markdown: `# ${id}\n\nForce changes momentum.`,
    courseRefs: [{ programmeId: PROFILE.programmeId, courseId: 'classical-mechanics', conceptKey: id }],
    claims: [],
    links: [],
    learner: { inMyWords: 'Force changes momentum.', stuck: 'Satellites.', connections: 'Impulse.', evidenceIds: [] },
    ...overrides,
  };
}

export function synthesisDraft(id: string, sourceIds: string[], overrides: Partial<WikiPageDraft> = {}): WikiPageDraft {
  return {
    kind: 'synthesis',
    id,
    title: `Synthesis ${id}`,
    summary: `Synthesis ${id}, combining two sources.`,
    markdown: 'Both sources agree.',
    courseRefs: [],
    claims: [],
    links: [],
    sourceIds,
    ...overrides,
  } as WikiPageDraft;
}

export function proposal(operations: WikiEdit[], baseRevisions: Record<string, string | null>, overrides: Partial<WikiProposal> = {}): WikiProposal {
  return WikiProposalSchema.parse({
    schemaVersion: CONTRACT_VERSION,
    id: 'proposal-1',
    profile: PROFILE,
    sourceIds: ['source-note'],
    conventionRevision: 'conventions-v2',
    createdAt: T0,
    baseRevisions,
    operations,
    ...overrides,
  });
}

export function sourceFixture(id: string, text: string, overrides: { revision?: string; mediaType?: string; title?: string } = {}): { record: SourceRecord; bytes: Buffer } {
  const bytes = Buffer.from(text, 'utf8');
  const record = SourceRecordSchema.parse({
    schemaVersion: CONTRACT_VERSION,
    id,
    profile: PROFILE,
    revision: overrides.revision ?? 'rev-1',
    title: overrides.title ?? `Source ${id}`,
    createdAt: T0,
    mediaType: overrides.mediaType ?? 'text/markdown',
    sha256: sha256Hex(bytes),
    bytes: bytes.length,
    attribution: {},
    extractions: [],
    kind: 'note',
    origin: 'student',
  });
  return { record, bytes };
}

export function legacyPage(key: string, overrides: Partial<ConceptPage> = {}): ConceptPage {
  const page = emptyPage(key, `Concept ${key}`, ['lesson-mechanics-1'], '2026-09-01T08:30:00.000Z');
  return {
    ...page,
    status: 'shaky',
    evidence: [
      { kind: 'quiz', ref: 'quiz-1', at: '2026-09-02T09:00:00.000Z', score: 1, outOf: 3 },
      { kind: 'session', ref: 'session-1', at: '2026-09-03T09:00:00.000Z', note: 'Guide session' },
    ],
    misconceptions: [{ claim: 'Damping raises the frequency', course: 'Damping lowers it', lessonRef: 'lesson-mechanics-1', flagged: '2026-09-02T09:00:00.000Z', resolved: false }],
    links: [{ to: 'energy', type: 'builds_upon', origin: 'student', why: 'Energy leaks each cycle' }],
    sections: {
      in_my_words: 'Energy leaves the system each cycle.',
      where_i_got_stuck: 'Why amplitude decays exponentially.',
      connections: 'Links to heat in the lab.',
    },
    ...overrides,
  };
}

export const LEGACY_SCHEMA_MD = `# Brain schema

This folder is your second brain. Every file is plain markdown — open it in Obsidian or any editor.

- \`concepts/\` — one page per concept, as *you* understand it.
- \`log.md\` — append-only timeline of how your understanding grew.
`;

export interface LegacyVaultOptions {
  pages: ConceptPage[];
  history?: Record<string, { name: string; content: string }[]>;
  log?: string;
  index?: string;
}

/** Writes a vault exactly as the earlier keeper left it: concept pages, history and its own SCHEMA.md. */
export async function writeLegacyVault(root: string, options: LegacyVaultOptions): Promise<void> {
  await mkdir(path.join(root, 'concepts'), { recursive: true });
  for (const page of options.pages) {
    await writeFile(path.join(root, 'concepts', `${page.key}.md`), serializePage(page));
    for (const entry of options.history?.[page.key] ?? []) {
      await mkdir(path.join(root, '.history', page.key), { recursive: true });
      await writeFile(path.join(root, '.history', page.key, entry.name), entry.content);
    }
  }
  await writeFile(path.join(root, 'SCHEMA.md'), LEGACY_SCHEMA_MD);
  await writeFile(path.join(root, 'log.md'), options.log ?? '# Learning log\n\n');
  if (options.index) await writeFile(path.join(root, 'index.md'), options.index);
}
