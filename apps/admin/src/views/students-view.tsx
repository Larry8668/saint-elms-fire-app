import { useEffect, useMemo, useState } from 'react';
import { Search, Users } from 'lucide-react';
import type { EnrolmentStatus } from '@sef/shared';
import { useCohorts, useStudents } from '@/api/queries';
import { ErrorPanel } from '@/components/error-panel';
import { Badge, EmptyState, Input, Label, PageHeader, Panel, Select } from '@/components/ui/primitives';
import { StudentTableSkeleton } from '@/components/ui/skeletons';
import { displayName, formatTimestamp } from '@/lib/format';
import { linkTo, type Route } from '@/state/use-hash-route';

const PAGE_SIZE = 25;

/** Enrolment states the university records; also the only `status` filter the server accepts. */
const STATUSES: { value: EnrolmentStatus; label: string }[] = [
  { value: 'pending', label: 'Pending' },
  { value: 'approved', label: 'Approved' },
  { value: 'rejected', label: 'Rejected' },
  { value: 'suspended', label: 'Suspended' },
  { value: 'withdrawn', label: 'Withdrawn' },
];

const STATUS_TONE = {
  pending: 'ember',
  approved: 'aurora',
  rejected: 'rose',
  suspended: 'rose',
  withdrawn: 'neutral',
} as const;

export function StudentsView({ route }: { route: Route }) {
  const search = route.params.get('search') ?? '';
  const status = route.params.get('status') ?? '';
  const cohort = route.params.get('cohort') ?? '';
  const page = Math.max(1, Number(route.params.get('page')) || 1);

  // The typed value leads; the URL follows once typing settles, so each keystroke is not a request.
  // Dependencies are the two strings, not `route.params`: a new params object is built on every
  // render, which would restart the timer forever and the search would never commit.
  const [draft, setDraft] = useState(search);
  useEffect(() => setDraft(search), [search]);
  useEffect(() => {
    if (draft === search) return;
    const id = window.setTimeout(() => {
      window.location.hash = linkTo('students', { search: draft, page: undefined }, route.params);
    }, 250);
    return () => window.clearTimeout(id);
  }, [draft, search]);

  const query = useMemo(
    () => ({ page, pageSize: PAGE_SIZE, search: search || undefined, status: status || undefined, cohort: cohort || undefined }),
    [page, search, status, cohort],
  );
  const students = useStudents(query);
  const cohorts = useCohorts();

  const rows = students.data?.rows ?? [];
  const total = students.data?.total ?? 0;
  const lastPage = Math.max(1, Math.ceil(total / PAGE_SIZE));

  return (
    <div className="space-y-5">
      <PageHeader
        eyebrow="Registrar"
        title="Students"
        description="Every applicant and enrolled student, with their admission state and cohort. Search by name or email address."
      />

      <Panel className="grid gap-3 p-4 sm:grid-cols-2 lg:grid-cols-4">
        <div className="sm:col-span-2 lg:col-span-1">
          <Label htmlFor="student-search">Search</Label>
          <div className="relative">
            <Search className="pointer-events-none absolute top-1/2 left-3 size-3.5 -translate-y-1/2 text-night-500" aria-hidden />
            <Input
              id="student-search"
              value={draft}
              onChange={(event) => setDraft(event.target.value)}
              placeholder="Name or email"
              className="pl-8"
            />
          </div>
        </div>
        <div>
          <Label htmlFor="student-status">Enrolment state</Label>
          <Select
            id="student-status"
            value={status}
            onChange={(event) => {
              window.location.hash = linkTo('students', { status: event.target.value, page: undefined }, route.params);
            }}
          >
            <option value="">All states</option>
            {STATUSES.map((entry) => (
              <option key={entry.value} value={entry.value}>
                {entry.label}
              </option>
            ))}
          </Select>
        </div>
        <div>
          <Label htmlFor="student-cohort">Cohort</Label>
          <Select
            id="student-cohort"
            value={cohort}
            onChange={(event) => {
              window.location.hash = linkTo('students', { cohort: event.target.value, page: undefined }, route.params);
            }}
            disabled={cohorts.isPending}
          >
            <option value="">All cohorts</option>
            {(cohorts.data ?? []).map((entry) => (
              <option key={entry.id} value={entry.id}>
                {entry.name}
              </option>
            ))}
          </Select>
        </div>
      </Panel>

      {students.isError && <ErrorPanel error={students.error} onRetry={() => void students.refetch()} />}

      {students.isPending ? (
        <StudentTableSkeleton />
      ) : rows.length === 0 ? (
        <Panel>
          <EmptyState
            icon={<Users />}
            title="No students match"
            body="No record matches this search and filter combination. Clear the filters, or check the spelling."
            action={
              <a href="#/students" className="text-[13px] text-beacon-300 underline underline-offset-2 hover:text-beacon-200">
                Clear all filters
              </a>
            }
          />
        </Panel>
      ) : (
        <>
          <ul className="space-y-2.5" aria-label="Students">
            {rows.map((row) => (
              <li key={row.profileId}>
                <a
                  href={`#/students/${row.profileId}`}
                  className="flex flex-col gap-3 rounded-2xl border border-white/[0.07] bg-night-900/60 p-4 transition-colors hover:border-beacon-400/40 hover:bg-night-900/80 sm:flex-row sm:items-center"
                >
                  <div className="min-w-0 flex-1">
                    <p className="truncate text-[15px] font-medium text-night-100">{displayName(row.legalName, row.preferredName)}</p>
                    <p className="mt-0.5 truncate text-[13px] text-night-400">
                      {row.email ?? 'No account on file'}
                      {row.email ? (row.emailVerified ? ' · verified' : ' · unverified') : ''}
                    </p>
                    <p className="mt-0.5 text-[12px] text-night-500">Registered {formatTimestamp(row.createdAt)}</p>
                  </div>
                  <div className="flex flex-wrap items-center gap-2">
                    {row.enrolment ? <Badge tone={STATUS_TONE[row.enrolment.status]}>{row.enrolment.status}</Badge> : <Badge>no enrolment</Badge>}
                    {row.enrolment?.cohortId && <Badge tone="beacon">{row.enrolment.cohortId}</Badge>}
                    {row.status === 'suspended' && <Badge tone="rose">account suspended</Badge>}
                  </div>
                </a>
              </li>
            ))}
          </ul>

          <nav aria-label="Pagination" className="flex items-center justify-between gap-3 pt-1">
            <p className="text-[12.5px] text-night-500" aria-live="polite">
              Page {students.data?.page ?? page} of {lastPage} · {total} student{total === 1 ? '' : 's'}
            </p>
            <div className="flex gap-2">
              {page > 1 && (
                <a
                  href={linkTo('students', { page: page - 1 }, route.params)}
                  className="rounded-xl border border-white/10 px-3.5 py-2 text-[13px] text-night-200 hover:border-beacon-400/40 hover:text-night-100"
                >
                  Previous
                </a>
              )}
              {page < lastPage && (
                <a
                  href={linkTo('students', { page: page + 1 }, route.params)}
                  className="rounded-xl border border-white/10 px-3.5 py-2 text-[13px] text-night-200 hover:border-beacon-400/40 hover:text-night-100"
                >
                  Next
                </a>
              )}
            </div>
          </nav>
        </>
      )}
    </div>
  );
}