import { useState, type ReactNode } from 'react';
import { ArrowLeft, Check, Download, KeyRound, UserRound } from 'lucide-react';
import type { AdminStudentRow, Enrolment, EnrolmentStatus } from '@sef/shared';
import { decideEnrolment, patchStudent, sendRecoveryEmail } from '@/api/admin-api';
import type { Cohort } from '@/api/guards';
import { keys, useCohorts, useStudent } from '@/api/queries';
import { useStaffMutation } from '@/api/use-staff-mutation';
import { ErrorPanel } from '@/components/error-panel';
import { ReasonForm } from '@/components/reason-form';
import { Badge, EmptyState, Fact, Input, Label, Panel, Select } from '@/components/ui/primitives';
import { Button } from '@/components/ui/button';
import { StudentDetailSkeleton } from '@/components/ui/skeletons';
import { WorkingLabel } from '@/components/ui/loading';
import { displayName, formatTimestamp } from '@/lib/format';

type DecisionAction = 'approve' | 'reject' | 'suspend' | 'reinstate' | 'assign_cohort';

/**
 * The university's own transition table (`STAFF_TRANSITIONS` in `server/uni/src/enrolments.ts`).
 * Mirrored so the registrar is not offered a decision the server will refuse; the server stays
 * the authority and its refusal is always surfaced.
 */
const ACTIONS: Record<EnrolmentStatus, DecisionAction[]> = {
  pending: ['approve', 'reject'],
  approved: ['suspend', 'assign_cohort'],
  suspended: ['reinstate'],
  rejected: [],
  withdrawn: [],
};

const ACTION_COPY: Record<DecisionAction, { label: string; title: string; description: string; needsCohort: boolean }> = {
  approve: {
    label: 'Approve',
    title: 'Approve this application',
    description: 'Approving puts the student in an approved enrolment and grants course access.',
    needsCohort: true,
  },
  reject: {
    label: 'Reject',
    title: 'Reject this application',
    description: 'The application ends as rejected. The student can apply again later.',
    needsCohort: false,
  },
  suspend: {
    label: 'Suspend',
    title: 'Suspend this enrolment',
    description: 'Suspension revokes every session for this student and withdraws their course access.',
    needsCohort: false,
  },
  reinstate: {
    label: 'Reinstate',
    title: 'Reinstate this enrolment',
    description: 'The enrolment returns to approved, keeping its current cohort.',
    needsCohort: false,
  },
  assign_cohort: {
    label: 'Change cohort',
    title: 'Correct the cohort',
    description: 'Moves an approved student to a different cohort. Their access follows the new cohort.',
    needsCohort: true,
  },
};

const STATUS_TONE = {
  pending: 'ember',
  approved: 'aurora',
  rejected: 'rose',
  suspended: 'rose',
  withdrawn: 'neutral',
} as const;

export function StudentDetailView({ profileId }: { profileId: string }) {
  const student = useStudent(profileId);
  const cohorts = useCohorts();
  const [action, setAction] = useState<DecisionAction | null>(null);
  const [editing, setEditing] = useState(false);
  const [recovery, setRecovery] = useState<'idle' | 'sending' | 'sent'>('idle');
  const [form, setForm] = useState({ legalName: '', preferredName: '', status: 'active' as 'active' | 'suspended' });

  const row = student.data?.row;
  const enrolment = row?.enrolment ?? null;

  const decide = useStaffMutation(
    ({ enrolmentId, action, reason, cohortId, expectedVersion }: {
      enrolmentId: string;
      action: DecisionAction;
      reason: string;
      cohortId?: string;
      expectedVersion: number;
    }) => decideEnrolment(enrolmentId, { action, reason, cohortId, expectedVersion }),
    { invalidate: [keys.student(profileId), ['students'], ['audit']], onSuccess: () => setAction(null) },
  );

  const profile = useStaffMutation(
    ({ reason, legalName, preferredName, status, expectedVersion }: {
      reason: string;
      legalName?: string;
      preferredName?: string | null;
      status?: 'active' | 'suspended';
      expectedVersion: number;
    }) => patchStudent(profileId, { reason, legalName, preferredName, status, expectedVersion }),
    { invalidate: [keys.student(profileId), ['students'], ['audit']], onSuccess: () => setEditing(false) },
  );

  const recover = useStaffMutation(() => sendRecoveryEmail(profileId), {
    onSuccess: () => setRecovery('sent'),
  });

  const startEditing = () => {
    if (!row) return;
    setForm({ legalName: row.legalName, preferredName: row.preferredName ?? '', status: row.status });
    setEditing(true);
  };

  if (student.isPending) return <StudentDetailSkeleton />;

  if (student.isError) {
    return (
      <div className="space-y-4">
        <BackLink />
        <ErrorPanel error={student.error} onRetry={() => void student.refetch()} retryLabel="Reload record" />
      </div>
    );
  }

  if (!row || !enrolment) {
    return (
      <div className="space-y-4">
        <BackLink />
        <Panel>
          <EmptyState
            icon={<UserRound />}
            title="No enrolment to administer"
            body="This profile has no enrolment record, so there is nothing to decide. Check the account and its verified email address instead."
          />
        </Panel>
        {row && <ProfilePanel row={row} />}
      </div>
    );
  }

  const exportRecord = () => {
    const payload = JSON.stringify(
      { exportedFrom: 'Saint Elms University registrar', exportedAt: new Date().toISOString(), student: row, enrolment },
      null,
      2,
    );
    const url = URL.createObjectURL(new Blob([payload], { type: 'application/json' }));
    const link = document.createElement('a');
    link.href = url;
    link.download = `${row.profileId}-admission.json`;
    link.click();
    URL.revokeObjectURL(url);
  };

  return (
    <div className="space-y-5">
      <BackLink />

      <div className="flex flex-col gap-3 sm:flex-row sm:items-end sm:justify-between">
        <div className="min-w-0">
          <h1 className="font-display text-4xl leading-tight text-night-100">{displayName(row.legalName, row.preferredName)}</h1>
          <p className="mt-1 text-[13px] text-night-400">
            {row.email ?? 'No account on file'}
            {row.email ? (row.emailVerified ? ' · verified' : ' · unverified') : ''}
          </p>
        </div>
        <div className="flex flex-wrap gap-2">
          <Button variant="outline" size="sm" onClick={exportRecord}>
            <Download aria-hidden />
            Export record
          </Button>
        </div>
      </div>

      {decide.isError && (
        <ErrorPanel error={decide.error} onRetry={() => void student.refetch()} retryLabel="Reload record">
          <p className="mt-2 text-[12.5px] text-night-400">
            The reason you typed has not been sent. Reload to see the current state, then decide again.
          </p>
        </ErrorPanel>
      )}

      <Panel className="p-6">
        <dl className="grid gap-5 sm:grid-cols-2 lg:grid-cols-3">
          <Fact label="Enrolment state">
            <Badge tone={STATUS_TONE[enrolment.status]}>{enrolment.status}</Badge>
          </Fact>
          <Fact label="Cohort">{cohortName(enrolment.cohortId, cohorts.data ?? [])}</Fact>
          <Fact label="Enrolment version">{enrolment.version}</Fact>
          <Fact label="Account state">
            <Badge tone={row.status === 'active' ? 'aurora' : 'rose'}>{row.status}</Badge>
          </Fact>
          <Fact label="Programme">{enrolment.programmeId}</Fact>
          <Fact label="Curriculum">{enrolment.curriculumVersion}</Fact>
          <Fact label="Applied">{formatTimestamp(enrolment.requestedAt)}</Fact>
          <Fact label="Last change">{formatTimestamp(enrolment.updatedAt)}</Fact>
          <Fact label="Profile id">
            <span className="font-mono text-[12.5px]">{row.profileId}</span>
          </Fact>
          {enrolment.decision && (
            <Fact label="Decided by">
              <span className="font-mono text-[12.5px]">{enrolment.decision.actorId}</span> · {formatTimestamp(enrolment.decision.at)}
            </Fact>
          )}
        </dl>

        {enrolment.decision && (
          <blockquote className="mt-5 border-l-2 border-beacon-400/50 pl-4 text-[13.5px] leading-6 text-night-300">
            {enrolment.decision.reason}
          </blockquote>
        )}
      </Panel>

      <AcademicPlacement enrolment={enrolment} cohorts={cohorts.data ?? []} />

      <Panel className="p-6">
        <h2 className="text-sm font-semibold text-night-100">Admission decision</h2>
        <p className="mt-1 text-[13px] leading-5 text-night-400">
          Every decision records who made it and why. Decisions are made against the version this page loaded, so a colleague
          saving first will be refused rather than overwritten.
        </p>

        {ACTIONS[enrolment.status].length === 0 ? (
          <p className="mt-4 text-[13px] text-night-500">
            A {enrolment.status} enrolment has no further staff decision. The student applies again to re-enter the programme.
          </p>
        ) : (
          <div className="mt-4 flex flex-wrap gap-2">
            {ACTIONS[enrolment.status].map((candidate) => (
              <Button
                key={candidate}
                variant={candidate === 'suspend' ? 'ember' : candidate === 'reject' ? 'danger' : 'outline'}
                size="sm"
                aria-pressed={action === candidate}
                onClick={() => {
                  setAction(action === candidate ? null : candidate);
                  decide.reset();
                }}
              >
                {ACTION_COPY[candidate].label}
              </Button>
            ))}
          </div>
        )}

        {action && (
          <div className="mt-4">
            <ReasonForm
              key={action}
              title={ACTION_COPY[action].title}
              description={ACTION_COPY[action].description}
              submitLabel={ACTION_COPY[action].label}
              pending={decide.isPending}
              showCohort={ACTION_COPY[action].needsCohort}
              cohorts={cohorts.data ?? []}
              onCancel={() => {
                setAction(null);
                decide.reset();
              }}
              onSubmit={({ reason, cohortId }) => {
                decide.reset();
                decide.mutate({
                  enrolmentId: enrolment.id,
                  action,
                  reason,
                  cohortId,
                  expectedVersion: enrolment.version,
                });
              }}
            />
            {decide.isPending && <WorkingLabel label="Recording decision…" className="mt-3" />}
          </div>
        )}

        {cohorts.isError && (
          <div className="mt-4">
            <ErrorPanel error={cohorts.error} onRetry={() => void cohorts.refetch()} retryLabel="Reload cohorts" />
          </div>
        )}
      </Panel>

      <ProfilePanel row={row} editing={editing} onEdit={startEditing}>
        {editing && (
          <ReasonForm
            title="Update this profile"
            description="Names and account status are recorded in the audit trail. Suspending an account revokes every session for that student."
            submitLabel="Save profile"
            pending={profile.isPending}
            extraFields={
              <div className="grid gap-3.5 sm:grid-cols-2">
                <div>
                  <Label htmlFor="legal-name">Legal name</Label>
                  <Input
                    id="legal-name"
                    value={form.legalName}
                    maxLength={200}
                    onChange={(event) => setForm({ ...form, legalName: event.target.value })}
                    required
                  />
                </div>
                <div>
                  <Label htmlFor="preferred-name">Preferred name</Label>
                  <Input
                    id="preferred-name"
                    value={form.preferredName}
                    maxLength={120}
                    placeholder="Leave blank to clear"
                    onChange={(event) => setForm({ ...form, preferredName: event.target.value })}
                  />
                </div>
                <div className="sm:col-span-2">
                  <Label htmlFor="account-status">Account status</Label>
                  <Select
                    id="account-status"
                    value={form.status}
                    onChange={(event) => setForm({ ...form, status: event.target.value as 'active' | 'suspended' })}
                  >
                    <option value="active">Active</option>
                    <option value="suspended">Suspended</option>
                  </Select>
                </div>
              </div>
            }
            onCancel={() => {
              setEditing(false);
              profile.reset();
            }}
            onSubmit={({ reason }) => {
              profile.reset();
              profile.mutate({
                reason,
                expectedVersion: row.version,
                legalName: form.legalName.trim(),
                preferredName: form.preferredName.trim() === '' ? null : form.preferredName.trim(),
                status: form.status,
              });
            }}
          />
        )}
        {profile.isError && <ErrorPanel error={profile.error} onRetry={() => profile.reset()} retryLabel="Dismiss" />}
      </ProfilePanel>

      <Panel className="p-6">
        <h2 className="text-sm font-semibold text-night-100">Account recovery</h2>
        <p className="mt-1 text-[13px] leading-5 text-night-400">
          Sends a password reset link to the student's own mailbox. The link is never visible to university staff.
        </p>
        <div className="mt-4 flex flex-wrap items-center gap-3">
          <Button
            variant="outline"
            size="sm"
            loading={recover.isPending}
            disabled={recover.isPending || recovery === 'sent' || !row.email}
            onClick={() => {
              setRecovery('sending');
              recover.reset();
              recover.mutate();
            }}
          >
            <KeyRound aria-hidden />
            {recovery === 'sent' ? 'Recovery email requested' : 'Send recovery email'}
          </Button>
          {recovery === 'sent' && !row.emailVerified && (
            <span className="inline-flex items-center gap-1.5 text-[12.5px] text-aurora-300">
              <Check className="size-3.5" aria-hidden />
              Accepted for delivery
            </span>
          )}
          {!row.email && <span className="text-[12.5px] text-night-500">This profile has no account on file.</span>}
        </div>
        {recover.isError && (
          <div className="mt-3">
            <ErrorPanel error={recover.error} />
          </div>
        )}
      </Panel>
    </div>
  );
}

function ProfilePanel({
  row,
  editing,
  onEdit,
  children,
}: {
  row: AdminStudentRow;
  editing?: boolean;
  onEdit?: () => void;
  children?: ReactNode;
}) {
  return (
    <Panel className="p-6">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h2 className="text-sm font-semibold text-night-100">Profile</h2>
          <p className="mt-1 text-[13px] text-night-400">Legal name, preferred name and account status.</p>
        </div>
        {onEdit && !editing && (
          <Button variant="ghost" size="sm" onClick={onEdit}>
            Maintain profile
          </Button>
        )}
      </div>

      <dl className="mt-4 grid gap-5 sm:grid-cols-2 lg:grid-cols-3">
        <Fact label="Legal name">{row.legalName}</Fact>
        <Fact label="Preferred name">{row.preferredName ?? 'None'}</Fact>
        <Fact label="Account">{row.status}</Fact>
        <Fact label="Account subject">
          <span className="font-mono text-[12.5px]">{row.accountUserId ?? 'unlinked'}</span>
        </Fact>
        <Fact label="Registered">{formatTimestamp(row.createdAt)}</Fact>
        {/* `version` is the optimistic-lock token `PATCH /students/:id` compares against. */}
        <Fact label="Profile version">{row.version}</Fact>
      </dl>

      {children && <div className="mt-4 space-y-3">{children}</div>}
    </Panel>
  );
}

function BackLink() {
  return (
    <a href="#/students" className="inline-flex items-center gap-1.5 text-[13px] text-night-400 hover:text-night-100">
      <ArrowLeft className="size-3.5" aria-hidden />
      All students
    </a>
  );
}

/** The cohort's published name, falling back to the id rather than to a guess. */
function cohortName(cohortId: string | null, cohorts: Cohort[]): string {
  if (!cohortId) return 'None assigned';
  return cohorts.find((cohort) => cohort.id === cohortId)?.name ?? cohortId;
}

/**
 * Where this student sits academically, read from the enrolment record this view already
 * holds plus the published cohort list. No new endpoint: the programme's full row structure
 * is not loaded here, and this panel does not imply that it is.
 */
function AcademicPlacement({ enrolment, cohorts }: { enrolment: Enrolment; cohorts: Cohort[] }) {
  return (
    <Panel className="p-6">
      <h2 className="text-sm font-semibold text-night-100">Academic placement</h2>
      <p className="mt-1 text-[13px] leading-5 text-night-400">
        The programme, cohort and curriculum version this enrolment is held against. The cohort decides which course
        packages the student may download.
      </p>

      <dl className="mt-4 grid gap-5 sm:grid-cols-2 lg:grid-cols-3">
        <Fact label="Programme">
          <span className="font-mono text-[12.5px]">{enrolment.programmeId}</span>
        </Fact>
        <Fact label="Cohort">
          {enrolment.cohortId ? (
            <>
              {cohortName(enrolment.cohortId, cohorts)}
              <span className="mt-0.5 block font-mono text-[12px] text-night-500">{enrolment.cohortId}</span>
            </>
          ) : (
            'None assigned'
          )}
        </Fact>
        <Fact label="Curriculum version">
          <span className="font-mono text-[12.5px]">{enrolment.curriculumVersion}</span>
        </Fact>
        <Fact label="Enrolment id">
          <span className="font-mono text-[12.5px]">{enrolment.id}</span>
        </Fact>
        <Fact label="Student id">
          <span className="font-mono text-[12.5px]">{enrolment.studentId}</span>
        </Fact>
        <Fact label="Applied">
          {formatTimestamp(enrolment.requestedAt)} · last change {formatTimestamp(enrolment.updatedAt)}
        </Fact>
      </dl>

      <p className="mt-4 border-t border-white/[0.06] pt-4 text-[12.5px] leading-5 text-night-500">
        This page shows the student's placement, not the programme's course rows. Listing a course in the programme does
        not release it to this student — the cohort and the release plan do that separately.
      </p>
    </Panel>
  );
}