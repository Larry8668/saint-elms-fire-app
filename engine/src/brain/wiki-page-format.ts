import {
  CONCEPT_STATUSES,
  CONTRACT_VERSION,
  CourseConceptRefSchema,
  EvidenceSchema,
  IdentifierListSchema,
  IdentifierSchema,
  MisconceptionSchema,
  PAGE_SECTIONS,
  PageLinkSchema,
  SECTION_TITLES,
  TimestampSchema,
  WikiClaimSchema,
  WikiLinkSchema,
  type ConceptPage,
  type PageSection,
  type Revision,
} from '@sef/shared';
import { parse as parseYaml, stringify as stringifyYaml } from 'yaml';
import { z } from 'zod';
import { sha256Hex } from '../lib/hash';
import { parsePage, readSection } from './page-format';
import { PageKindSchema, assertRecordId } from './vault-layout';

/**
 * A vault page is typed metadata in the frontmatter plus the student's prose in the body.
 * The revision is derived from the metadata and the body (never stored as a counter), so the same
 * content always has the same revision and any edit made outside the keeper shows up as a mismatch.
 */
export const LearnerSchema = z.strictObject({
  inMyWords: z.string(),
  stuck: z.string(),
  connections: z.string(),
  evidenceIds: IdentifierListSchema,
});

/**
 * What the earlier concept vault recorded that the typed model cannot resolve: evidence without a
 * source citation, misconceptions without the course statement, and links with no evidence reference.
 * Preserving it verbatim is deliberate — upgrading any of it would mean inventing provenance.
 */
export const PageProvenanceSchema = z.strictObject({
  origin: z.literal('legacy_concept_vault'),
  migratedAt: TimestampSchema,
  legacyKey: z.string().min(1),
  legacyStatus: z.enum(CONCEPT_STATUSES).optional(),
  legacyUpdated: z.string().optional(),
  legacyCourseRefs: z.array(z.string()),
  evidence: z.array(EvidenceSchema),
  misconceptions: z.array(MisconceptionSchema),
  links: z.array(PageLinkSchema),
});

export const PageMetadataSchema = z
  .strictObject({
    schemaVersion: z.literal(CONTRACT_VERSION),
    id: IdentifierSchema,
    kind: PageKindSchema,
    revision: z.string().min(1).max(160),
    state: z.literal('committed'),
    title: z.string().min(1).max(300),
    summary: z.string().min(1).max(2000),
    updatedAt: TimestampSchema,
    courseRefs: z.array(CourseConceptRefSchema),
    claims: z.array(WikiClaimSchema),
    links: z.array(WikiLinkSchema),
    learner: LearnerSchema.nullable(),
    sourceIds: IdentifierListSchema,
    provenance: PageProvenanceSchema.nullable(),
  })
  .superRefine((value, ctx) => {
    if (value.kind === 'concept' && !value.learner) {
      ctx.addIssue({ code: 'custom', path: ['learner'], message: 'A concept page keeps the student\u2019s own words' });
    }
    if ((value.kind === 'source_summary' || value.kind === 'synthesis') && !value.sourceIds.length) {
      ctx.addIssue({ code: 'custom', path: ['sourceIds'], message: 'A generated page must name the sources it was built from' });
    }
  });
export type PageMetadata = z.infer<typeof PageMetadataSchema>;
export type PageMetadataInput = Omit<PageMetadata, 'revision'>;
export type WikiContent = { metadata: PageMetadata; body: string };
export type WikiContentInput = { metadata: PageMetadataInput; body: string };

export type PageFileRead =
  | { format: 2; metadata: PageMetadata; body: string }
  | { format: 1; legacy: ConceptPage; body: string }
  | { format: 'unknown'; reason: 'malformed' | 'newer_schema'; message: string };

const LEARNER_FIELD: Record<PageSection, keyof Pick<z.infer<typeof LearnerSchema>, 'inMyWords' | 'stuck' | 'connections'>> = {
  in_my_words: 'inMyWords',
  where_i_got_stuck: 'stuck',
  connections: 'connections',
};

export function contentRevision(input: WikiContentInput): Revision {
  const { revision: _revision, ...rest } = input.metadata as Partial<PageMetadata>;
  const material = stableJson({ metadata: stripUndefined(rest), body: normalizeBody(input.body) });
  return `rev-${sha256Hex(material).slice(0, 40)}`;
}

/** Always build content through this: the stamped revision is what the write path verifies later. */
export function pageContent(metadata: PageMetadataInput, body: string): WikiContent {
  const normalized = normalizeBody(body);
  return { metadata: { ...metadata, revision: contentRevision({ metadata, body: normalized }) }, body: normalized };
}

export function serializePageFile(content: WikiContent): string {
  const front = stringifyYaml(frontmatterOf(content), { lineWidth: 0 }).trimEnd();
  return `---\n${front}\n---\n${normalizeBody(content.body)}\n`;
}

export function readPageFile(raw: string): PageFileRead {
  const match = raw.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/);
  if (!match) return { format: 'unknown', reason: 'malformed', message: 'the file has no frontmatter block' };
  let front: unknown;
  try {
    front = parseYaml(match[1] ?? '');
  } catch {
    return { format: 'unknown', reason: 'malformed', message: 'the frontmatter is not valid YAML' };
  }
  if (!front || typeof front !== 'object' || Array.isArray(front)) {
    return { format: 'unknown', reason: 'malformed', message: 'the frontmatter is not a mapping' };
  }
  const body = normalizeBody(match[2] ?? '');
  const version = (front as Record<string, unknown>).schemaVersion;
  if (typeof version === 'number' && version > CONTRACT_VERSION) {
    return { format: 'unknown', reason: 'newer_schema', message: `page schema ${version} was written by a newer engine` };
  }
  if (version === undefined || version === null) {
    const legacy = parsePage(raw);
    return legacy?.key
      ? { format: 1, legacy, body }
      : { format: 'unknown', reason: 'malformed', message: 'the frontmatter has neither a schema version nor a legacy page key' };
  }
  const metadata = PageMetadataSchema.safeParse(front);
  if (!metadata.success) {
    return { format: 'unknown', reason: 'malformed', message: metadata.error.issues.map((issue) => `${issue.path.join('.')}: ${issue.message}`).join('; ') };
  }
  return { format: 2, metadata: metadata.data, body };
}

/** True when the file's own revision still matches its content. */
export function revisionMatches(metadata: PageMetadata, body: string): boolean {
  return metadata.revision === contentRevision({ metadata, body });
}

export function frontmatterOf(content: WikiContent): Record<string, unknown> {
  const { metadata } = content;
  return stripUndefined({
    id: metadata.id,
    kind: metadata.kind,
    schemaVersion: metadata.schemaVersion,
    revision: metadata.revision,
    state: metadata.state,
    title: metadata.title,
    summary: metadata.summary,
    updatedAt: metadata.updatedAt,
    courseRefs: metadata.courseRefs,
    claims: metadata.claims,
    links: metadata.links,
    learner: metadata.learner,
    sourceIds: metadata.sourceIds,
    provenance: metadata.provenance,
  }) as Record<string, unknown>;
}

/**
 * Migration in, one way only: the legacy fields that can be typed are typed, and everything whose
 * provenance cannot be resolved is preserved verbatim instead of being guessed at.
 */
export function wikiContentFromConceptPage(page: ConceptPage, migratedAt: string): WikiContent {
  const metadata: PageMetadataInput = {
    schemaVersion: CONTRACT_VERSION,
    id: assertRecordId(page.key, 'Legacy page key'),
    kind: 'concept',
    state: 'committed',
    title: (page.concept || page.key).slice(0, 300),
    summary: legacyPageSummary(page),
    updatedAt: normalizeTimestamp(page.updated, migratedAt),
    courseRefs: [],
    claims: [],
    links: [],
    learner: {
      inMyWords: page.sections.in_my_words ?? '',
      stuck: page.sections.where_i_got_stuck ?? '',
      connections: page.sections.connections ?? '',
      evidenceIds: page.evidence.map((entry) => entry.ref).filter((ref) => IdentifierSchema.safeParse(ref).success),
    },
    sourceIds: [],
    provenance: {
      origin: 'legacy_concept_vault',
      migratedAt,
      legacyKey: page.key,
      ...(page.status ? { legacyStatus: page.status } : {}),
      ...(page.updated ? { legacyUpdated: page.updated } : {}),
      legacyCourseRefs: page.courseRefs,
      evidence: page.evidence,
      misconceptions: page.misconceptions,
      links: page.links,
    },
  };
  return pageContent(metadata, renderConceptBody(page));
}

/** Migration back out: what the legacy vault would have held for this page, for round-trip checks. */
export function conceptPageFromWikiPage(metadata: PageMetadata, body: string): ConceptPage | null {
  if (metadata.kind !== 'concept') return null;
  const provenance = metadata.provenance;
  return {
    key: metadata.id,
    concept: metadata.title,
    courseRefs: provenance?.legacyCourseRefs ?? [],
    status: provenance?.legacyStatus ?? 'met',
    evidence: provenance?.evidence ?? [],
    misconceptions: provenance?.misconceptions ?? [],
    links: provenance?.links ?? [],
    updated: provenance?.legacyUpdated ?? metadata.updatedAt,
    sections: sectionsFromWikiPage(metadata, body),
  };
}

export function sectionsFromWikiPage(metadata: PageMetadata, body: string): Record<PageSection, string> {
  return Object.fromEntries(
    PAGE_SECTIONS.map((section) => [section, metadata.learner?.[LEARNER_FIELD[section]] ?? readSection(body, SECTION_TITLES[section])]),
  ) as Record<PageSection, string>;
}

/** The body the legacy serializer produced, so a migrated page reads exactly as it did before. */
export function renderConceptBody(page: ConceptPage): string {
  const sections = PAGE_SECTIONS.map((section) => `## ${SECTION_TITLES[section]}\n${(page.sections[section] ?? '').trim() || '_Nothing yet._'}`).join('\n\n');
  const links = page.links.length
    ? page.links.map((link) => `- [[${link.to}]] · ${link.type.replace('_', ' ')} · ${link.origin}${link.why ? ` — ${link.why}` : ''}`).join('\n')
    : '_No links yet._';
  return `# ${page.concept || page.key}\n\n${sections}\n\n## Links\n${links}\n`;
}

export function legacyPageSummary(page: ConceptPage): string {
  const written = [page.sections.in_my_words, page.sections.where_i_got_stuck, page.sections.connections].find((section) => (section ?? '').trim());
  const line = (written ?? '').split('\n').find((candidate) => candidate.trim())?.trim();
  return (line || `${page.concept || page.key} — migrated from the earlier concept vault.`).slice(0, 400);
}

function normalizeTimestamp(value: string, fallback: string): string {
  const parsed = Date.parse(value);
  return value && Number.isFinite(parsed) ? new Date(parsed).toISOString() : fallback;
}

function normalizeBody(body: string): string {
  return body.replace(/^\s+/, '').trimEnd();
}

function stripUndefined<T>(value: T): T {
  if (Array.isArray(value)) return value.map((item) => stripUndefined(item)) as T;
  if (value && typeof value === 'object') {
    const output: Record<string, unknown> = {};
    for (const [key, item] of Object.entries(value)) {
      if (item !== undefined) output[key] = stripUndefined(item);
    }
    return output as T;
  }
  return value;
}

function stableJson(value: unknown): string {
  return JSON.stringify(canonicalize(value));
}

function canonicalize(value: unknown): unknown {
  if (Array.isArray(value)) return value.map((item) => canonicalize(item));
  if (value && typeof value === 'object') {
    const record = value as Record<string, unknown>;
    return Object.fromEntries(Object.keys(record).sort().map((key) => [key, canonicalize(record[key])]));
  }
  return value;
}
