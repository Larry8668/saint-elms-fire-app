import { useState } from 'react';
import { ShieldCheck, UserPlus } from 'lucide-react';
import type { StaffMembership, StaffRole } from '@sef/shared';
import { inviteStaff, updateStaff } from '@/api/admin-api';
import { keys, useStaffList } from '@/api/queries';
import { useStaffMutation } from '@/api/use-staff-mutation';
import { ErrorPanel } from '@/components/error-panel';
import { ReasonForm } from '@/components/reason-form';
import { Badge, EmptyState, Input, Label, PageHeader, Panel, Select } from '@/components/ui/primitives';
import { Button } from '@/components/ui/button';
import { RowListSkeleton } from '@/components/ui/skeletons';
import { formatTimestamp } from '@/lib/format';
import { useSession } from '@/state/session-context';

const ROLES: StaffRole[] = ['registrar', 'lecturer', 'support', 'owner'];
const STATUS_TONE = { active: 'aurora', suspended: 'ember', ended: 'neutral' } as const;

export function StaffView() {
  const { isOwner } = useSession();
  const staff = useStaffList();
  const [inviting, setInviting] = useState(false);
  const [editing, setEditing] = useState<StaffMembership | null>(null);
  const [inviteForm, setInviteForm] = useState<{ email: string; role: StaffRole }>({ email: '', role: 'registrar' });
  const [nextStatus, setNextStatus] = useState<StaffMembership['status']>('suspended');

  const invite = useStaffMutation(
    ({ email, role }: { email: string; role: StaffRole }) => inviteStaff({ email, role }),
    { invalidate: [keys.staff], onSuccess: () => setInviting(false) },
  );

  const change = useStaffMutation(
    ({ id, status, reason }: { id: string; status: StaffMembership['status']; reason: string }) =>
      updateStaff(id, { status, reason }),
    { invalidate: [keys.staff], onSuccess: () => setEditing(null) },
  );

  const activeOwners = (staff.data ?? []).filter((row) => row.role === 'owner' && row.status === 'active').length;

  return (
    <div className="space-y-5">
      <PageHeader
        eyebrow="Registrar"
        title="Staff"
        description="University staff who can read student records. Roles and status are set by the university server; the university refuses any change it does not permit."
        actions={
          isOwner ? (
            <Button variant="primary" size="sm" onClick={() => setInviting((open) => !open)} aria-expanded={inviting}>
              <UserPlus aria-hidden />
              Invite staff
            </Button>
          ) : undefined
        }
      />

      {!isOwner && (
        <p className="rounded-xl border border-white/[0.07] bg-white/[0.03] p-3 text-[12.5px] leading-5 text-night-400">
          You can see who holds staff access. Inviting staff and changing a role are owner-only actions.
        </p>
      )}

      {inviting && isOwner && (
        <ReasonForm
          key="invite"
          title="Invite a staff member"
          description="The person must already hold a verified university account. This grants staff access; it does not create an account."
          submitLabel="Invite"
          pending={invite.isPending}
          requireReason={false}
          extraFields={
            <div className="grid gap-3.5 sm:grid-cols-2">
              <div>
                <Label htmlFor="invite-email">Email</Label>
                <Input
                  id="invite-email"
                  type="email"
                  value={inviteForm.email}
                  placeholder="registrar@st-elms.edu"
                  onChange={(event) => setInviteForm({ ...inviteForm, email: event.target.value })}
                  required
                />
              </div>
              <div>
                <Label htmlFor="invite-role">Role</Label>
                <Select
                  id="invite-role"
                  value={inviteForm.role}
                  onChange={(event) => setInviteForm({ ...inviteForm, role: event.target.value as StaffRole })}
                >
                  {ROLES.map((role) => (
                    <option key={role} value={role}>
                      {role}
                    </option>
                  ))}
                </Select>
              </div>
            </div>
          }
          onCancel={() => {
            setInviting(false);
            invite.reset();
          }}
          onSubmit={() => {
            invite.reset();
            invite.mutate({ email: inviteForm.email.trim(), role: inviteForm.role });
          }}
        />
      )}

      {invite.isError && <ErrorPanel error={invite.error} onRetry={() => invite.reset()} retryLabel="Dismiss" />}

      {staff.isError && <ErrorPanel error={staff.error} onRetry={() => void staff.refetch()} />}

      {staff.isPending ? (
        <RowListSkeleton rows={4} />
      ) : (staff.data ?? []).length === 0 ? (
        <Panel>
          <EmptyState
            icon={<ShieldCheck />}
            title="No staff memberships"
            body="Nobody holds staff access on this server. An owner has to run the staff:grant command before anyone can sign in here."
          />
        </Panel>
      ) : (
        <ul className="space-y-2.5" aria-label="Staff memberships">
          {(staff.data ?? []).map((row) => (
            <li key={row.id}>
              <Panel className="flex flex-col gap-3 p-4 sm:flex-row sm:items-center">
                <div className="min-w-0 flex-1">
                  <p className="truncate text-[15px] font-medium text-night-100">{row.displayName}</p>
                  <p className="mt-0.5 text-[12px] text-night-500">
                    Member since {formatTimestamp(row.createdAt)} ·{' '}
                    <span className="font-mono">{row.subject}</span>
                  </p>
                </div>
                <div className="flex flex-wrap items-center gap-2">
                  <Badge tone={row.role === 'owner' ? 'gold' : 'beacon'}>{row.role}</Badge>
                  <Badge tone={STATUS_TONE[row.status]}>{row.status}</Badge>
                  <Button variant="ghost" size="sm" onClick={() => {
                    setEditing(row);
                    setNextStatus(row.status === 'active' ? 'suspended' : 'active');
                  }}>
                    Change status
                  </Button>
                </div>
              </Panel>
            </li>
          ))}
        </ul>
      )}

      {change.isError && editing && (
        <ErrorPanel error={change.error} onRetry={() => change.reset()} retryLabel="Dismiss" />
      )}

      {editing && (
        <ReasonForm
          key={editing.id}
          title={`Change status for ${editing.displayName}`}
          description={`${editing.role} · currently ${editing.status}. Ending a membership removes the person's access to student records and revokes their sessions.`}
          submitLabel="Apply change"
          pending={change.isPending}
          destructive={nextStatus === 'ended'}
          confirmationPhrase={editing.role === 'owner' && activeOwners <= 1 ? editing.subject : undefined}
          extraFields={
            <div>
              <Label htmlFor="staff-status">New status</Label>
              <Select id="staff-status" value={nextStatus} onChange={(event) => setNextStatus(event.target.value as StaffMembership['status'])}>
                <option value="active">Active</option>
                <option value="suspended">Suspended</option>
                <option value="ended">Ended</option>
              </Select>
            </div>
          }
          onCancel={() => {
            setEditing(null);
            change.reset();
          }}
          onSubmit={({ reason }) => {
            change.reset();
            change.mutate({ id: editing.id, status: nextStatus, reason });
          }}
        />
      )}
    </div>
  );
}