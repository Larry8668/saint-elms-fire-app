import { readFile, readdir } from 'node:fs/promises';
import path from 'node:path';
import { parse } from 'yaml';
import { z } from 'zod';
import {
  AcademicStatusSchema,
  CourseTypeSchema,
  DeliveryModeSchema,
  OptionGroupSchema,
  ProgrammeSchema,
  type CourseAvailability,
  type OptionGroup,
  type Programme,
  type ProgrammeRow,
} from '../programme';
import { CONTRACT_VERSION, IdentifierListSchema, IdentifierSchema } from '../contracts';

/**
 * Raw shapes read from `programme-manifest.yaml`. The file is the programme's
 * source of truth; these schemas validate it before anything is derived from it.
 */

const RawRowSchema = z.object({
  rowId: IdentifierSchema,
  courseCode: z.string().min(1).max(80),
  courseId: IdentifierSchema,
  courseName: z.string().min(1).max(300),
  subjectId: IdentifierSchema,
  courseType: CourseTypeSchema,
  hoursPerWeek: z.number().nonnegative().nullable(),
  credits: z.number().nonnegative(),
  optionGroup: IdentifierSchema.nullable(),
  deliveryMode: DeliveryModeSchema,
  prerequisites: IdentifierListSchema,
  status: AcademicStatusSchema,
  packageTemplate: z.string().min(1).optional(),
  contentPath: z.string().min(1).optional(),
  notes: z.string().optional(),
});

const RawSectionSchema = z.object({
  semesterId: z.string().optional(),
  semesterName: z.string().optional(),
  optionGroupNote: z.string().optional(),
  rows: z.array(RawRowSchema),
});

const RawCountsSchema = z.object({
  bySemester: z.record(z.string(), z.number()),
  byStatus: z.record(z.string(), z.number()),
  total: z.number(),
});

const RawOptionGroupSchema = OptionGroupSchema;
const RawOptionGroupsSchema = z.array(RawOptionGroupSchema);

const RawManifestSchema = z.object({
  programmeId: IdentifierSchema,
  programmeName: z.string().min(1),
  institution: z.string().min(1),
  sourcePdfs: z.array(z.string().min(1)).min(1),
  manifestVersion: z.string().min(1).max(160),
  optionGroups: RawOptionGroupsSchema,
  counts: RawCountsSchema,
}).passthrough();

export interface ManifestSemester {
  id: string;
  name: string;
  /** 0 is the cross-semester support corpus. */
  number: number;
  rowIds: string[];
  optionGroupNote?: string;
}

export interface ManifestDiagnostic {
  level: 'info' | 'warn' | 'error';
  code: string;
  message: string;
  rowId?: string;
  courseId?: string;
}

/** Thrown when the manifest has structural problems: duplicate ids, dangling references, broken bundles. */
export class ProgrammeManifestError extends Error {
  constructor(readonly diagnostics: ManifestDiagnostic[]) {
    super(diagnostics.map((d) => `${d.code}: ${d.message}`).join('; '));
    this.name = 'ProgrammeManifestError';
  }
}

export interface ProgrammeCounts {
  rows: number;
  bySemester: Record<string, number>;
  byStatus: Partial<Record<ProgrammeRow['status'], number>>;
  /** Rows that count toward the degree: semester rows, support excluded. */
  degreeRows: number;
  /** Degree credit if exactly one bundle per option group is selected. */
  degreeCredits: { min: number; max: number };
}

export interface ProgrammeManifestResult {
  programme: Programme;
  semesters: ManifestSemester[];
  /** Declared aggregates from the file, kept only to reconcile against rows. */
  declaredCounts: {
    total: number;
    bySemester: Record<string, number>;
    byStatus: Record<string, number>;
  };
  derivedCounts: ProgrammeCounts;
  diagnostics: ManifestDiagnostic[];
  /** Resolves a row's historic content/ path to the current courseware tree. */
  resolveContentDir(row: ProgrammeRow, root: string): string | null;
}

const SECTION_NUMBER: Record<string, number> = { support: 0 };

function sectionNumber(key: string): number {
  const semesterMatch = /^semester-(\d+)$/.exec(key);
  if (semesterMatch) return Number(semesterMatch[1]);
  const shortMatch = /^sem-(\d+)$/.exec(key);
  if (shortMatch) return Number(shortMatch[1]);
  return SECTION_NUMBER[key] ?? -1;
}

/** Reconciles the file's aggregate fields with counts derived from the rows. */
function deriveCounts(rows: ProgrammeRow[], optionGroups: OptionGroup[]): ProgrammeCounts {
  const bySemester: Record<string, number> = {};
  const byStatus: Partial<Record<ProgrammeRow['status'], number>> = {};
  const rowById = new Map(rows.map((r) => [r.rowId, r]));
  for (const row of rows) {
    bySemester[row.semesterNumber] = (bySemester[row.semesterNumber] ?? 0) + 1;
    byStatus[row.status] = (byStatus[row.status] ?? 0) + 1;
  }
  const required = rows.filter((r) => r.semesterNumber > 0 && !r.optionGroup);
  const requiredCredits = required.reduce((sum, r) => sum + r.credits, 0);
  let minElective = 0;
  let maxElective = 0;
  for (const group of optionGroups) {
    // One complete bundle is selected per group; the alternatives must not inflate totals.
    const bundleCredits = group.bundles.map((bundle) =>
      bundle.rowIds.reduce((sum, rowId) => sum + (rowById.get(rowId)?.credits ?? 0), 0),
    );
    minElective += Math.min(...bundleCredits);
    maxElective += Math.max(...bundleCredits);
  }
  const degreeRows = rows.filter((r) => r.semesterNumber > 0).length;
  return {
    rows: rows.length,
    bySemester,
    byStatus,
    degreeRows,
    degreeCredits: { min: requiredCredits + minElective, max: requiredCredits + maxElective },
  };
}

/** Safe resolution of a historic content/ path against the current courseware root. */
export function resolveContentDir(raw: string | undefined, root: string): string | null {
  if (!raw) return null;
  const relative = raw.replace(/^\.\//, '').replace(/^content\//, '').replace(/\/+$/, '');
  if (relative.split('/').some((part) => part === '..' || part === '')) return null;
  const target = path.resolve(root, relative);
  return target.startsWith(path.resolve(root) + path.sep) ? target : null;
}

function semesterFromKey(key: string): number {
  const number = sectionNumber(key);
  if (number >= 0) return number;
  throw new Error(`Unknown manifest section: ${key}`);
}

function runDiagnostics(
  rows: ProgrammeRow[],
  raw: z.infer<typeof RawManifestSchema>,
  semesters: ManifestSemester[],
): ManifestDiagnostic[] {
  const diagnostics: ManifestDiagnostic[] = [];
  const courseIds = new Map<string, ProgrammeRow>();
  for (const row of rows) {
    if (courseIds.has(row.courseId)) {
      diagnostics.push({ level: 'error', code: 'duplicate_course_id', message: `courseId ${row.courseId} appears on rows ${courseIds.get(row.courseId)!.rowId} and ${row.rowId}`, courseId: row.courseId });
      continue;
    }
    courseIds.set(row.courseId, row);
  }

  for (const row of rows) {
    for (const prereq of row.prerequisites) {
      if (!courseIds.has(prereq)) {
        diagnostics.push({ level: 'error', code: 'unknown_prerequisite', message: `prerequisite ${prereq} of ${row.rowId} is not a courseId in this programme`, rowId: row.rowId });
      }
    }
    if (row.optionGroup && !raw.optionGroups.some((g) => g.id === row.optionGroup)) {
      diagnostics.push({ level: 'error', code: 'unknown_option_group', message: `optionGroup ${row.optionGroup} of ${row.rowId} is not defined`, rowId: row.rowId });
    }
  }

  for (const group of raw.optionGroups) {
    const ids = new Set<string>();
    for (const bundle of group.bundles) {
      for (const rowId of bundle.rowIds) {
        if (ids.has(rowId)) {
          diagnostics.push({ level: 'error', code: 'bundle_row_reused', message: `${rowId} appears in more than one bundle of ${group.id}` });
        }
        ids.add(rowId);
        const row = rows.find((r) => r.rowId === rowId);
        if (!row) {
          diagnostics.push({ level: 'error', code: 'bundle_unknown_row', message: `${group.id} bundle references unknown row ${rowId}` });
          continue;
        }
        if (row.optionGroup !== group.id) {
          diagnostics.push({ level: 'error', code: 'bundle_row_group_mismatch', message: `${rowId} is in optionGroup ${row.optionGroup ?? 'null'}, not ${group.id}` });
        }
      }
    }
    for (const row of rows) {
      if (row.optionGroup === group.id && !ids.has(row.rowId)) {
        diagnostics.push({ level: 'error', code: 'row_missing_from_bundles', message: `${row.rowId} claims ${group.id} but no bundle includes it`, rowId: row.rowId });
      }
    }
    for (const bundle of group.bundles) {
      const members = bundle.rowIds.map((id) => rows.find((r) => r.rowId === id)).filter((r): r is ProgrammeRow => Boolean(r));
      const theory = members.find((r) => r.courseType === 'Major Elective');
      const lab = members.find((r) => r.courseType === 'Lab');
      if (theory && lab && !lab.prerequisites.includes(theory.courseId)) {
        diagnostics.push({
          level: 'error',
          code: 'unpaired_theory_lab',
          message: `bundle ${bundle.id} pairs ${theory.rowId} with ${lab.rowId}, but the lab's prerequisites do not include ${theory.courseId}`,
          rowId: lab.rowId,
        });
      }
    }
  }

  for (const group of raw.optionGroups) {
    const memberRows = group.bundles
      .flatMap((bundle) => bundle.rowIds)
      .map((rowId) => rows.find((r) => r.rowId === rowId))
      .filter((row): row is ProgrammeRow => Boolean(row));
    const memberPrefixes = memberRows.map((r) => r.courseCode.replace(/[A-Z]-\d+$/, ''));
    const ownSemesters = new Set(memberRows.map((r) => r.semesterNumber));
    const ownNotes = semesters.filter((s) => ownSemesters.has(s.number)).map((s) => s.optionGroupNote ?? '').join('\n');
    const documented = ownNotes.includes(group.id) || memberPrefixes.some((prefix) => ownNotes.includes(prefix));
    if (!documented) {
      diagnostics.push({
        level: 'warn',
        code: 'undocumented_select_policy',
        message: `no optionGroupNote for its semester documents how many bundles to select from ${group.id}`,
      });
    }
  }

  const derived = deriveCounts(rows, raw.optionGroups.map((g) => OptionGroupSchema.parse(g)));
  if (derived.rows !== raw.counts.total) {
    diagnostics.push({ level: 'warn', code: 'stale_total_count', message: `manifest counts.total is ${raw.counts.total}; ${derived.rows} rows are defined` });
  }
  for (const [key, declared] of Object.entries(raw.counts.bySemester)) {
    const number = sectionNumber(key);
    const actual = derived.bySemester[number];
    if (actual !== declared) {
      diagnostics.push({ level: 'warn', code: 'stale_semester_count', message: `counts.bySemester[${key}] is ${declared}; ${actual ?? 0} rows are defined` });
    }
  }
  for (const [status, declared] of Object.entries(raw.counts.byStatus)) {
    const actual = derived.byStatus[status as ProgrammeRow['status']] ?? 0;
    if (actual !== declared && !(actual === 0 && declared === 0)) {
      diagnostics.push({ level: 'warn', code: 'stale_status_count', message: `counts.byStatus[${status}] is ${declared}; ${actual} rows have that status` });
    }
  }

  return diagnostics;
}

/**
 * Reads and validates `programme-manifest.yaml` into the shared Programme contract.
 * Throws on any structural problem; aggregate mismatches are returned as diagnostics.
 */
export async function loadProgrammeManifest(root: string): Promise<ProgrammeManifestResult> {
  const file = path.join(root, 'programme-manifest.yaml');
  const raw = RawManifestSchema.parse(parse(await readFile(file, 'utf8')));

  const rows: ProgrammeRow[] = [];
  const semesters: ManifestSemester[] = [];
  for (const [key, value] of Object.entries(raw)) {
    if (sectionNumber(key) < 0) continue;
    const section = RawSectionSchema.parse(value);
    const number = semesterFromKey(key);
    semesters.push({
      id: section.semesterId ?? key,
      name: section.semesterName ?? (key === 'support' ? 'University support' : `Semester ${number}`),
      number,
      rowIds: section.rows.map((r) => r.rowId),
      optionGroupNote: section.optionGroupNote,
    });
    for (const row of section.rows) {
      rows.push({ ...row, schemaVersion: CONTRACT_VERSION, semesterNumber: number });
    }
  }

  const programme: Programme = ProgrammeSchema.parse({
    schemaVersion: CONTRACT_VERSION,
    id: raw.programmeId,
    name: raw.programmeName,
    institution: raw.institution,
    manifestVersion: raw.manifestVersion,
    sourceDocuments: raw.sourcePdfs,
    rows,
    optionGroups: raw.optionGroups.map((g) => OptionGroupSchema.parse(g)),
  });

  const diagnostics = runDiagnostics(rows, raw, semesters);
  const errors = diagnostics.filter((d) => d.level === 'error');
  if (errors.length) throw new ProgrammeManifestError(diagnostics);
  return {
    programme,
    semesters,
    declaredCounts: { total: raw.counts.total, bySemester: raw.counts.bySemester, byStatus: raw.counts.byStatus },
    derivedCounts: deriveCounts(rows, programme.optionGroups),
    diagnostics,
    resolveContentDir: (row, rootDir = root) => resolveContentDir(row.contentPath, rootDir),
  };
}

export async function courseFilesIn(root: string, row: ProgrammeRow): Promise<number> {
  const dir = resolveContentDir(row.contentPath, root);
  if (!dir) return 0;
  try {
    return (await readdir(dir)).filter((name) => name.endsWith('.md')).length;
  } catch {
    return 0;
  }
}

export function availabilityFor(row: ProgrammeRow, fileCount: number): CourseAvailability {
  const content = row.deliveryMode === 'external'
    ? 'external'
    : row.deliveryMode === 'internship-workflow'
      ? 'workflow'
      : fileCount > 0
        ? 'authored'
        : 'missing';
  return {
    content,
    release: row.status === 'released' ? 'released' : 'unreleased',
    selection: 'not_applicable',
  };
}
