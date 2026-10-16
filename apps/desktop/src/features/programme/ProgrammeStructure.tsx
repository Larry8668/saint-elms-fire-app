import { BookOpen, GraduationCap, Landmark, LifeBuoy } from 'lucide-react';
import { useMemo } from 'react';
import type { DeliveryMode, ProgrammeManifestResponse, SyncStatus } from '@sef/shared';
import { Badge, EmptyState, Eyebrow, Panel } from '@/components/ui/primitives';
import {
  academicStatusOf,
  availabilityNoteOf,
  creditsLabelOf,
  hoursLabelOf,
  prerequisiteLabelsOf,
  statusLabelOf,
  semesterRowCount,
  viewOfManifest,
  type ManifestRowView,
  type OptionGroupView,
  type SemesterView,
} from './manifest-view';
import { installStateOf, metadataCaveat } from './programme-rows';

interface ProgrammeStructureProps {
  manifest: ProgrammeManifestResponse;
  /** The cohort release list this device already holds — cross-referenced for install state only. */
  status: SyncStatus | undefined;
  onOpenCourse: (courseId: string) => void;
}

type SyncCourse = SyncStatus['courses'][number];

const DELIVERY_MODES: Record<DeliveryMode, string> = {
  'authored-courseware': 'Courseware',
  external: 'Delivered externally',
  'internship-workflow': 'Internship workflow',
};

const deliveryModeLabelOf = (mode: DeliveryMode): string => DELIVERY_MODES[mode] ?? mode.replace(/-/g, ' ');

/**
 * The full published curriculum as the university declared it: real nullable hours and real
 * zero credits, the support corpus kept out of degree numbers, and option groups shown as the
 * coherent bundles the server validates. It is read-only — a row being listed here is not
 * permission to install it, so only rows already verified on this device offer an action.
 */
export function ProgrammeStructure({ manifest, status, onOpenCourse }: ProgrammeStructureProps) {
  const view = useMemo(() => viewOfManifest(manifest), [manifest]);
  const syncByCourse = useMemo(() => new Map((status?.courses ?? []).map((course) => [course.id, course])), [status]);
  const { programme, derivedCounts } = manifest;

  const renderRow = (rowView: ManifestRowView) => (
    <ProgrammeRow key={rowView.row.rowId} rowView={rowView} manifest={manifest} released={syncByCourse.get(rowView.row.courseId)} onOpenCourse={onOpenCourse} />
  );

  return (
    <div>
      <Panel className="mb-8 p-5">
        <div className="flex flex-wrap items-start justify-between gap-4">
          <div className="min-w-0">
            <Eyebrow className="mb-2">Published curriculum</Eyebrow>
            <h2 className="text-[15px] font-semibold text-night-100">{programme.name}</h2>
            <p className="mt-1.5 flex items-center gap-1.5 text-[13px] text-night-400">
              <Landmark aria-hidden className="size-3.5 shrink-0" /> {programme.institution}
            </p>
            <p className="mt-1 text-[12px] text-night-500">
              Manifest {programme.manifestVersion} · from {programme.sourceDocuments.join(', ')}
            </p>
          </div>
          {status?.cohortId && (
            <Badge tone="beacon" className="shrink-0">
              <GraduationCap aria-hidden className="size-3" /> {status.cohortId}
            </Badge>
          )}
        </div>

        <div className="mt-5 grid gap-6 lg:grid-cols-2">
          <div>
            <Eyebrow className="mb-2.5 text-[10.5px]">Counted from the rows below</Eyebrow>
            <dl className="grid gap-3 sm:grid-cols-3">
              <Total label="Degree rows" value={view.counts.degreeRows} />
              <Total label="Support rows" value={view.counts.supportRows} note="Outside the degree" />
              <Total label="Option groups" value={view.counts.optionGroups} note={`${view.counts.bundles} bundles`} />
            </dl>
          </div>
          <div>
            <Eyebrow className="mb-2.5 text-[10.5px]">Derived by the university</Eyebrow>
            <dl className="grid gap-3 sm:grid-cols-3">
              <Total label="Programme rows" value={derivedCounts.rows} note={`${derivedCounts.degreeRows} toward the degree`} />
              <Total
                label="Degree credits"
                value={derivedCounts.degreeCredits.min === derivedCounts.degreeCredits.max ? derivedCounts.degreeCredits.min : `${derivedCounts.degreeCredits.min}–${derivedCounts.degreeCredits.max}`}
                note="One bundle per option group"
              />
              <div className="rounded-xl border border-white/[0.06] bg-black/20 p-3.5">
                <dt className="text-[11.5px] tracking-wide text-night-400 uppercase">By status</dt>
                <dd className="mt-1.5 space-y-0.5">
                  {Object.entries(derivedCounts.byStatus).map(([statusKey, count]) => (
                    <p key={statusKey} className="text-[12px] text-night-300">
                      {count} {statusLabelOf(statusKey).toLowerCase()}
                    </p>
                  ))}
                </dd>
              </div>
            </dl>
          </div>
        </div>
      </Panel>

      {view.missingRowRefs > 0 && (
        <Panel className="mb-6 border-ember-400/20 p-4">
          <p className="text-[13px] text-night-300">
            The university's semester list names {view.missingRowRefs} {view.missingRowRefs === 1 ? 'row' : 'rows'} it did not
            serve. They are left out rather than guessed.
          </p>
        </Panel>
      )}

      {view.degree.length === 0 && !view.support && view.unlisted.length === 0 && (
        <Panel>
          <EmptyState
            icon={<BookOpen />}
            title="The published programme has no rows yet"
            body="The university released the programme record without any course rows. When rows are published they appear here exactly as declared."
          />
        </Panel>
      )}

      <div className="space-y-10">
        {view.degree.map((semester) => (
          <SemesterSection key={semester.id} semester={semester} renderRow={renderRow} />
        ))}
        {view.support && <SupportSection semester={view.support} renderRow={renderRow} />}
        {view.unlisted.length > 0 && (
          <section aria-labelledby="programme-unlisted">
            <div className="mb-3 flex flex-wrap items-baseline justify-between gap-2">
              <Eyebrow id="programme-unlisted">Not filed under a semester</Eyebrow>
              <span className="text-[12px] text-night-500">
                {view.unlisted.length} {view.unlisted.length === 1 ? 'row' : 'rows'}
              </span>
            </div>
            <ul className="space-y-2">{view.unlisted.map(renderRow)}</ul>
          </section>
        )}
      </div>
    </div>
  );
}

function SemesterSection({ semester, renderRow }: { semester: SemesterView; renderRow: (rowView: ManifestRowView) => React.ReactNode }) {
  const rowCount = semesterRowCount(semester);
  return (
    <section aria-labelledby={`semester-${semester.id}`}>
      <div className="mb-3 flex flex-wrap items-baseline justify-between gap-2">
        <Eyebrow id={`semester-${semester.id}`}>{semester.name}</Eyebrow>
        <span className="text-[12px] text-night-500">
          {rowCount} {rowCount === 1 ? 'row' : 'rows'}
        </span>
      </div>
      <ul className="space-y-2">{semester.rows.map(renderRow)}</ul>
      {semester.optionGroups.length > 0 && (
        <div className="mt-3 space-y-3">
          {semester.optionGroupNote && <p className="text-[12.5px] leading-5 whitespace-pre-line text-night-400">{semester.optionGroupNote}</p>}
          {semester.optionGroups.map((group) => (
            <OptionGroupBlock key={group.id} group={group} renderRow={renderRow} />
          ))}
        </div>
      )}
    </section>
  );
}

/** One coherent choice: exactly one whole bundle is selected, and the server validates each one. */
function OptionGroupBlock({ group, renderRow }: { group: OptionGroupView; renderRow: (rowView: ManifestRowView) => React.ReactNode }) {
  return (
    <Panel className="border-beacon-400/20 p-4">
      <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
        <h3 className="text-[13.5px] font-semibold text-night-100">Elective option group</h3>
        <Badge tone="beacon">Choose 1 of {group.bundles.length} {group.bundles.length === 1 ? 'bundle' : 'bundles'}</Badge>
      </div>
      <p className="mb-3 text-[12.5px] leading-5 text-night-400">
        A selection is one whole bundle — the university validates each bundle as a coherent set, so its rows cannot be picked apart.
      </p>
      <div className="grid gap-3 md:grid-cols-2">
        {group.bundles.map((bundle, index) => (
          <div key={bundle.id} className="rounded-xl border border-white/[0.08] bg-black/20 p-3">
            <p className="mb-2 text-[11.5px] font-semibold tracking-wide text-night-400 uppercase">Bundle {index + 1}</p>
            <ul className="space-y-2">{bundle.rows.map(renderRow)}</ul>
          </div>
        ))}
      </div>
    </Panel>
  );
}

/** Visually apart from the degree sections, and labelled as outside the degree. */
function SupportSection({ semester, renderRow }: { semester: SemesterView; renderRow: (rowView: ManifestRowView) => React.ReactNode }) {
  return (
    <section aria-labelledby="support-corpus">
      <div className="mb-3 flex flex-wrap items-baseline justify-between gap-2">
        <Eyebrow id="support-corpus">{semester.name}</Eyebrow>
        <span className="text-[12px] text-night-500">
          {semester.rows.length} {semester.rows.length === 1 ? 'row' : 'rows'} · not degree credit
        </span>
      </div>
      <Panel className="border-dashed p-4">
        <p className="mb-3 flex items-start gap-2 text-[13px] leading-5 text-night-400">
          <LifeBuoy aria-hidden className="mt-0.5 size-4 shrink-0 text-beacon-300" />
          University support material. These rows carry no degree credit and are left out of the degree numbers above.
        </p>
        <ul className="space-y-2">{semester.rows.map(renderRow)}</ul>
      </Panel>
    </section>
  );
}

interface ProgrammeRowProps {
  rowView: ManifestRowView;
  manifest: ProgrammeManifestResponse;
  /** The cohort release row for this course, when the uni released it to this student's cohort. */
  released: SyncCourse | undefined;
  onOpenCourse: (courseId: string) => void;
}

function ProgrammeRow({ rowView, manifest, released, onOpenCourse }: ProgrammeRowProps) {
  const { row } = rowView;
  const academic = academicStatusOf(row);
  const installed = released?.state === 'installed' || released?.state === 'local-only';
  const install = released ? installStateOf(released) : null;
  const caveat = released ? metadataCaveat(released) : null;
  const availabilityNote = availabilityNoteOf(rowView, released);
  const prerequisites = prerequisiteLabelsOf(row, manifest);

  return (
    <Panel className="flex flex-col gap-3 p-4 sm:flex-row sm:items-center sm:justify-between">
      <div className="min-w-0">
        <div className="flex flex-wrap items-center gap-2">
          <span className="font-mono text-[12px] text-night-500">{row.courseCode}</span>
          <h3 className="text-[14.5px] leading-snug font-semibold text-night-100">{row.courseName}</h3>
          <Badge tone={academic.tone}>{academic.label}</Badge>
          {install && installed && <Badge tone={install.tone}>{install.label}</Badge>}
        </div>
        <p className="mt-1 text-[12.5px] text-night-400">
          {row.courseType} · {creditsLabelOf(row)} · {hoursLabelOf(row)} · {deliveryModeLabelOf(row.deliveryMode)}
        </p>
        {prerequisites.length > 0 && <p className="mt-1 text-[12.5px] text-night-500">Prerequisites: {prerequisites.join(', ')}</p>}
        {row.notes && <p className="mt-1 text-[12.5px] text-night-500">{row.notes}</p>}
        {availabilityNote && <p className="mt-1.5 text-[12.5px] text-night-400">{availabilityNote}</p>}
        {caveat && <p className="mt-1.5 text-[12.5px] text-ember-300">{caveat}</p>}
        {released?.localVersion && <p className="mt-1 text-[12px] text-night-500">Installed {released.localVersion}</p>}
      </div>

      {installed && (
        <button
          type="button"
          onClick={() => onOpenCourse(row.courseId)}
          className="shrink-0 cursor-pointer self-start rounded-xl border border-white/12 px-3 py-1.5 text-[13px] text-night-200 transition hover:border-beacon-400/50 hover:bg-beacon-500/10 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-beacon-400/60 sm:self-auto"
        >
          Open course
        </button>
      )}
    </Panel>
  );
}

function Total({ label, value, note }: { label: string; value: number | string; note?: string }) {
  return (
    <div className="rounded-xl border border-white/[0.06] bg-black/20 p-3.5">
      <dt className="text-[11.5px] tracking-wide text-night-400 uppercase">{label}</dt>
      <dd className="mt-1 text-2xl leading-none font-semibold text-night-100">{value}</dd>
      {note && <p className="mt-1.5 text-[11.5px] text-night-500">{note}</p>}
    </div>
  );
}
