import { z } from 'zod';
import { MAX_UNI_FEEDS_PER_COURSE, SubjectFeedRefSchema } from './feeds';

/** Version of the signed course-package contract. See `PackageManifestSchema`. */
export const CONTENT_SCHEMA_VERSION = 2 as const;

export const LessonMetaSchema = z.object({
  id: z.string(),
  courseId: z.string(),
  courseName: z.string(),
  moduleId: z.string(),
  moduleName: z.string(),
  subjectId: z.string(),
  semesterNumber: z.number().int(),
  order: z.number(),
  title: z.string(),
  summary: z.string().optional(),
  concepts: z.array(z.string()),
  prerequisites: z.array(z.string()),
  tags: z.array(z.string()),
  estimatedStudyMinutes: z.number().optional(),
});
export type LessonMeta = z.infer<typeof LessonMetaSchema>;

export interface Lesson extends LessonMeta {
  /** Lesson body without frontmatter. */
  markdown: string;
}

export const CourseSummarySchema = z.object({
  id: z.string(),
  title: z.string(),
  subjectId: z.string(),
  semesterNumber: z.number().int(),
  code: z.string().optional(),
  courseCode: z.string().optional(),
  courseType: z.string().optional(),
  credits: z.number().optional(),
  hoursPerWeek: z.number().nullable().optional(),
  deliveryMode: z.string().optional(),
  status: z.string().optional(),
  optionGroup: z.string().nullable().optional(),
  prerequisites: z.array(z.string()).optional(),
  description: z.string().optional(),
  lessonCount: z.number().int(),
  /** Content version: changes whenever any lesson file in the course changes. */
  version: z.string(),
  /** University-support corpus used by the Friend, not an academic course. */
  support: z.boolean().default(false),
  /** Institution-curated subject news feeds; signed with the rest of the metadata. */
  subjectFeeds: z.array(SubjectFeedRefSchema).max(MAX_UNI_FEEDS_PER_COURSE).optional(),
});
export type CourseSummary = z.infer<typeof CourseSummarySchema>;

export const CatalogueSchema = z.object({
  programmeId: z.string(),
  programmeName: z.string(),
  cohortId: z.string(),
  generatedAt: z.string(),
  courses: z.array(CourseSummarySchema),
});
export type Catalogue = z.infer<typeof CatalogueSchema>;

export const PackageFileSchema = z.object({
  path: z.string(),
  sha256: z.string(),
  bytes: z.number().int(),
});
export type PackageFile = z.infer<typeof PackageFileSchema>;

/**
 * The academic metadata that travels with a package and is covered by its signature.
 * Only fields the university asserts about the course belong here — never learner state.
 */
export const CourseMetadataSchema = z.object({
  schemaVersion: z.literal(CONTENT_SCHEMA_VERSION),
  title: z.string(),
  subjectId: z.string(),
  semesterNumber: z.number().int(),
  courseCode: z.string().optional(),
  courseType: z.string().optional(),
  credits: z.number().optional(),
  hoursPerWeek: z.number().nullable().optional(),
  deliveryMode: z.string().optional(),
  status: z.string().optional(),
  optionGroup: z.string().nullable().optional(),
  prerequisites: z.array(z.string()).optional(),
  lessonCount: z.number().int(),
  support: z.boolean().default(false),
  subjectFeeds: z.array(SubjectFeedRefSchema).max(MAX_UNI_FEEDS_PER_COURSE).optional(),
});
export type CourseMetadata = z.infer<typeof CourseMetadataSchema>;

/**
 * The signed academic view of a course. Only the fields the university asserts about the
 * course itself; `version` is deliberately absent because it is derived from this metadata
 * together with the file set, and including it would be circular.
 */
export function courseMetadataOf(summary: CourseSummary): CourseMetadata {
  return CourseMetadataSchema.parse({
    schemaVersion: CONTENT_SCHEMA_VERSION,
    title: summary.title,
    subjectId: summary.subjectId,
    semesterNumber: summary.semesterNumber,
    courseCode: summary.courseCode ?? summary.code,
    courseType: summary.courseType,
    credits: summary.credits,
    hoursPerWeek: summary.hoursPerWeek,
    deliveryMode: summary.deliveryMode,
    status: summary.status,
    optionGroup: summary.optionGroup,
    prerequisites: summary.prerequisites,
    lessonCount: summary.lessonCount,
    support: summary.support,
    subjectFeeds: summary.subjectFeeds,
  });
}

/**
 * Manifest schema version. `1` predates signed metadata; the engine keeps reading those but
 * marks them explicitly until the course is re-synced, so an unsigned-metadata install is
 * never silently presented as verified.
 */
export const PackageManifestSchema = z.object({
  schemaVersion: z.number().int().min(1).max(CONTENT_SCHEMA_VERSION).default(1),
  courseId: z.string(),
  version: z.string(),
  issuedAt: z.string(),
  issuer: z.string(),
  /** Absent on schemaVersion 1 manifests. */
  metadata: CourseMetadataSchema.optional(),
  files: z.array(PackageFileSchema),
});
export type PackageManifest = z.infer<typeof PackageManifestSchema>;

/** True when the manifest carries university-signed academic metadata rather than hashes alone. */
export const hasSignedMetadata = (manifest: PackageManifest): boolean =>
  manifest.schemaVersion >= CONTENT_SCHEMA_VERSION && manifest.metadata !== undefined;

/**
 * Content version. Derived from both the file set and the academic metadata, so a
 * metadata-only correction (a credit total, a renamed course) changes the version and
 * forces a re-sync instead of leaving devices silently stale.
 *
 * This is a change detector, not a security primitive — integrity comes from the signature
 * over the manifest, which covers both inputs. It is implemented here rather than with
 * node crypto so the shared package keeps working in the browser build.
 */
export function deriveContentVersion(files: PackageFile[], metadata: CourseMetadata | undefined): string {
  const shape = files
    .map((f) => `${f.path}:${f.sha256}:${f.bytes}`)
    .sort()
    .join('|');
  return `v1-${digest(`${shape}#${canonicalJson(metadata ?? null)}`)}`;
}

/** Deterministic 128-bit digest over a string, rendered as hex. */
function digest(value: string): string {
  let a = 0x811c9dc5;
  let b = 0x01000193;
  for (let i = 0; i < value.length; i++) {
    const code = value.charCodeAt(i);
    a = Math.imul(a ^ code, 0x01000193) >>> 0;
    b = Math.imul(b ^ (code + i), 0x85ebca6b) >>> 0;
  }
  return `${a.toString(16).padStart(8, '0')}${b.toString(16).padStart(8, '0')}`;
}

export const CoursePackageSchema = z.object({
  manifest: PackageManifestSchema,
  /** Base64 ed25519 signature over the canonical JSON of `manifest`. */
  signature: z.string(),
  files: z.array(z.object({ path: z.string(), content: z.string() })),
});
export type CoursePackage = z.infer<typeof CoursePackageSchema>;

/** Stable JSON used for signing: keys sorted at every level. */
export function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  if (value && typeof value === 'object') {
    const entries = Object.entries(value as Record<string, unknown>)
      .filter(([, v]) => v !== undefined)
      .sort(([a], [b]) => a.localeCompare(b));
    return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${canonicalJson(v)}`).join(',')}}`;
  }
  return JSON.stringify(value);
}
