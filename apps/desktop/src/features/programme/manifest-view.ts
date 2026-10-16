import type {
  AcademicStatus,
  CourseAvailability,
  DeviceProfile,
  ProgrammeManifestResponse,
  ProgrammeRow,
  SyncStatus,
} from '@sef/shared';
import { EngineError } from '@/lib/api';
import { admissionOf } from '@/features/auth/admission';
import type { BadgeTone } from './programme-rows';

/** One manifest row paired with the availability the uni served for it — null when it served none. */
export interface ManifestRowView {
  row: ProgrammeRow;
  availability: CourseAvailability | null;
}

export interface BundleView {
  id: string;
  rows: ManifestRowView[];
}

/** A server-validated option group: the student selects exactly one complete bundle. */
export interface OptionGroupView {
  id: string;
  bundles: BundleView[];
}

export interface SemesterView {
  id: string;
  name: string;
  number: number;
  optionGroupNote: string | null;
  /** Rows not claimed by an option group, in the order the uni served them. */
  rows: ManifestRowView[];
  optionGroups: OptionGroupView[];
}

export interface ManifestView {
  /** Semesters that carry degree rows, ascending. */
  degree: SemesterView[];
  /** The semester-zero support corpus, merged if it arrived in pieces. Null when there is none. */
  support: SemesterView | null;
  /** Rows no semester listed — displayed plainly rather than dropped. */
  unlisted: ManifestRowView[];
  /** Semester references to rows the uni did not serve. Counted, never resolved to a guess. */
  missingRowRefs: number;
  /** The UI's own grouping, counted from the rows on screen — never from a stored aggregate. */
  counts: {
    degreeRows: number;
    supportRows: number;
    optionGroups: number;
    bundles: number;
  };
}

const toRowView = (row: ProgrammeRow, availability: ProgrammeManifestResponse['availability']): ManifestRowView => ({
  row,
  availability: availability[row.rowId] ?? null,
});

/**
 * Turns the served manifest into the structure the view renders. Every count is derived from
 * the rows themselves so a stale aggregate can never disagree with what is on screen; the
 * university's own `derivedCounts` are displayed beside this grouping, never recomputed here.
 * Semester zero is the support corpus and is kept out of every degree number.
 */
export function viewOfManifest(manifest: ProgrammeManifestResponse): ManifestView {
  const rowsById = new Map(manifest.programme.rows.map((row) => [row.rowId, row]));
  const referenced = new Set<string>();
  let missingRowRefs = 0;

  const resolve = (rowId: string): ManifestRowView | null => {
    const row = rowsById.get(rowId);
    if (!row) {
      missingRowRefs += 1;
      return null;
    }
    referenced.add(rowId);
    return toRowView(row, manifest.availability);
  };

  const assignedGroups = new Set<string>();
  /** Rows claimed into an attached group's bundles — rendered there once, never again as plain rows. */
  const groupedRowIds = new Set<string>();
  const semesterViews: SemesterView[] = [];
  for (const semester of manifest.semesters) {
    const optionGroups: OptionGroupView[] = [];
    for (const group of manifest.programme.optionGroups) {
      if (assignedGroups.has(group.id)) continue;
      const memberIds = new Set(group.bundles.flatMap((bundle) => bundle.rowIds));
      if (!semester.rowIds.some((rowId) => memberIds.has(rowId))) continue;
      assignedGroups.add(group.id);
      for (const rowId of memberIds) groupedRowIds.add(rowId);
      optionGroups.push({
        id: group.id,
        bundles: group.bundles.map((bundle) => ({
          id: bundle.id,
          rows: bundle.rowIds.map(resolve).filter((view): view is ManifestRowView => view !== null),
        })),
      });
    }
    // A group attaches to the first semester referencing it, and a bundle is indivisible: a member
    // another semester also lists renders inside the bundle there, not as a second plain row here.
    const rows = semester.rowIds
      .filter((rowId) => !groupedRowIds.has(rowId))
      .map(resolve)
      .filter((view): view is ManifestRowView => view !== null);
    semesterViews.push({
      id: semester.id,
      name: semester.name,
      number: semester.number,
      optionGroupNote: semester.optionGroupNote ?? null,
      rows,
      optionGroups,
    });
  }

  const degree = semesterViews.filter((semester) => semester.number > 0).sort((a, b) => a.number - b.number);
  const supportParts = semesterViews.filter((semester) => semester.number === 0);
  const support: SemesterView | null = supportParts.length
    ? {
        id: supportParts[0]!.id,
        name: supportParts[0]!.name,
        number: 0,
        optionGroupNote: supportParts[0]!.optionGroupNote,
        rows: supportParts.flatMap((part) => part.rows),
        optionGroups: supportParts.flatMap((part) => part.optionGroups),
      }
    : null;

  const unlisted = manifest.programme.rows.filter((row) => !referenced.has(row.rowId)).map((row) => toRowView(row, manifest.availability));
  const degreeGroups = degree.flatMap((semester) => semester.optionGroups);

  return {
    degree,
    support,
    unlisted,
    missingRowRefs,
    counts: {
      degreeRows: degree.reduce((n, semester) => n + semesterRowCount(semester), 0),
      supportRows: support ? semesterRowCount(support) : 0,
      optionGroups: degreeGroups.length,
      bundles: degreeGroups.reduce((n, group) => n + group.bundles.length, 0),
    },
  };
}

/** Every row a semester renders: its plain rows plus every option-bundle member. */
export const semesterRowCount = (semester: SemesterView): number =>
  semester.rows.length + semester.optionGroups.reduce((n, group) => n + group.bundles.reduce((m, bundle) => m + bundle.rows.length, 0), 0);

export const ACADEMIC_STATUSES: Record<AcademicStatus, { label: string; tone: BadgeTone }> = {
  released: { label: 'Released', tone: 'aurora' },
  in_authoring: { label: 'Being written', tone: 'beacon' },
  planned: { label: 'Planned', tone: 'neutral' },
  external: { label: 'External', tone: 'gold' },
  pending: { label: 'Pending', tone: 'neutral' },
  out_of_scope: { label: 'Outside this degree', tone: 'neutral' },
};

/**
 * The status crosses the network, so a version skew can supply one this build predates.
 * An unrecognised status is reported as unknown and never rendered as if it meant "released".
 */
const UNKNOWN_STATUS: { label: string; tone: BadgeTone } = { label: 'Status not recognised by this app', tone: 'rose' };

export const academicStatusOf = (row: ProgrammeRow): { label: string; tone: BadgeTone } => ACADEMIC_STATUSES[row.status] ?? UNKNOWN_STATUS;

/** A `byStatus` key the schema does not pin down gets readable copy without inventing a meaning. */
export const statusLabelOf = (status: string): string => ACADEMIC_STATUSES[status as AcademicStatus]?.label ?? status.replace(/_/g, ' ');

/** Zero credits are real and render as such; only unknown hours are spelled out. */
export const creditsLabelOf = (row: ProgrammeRow): string => `${row.credits} ${row.credits === 1 ? 'credit' : 'credits'}`;

export const hoursLabelOf = (row: ProgrammeRow): string => (row.hoursPerWeek === null ? 'Hours not published' : `${row.hoursPerWeek} h/week`);

/** Prerequisite course codes where the target row was served, the plain id where it was not. */
export function prerequisiteLabelsOf(row: ProgrammeRow, manifest: ProgrammeManifestResponse): string[] {
  return row.prerequisites.map((id) => manifest.programme.rows.find((candidate) => candidate.courseId === id)?.courseCode ?? id);
}

/**
 * What a student may honestly be told about getting this row onto this device, driven by the
 * served availability and the cohort release list. An external, workflow or unreleased row has
 * no action at all: being listed was never permission to install.
 */
export function availabilityNoteOf(view: ManifestRowView, released: SyncStatus['courses'][number] | undefined): string | null {
  const { availability } = view;
  if (!availability) return 'The university published no availability for this row.';
  if (availability.content === 'external') return 'Delivered outside this app — there is no package to install.';
  if (availability.content === 'workflow') return 'Runs as an internship workflow with the university, not as courseware on this device.';
  if (availability.content === 'missing') return 'No courseware files have been published for this row yet.';
  if (availability.release === 'unreleased') return null;
  if (!released) return 'Released, but not to your cohort yet.';
  if (released.state === 'available' || released.state === 'update') return 'Released to your cohort — download it from the Released courses tab.';
  return null;
}

/** Why the programme record could not be read — the reason decides the copy, never a raw code. */
export type ProgrammeRefusal = 'admission' | 'conflict' | 'no_session' | 'uni_unreachable' | 'unavailable';

/**
 * Maps the engine's typed failure to the honest reason for it, cross-referencing the release
 * status this device already holds. A 503 carries no detail of its own, so the sync status —
 * real engine state, not a guess — supplies the why. A conflict is surfaced, never retried.
 */
export function refusalOf(error: unknown, status: SyncStatus | undefined, profile: DeviceProfile): ProgrammeRefusal {
  if (error instanceof EngineError) {
    if (error.status === 403 || error.code === 'unapproved') return 'admission';
    if (error.status === 409) return 'conflict';
    if (error.status === 503) {
      if (status?.authRequired) return 'no_session';
      if (status && !status.uniReachable) return 'uni_unreachable';
      // The uni releases this record to approved enrolments and staff; anyone else is refused.
      if (admissionOf(profile) !== 'approved') return 'admission';
      return 'unavailable';
    }
  }
  return 'unavailable';
}
