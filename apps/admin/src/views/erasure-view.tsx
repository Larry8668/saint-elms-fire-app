import { useState } from 'react';
import { Archive, ShieldAlert } from 'lucide-react';
import type { ErasureRequest } from '@sef/shared';
import { confirmErasure } from '@/api/admin-api';
import { keys, useErasureRequests } from '@/api/queries';
import { useStaffMutation } from '@/api/use-staff-mutation';
import { ErrorPanel } from '@/components/error-panel';
import { ReasonForm } from '@/components/reason-form';
import { Badge, EmptyState, PageHeader, Panel } from '@/components/ui/primitives';
import { Button } from '@/components/ui/button';
import { RowListSkeleton } from '@/components/ui/skeletons';
import { formatTimestamp } from '@/lib/format';
import { useSession } from '@/state/session-context';

/**
 * Erasure deletes a student profile and its account. The university gates it to owners with a
 * fresh session, so this screen is deliberately slow to act on: the person has to select the
 * request, read the consequence and type the profile id before anything is sent.
 */
export function ErasureView() {
  const { isOwner } = useSession();
  const requests = useErasureRequests();
  const [target, setTarget] = useState<ErasureRequest | null>(null);

  const confirm = useStaffMutation(
    ({ requestId }: { requestId: string }) => confirmErasure(requestId),
    { invalidate: [keys.erasures, ['students'], ['audit']], onSuccess: () => setTarget(null) },
  );

  const rows = requests.data ?? [];
  const pending = rows.filter((row) => row.status === 'pending');

  return (
    <div className="space-y-5">
      <PageHeader
        eyebrow="Registrar"
        title="Erasure requests"
        description="Requests a student has made to have their record deleted. Confirming one is irreversible: the profile, its account and its sessions are destroyed."
      />

      {!isOwner && (
        <p className="rounded-xl border border-white/[0.07] bg-white/[0.03] p-3 text-[12.5px] leading-5 text-night-400">
          Only a university owner can confirm an erasure. You can review what is waiting.
        </p>
      )}

      {requests.isError && <ErrorPanel error={requests.error} onRetry={() => void requests.refetch()} />}

      {confirm.isError && (
        <ErrorPanel error={confirm.error} onRetry={() => void requests.refetch()} retryLabel="Reload requests">
          <p className="mt-2 text-[12.5px] text-night-400">
            The erasure has not been carried out. Reload to see the current state before trying again.
          </p>
        </ErrorPanel>
      )}

      {requests.isPending ? (
        <RowListSkeleton rows={3} />
      ) : rows.length === 0 ? (
        <Panel>
          <EmptyState icon={<Archive />} title="No erasure requests" body="No student has asked to have their record deleted." />
        </Panel>
      ) : (
        <ul className="space-y-2.5" aria-label="Erasure requests">
          {rows.map((row) => (
            <li key={row.id}>
              <Panel className="flex flex-col gap-3 p-4 sm:flex-row sm:items-center">
                <div className="min-w-0 flex-1">
                  <p className="truncate font-mono text-[13px] text-night-100">{row.studentProfileId}</p>
                  <p className="mt-0.5 text-[12px] text-night-500">
                    Requested {formatTimestamp(row.requestedAt)}
                    {row.confirmedAt ? ` · confirmed ${formatTimestamp(row.confirmedAt)}` : ''}
                  </p>
                </div>
                <div className="flex flex-wrap items-center gap-2">
                  <Badge tone={row.status === 'pending' ? 'rose' : 'neutral'}>{row.status}</Badge>
                  {row.status === 'pending' && isOwner && (
                    <Button
                      variant="danger"
                      size="sm"
                      aria-pressed={target?.id === row.id}
                      onClick={() => {
                        setTarget(target?.id === row.id ? null : row);
                        confirm.reset();
                      }}
                    >
                      Review erasure
                    </Button>
                  )}
                </div>
              </Panel>

              {target?.id === row.id && (
                <div className="mt-2">
                  <ReasonForm
                    title="Confirm erasure of this student"
                    description={
                      <>
                        <span className="flex items-start gap-2 text-rose-300">
                          <ShieldAlert className="mt-0.5 size-3.5 shrink-0" aria-hidden />
                          This cannot be undone. The profile <span className="font-mono">{row.studentProfileId}</span>, its account
                          and every session it holds will be destroyed, along with its enrolments and audit links.
                        </span>
                      </>
                    }
                    submitLabel="Erase this student"
                    pending={confirm.isPending}
                    destructive
                    requireReason={false}
                    confirmationPhrase={row.studentProfileId}
                    onCancel={() => {
                      setTarget(null);
                      confirm.reset();
                    }}
                    onSubmit={() => {
                      confirm.reset();
                      confirm.mutate({ requestId: row.id });
                    }}
                  />
                  {confirm.isPending && <p className="mt-2 text-[12.5px] text-rose-300">Erasing…</p>}
                </div>
              )}
            </li>
          ))}
        </ul>
      )}

      {pending.length > 0 && (
        <p className="text-[12.5px] text-night-500">
          {pending.length} request{pending.length === 1 ? '' : 's'} waiting. Erasures are recorded in the audit history.
        </p>
      )}
    </div>
  );
}