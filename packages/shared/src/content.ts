import { z } from 'zod';

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
  description: z.string().optional(),
  lessonCount: z.number().int(),
  /** Content version: changes whenever any lesson file in the course changes. */
  version: z.string(),
  /** University-support corpus used by the Friend, not an academic course. */
  support: z.boolean().default(false),
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

export const PackageManifestSchema = z.object({
  courseId: z.string(),
  version: z.string(),
  issuedAt: z.string(),
  issuer: z.string(),
  files: z.array(PackageFileSchema),
});
export type PackageManifest = z.infer<typeof PackageManifestSchema>;

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
