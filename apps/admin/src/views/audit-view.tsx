import { useState } from 'react';
import { ScrollText } from 'lucide-react';
import { useAuditEvents } from '@/api/queries';
import { ErrorPanel } from '@/components/error-panel';
import { EmptyState, PageHeader, Panel, Select } from '@/components/ui/primitives';
import { Button } from '@/components/ui/button';
import { RowListSkeleton } from '@/components/ui/skeletons';
import { formatRelative, formatTimestamp } from '@/lib/format';

const LIMITS = [25, 50, 100, 250];

/**
 * The university's own record of who changed what. Events are written inside the same
 * transaction as the change, so this view is the evidence trail behind every decision made
 * through this app.
 */
export function AuditView() {
  const [limit, setLimit] = useState(100);
  const events = useAuditEvents(limit);
  const rows = events.data ?? [];

  return (
    <div className="space-y-5">
      <PageHeader
        eyebrow="Registrar"
        title="Audit history"
        description="Every admission decision and record change the university has recorded, most recent first."
        actions={
          <div>
            <label htmlFor="audit-limit" className="sr-only">
              Events to show
            </label>
            <Select id="audit-limit" value={String(limit)} onChange={(event) => setLimit(Number(event.target.value))}>
              {LIMITS.map((value) => (
                <option key={value} value={value}>
                  Last {value}
                </option>
              ))}
            </Select>
          </div>
        }
      />

      {events.isError && <ErrorPanel error={events.error} onRetry={() => void events.refetch()} />}

      {events.isPending ? (
        <RowListSkeleton rows={6} />
      ) : rows.length === 0 ? (
        <Panel>
          <EmptyState icon={<ScrollText />} title="Nothing recorded yet" body="The university records an event whenever a decision or record change is saved." />
        </Panel>
      ) : (
        <ul className="space-y-2.5" aria-label="Audit events">
          {rows.map((row) => (
            <li key={row.id}>
              <Panel className="p-4">
                <div className="flex flex-col gap-1.5 sm:flex-row sm:items-center sm:justify-between">
                  <p className="text-[14px] font-medium text-night-100">{row.event}</p>
                  <p className="text-[12px] text-night-500">
                    <time dateTime={row.at} title={formatTimestamp(row.at)}>
                      {formatRelative(row.at)}
                    </time>
                  </p>
                </div>
                <p className="mt-1 text-[12.5px] text-night-400">
                  {row.subjectType} <span className="font-mono">{row.subjectId}</span> · by{' '}
                  <span className="font-mono">{row.actor}</span>
                </p>
                {Object.keys(row.details).length > 0 && (
                  <dl className="mt-2.5 flex flex-wrap gap-1.5">
                    {Object.entries(row.details).map(([key, value]) => (
                      <div key={key} className="rounded-lg border border-white/[0.07] bg-black/25 px-2 py-1 text-[12px]">
                        <dt className="text-night-500">{key}</dt>
                        <dd className="text-night-200">{typeof value === 'string' ? value : JSON.stringify(value)}</dd>
                      </div>
                    ))}
                  </dl>
                )}
              </Panel>
            </li>
          ))}
        </ul>
      )}

      <p className="text-[12.5px] text-night-500">
        {events.isPending ? 'Loading events…' : `Showing ${rows.length} event${rows.length === 1 ? '' : 's'}.`}
        {events.isFetching && !events.isPending && ' Refreshing…'}
      </p>
      <Button variant="ghost" size="sm" onClick={() => void events.refetch()}>
        Refresh
      </Button>
    </div>
  );
}