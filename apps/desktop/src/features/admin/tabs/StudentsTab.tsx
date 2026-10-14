import type { Account, CohortSummary } from '@sef/shared';
import { KeyRound, Plus, UserCheck, UserX } from 'lucide-react';
import { useMemo, useState, type FormEvent } from 'react';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';
import { Dialog } from '@/components/ui/overlays';
import { Badge, Input, Label, Panel, Select } from '@/components/ui/primitives';
import { ProfileAvatar } from '@/features/auth/ProfileAvatar';
import { timeAgo } from '@/lib/time';
import type { DispersalRow } from '../admin-api';
import { useAccounts, useCohorts, useCreateAccount, useDispersal, useUpdateAccount } from '../admin-queries';
import { QueryState, TabHeader, TableSkeleton } from '../ui';

interface SyncSummary {
  last?: string;
  courses: number;
  outdated: number;
}

function summarise(rows: DispersalRow[] | undefined): Map<string, SyncSummary> {
  const map = new Map<string, SyncSummary>();
  for (const r of rows ?? []) {
    const s = map.get(r.accountId) ?? { courses: 0, outdated: 0 };
    s.courses += 1;
    if (!r.current) s.outdated += 1;
    if (!s.last || r.at > s.last) s.last = r.at;
    map.set(r.accountId, s);
  }
  return map;
}

export function StudentsTab() {
  const accounts = useAccounts();
  const cohorts = useCohorts();
  const dispersal = useDispersal();
  const update = useUpdateAccount();
  const [creating, setCreating] = useState(false);
  const [resetting, setResetting] = useState<Account | null>(null);
  const sync = useMemo(() => summarise(dispersal.data), [dispersal.data]);

  return (
    <>
      <TabHeader
        title="Students"
        description="Accounts that can sign in. Moving a student to another cohort changes what their device can download at its next sync. Disabled accounts cannot sign in online."
        actions={
          <Button variant="primary" onClick={() => setCreating(true)}>
            <Plus /> Add student
          </Button>
        }
      />
      <Panel className="overflow-hidden">
        <QueryState query={accounts} skeleton={<TableSkeleton rows={5} cols={5} />}>
          {(rows) => (
            <table className="w-full text-left text-[13.5px]">
              <thead className="border-b border-white/[0.06] text-[11.5px] tracking-wide text-night-500 uppercase">
                <tr>
                  <th className="px-5 py-3 font-medium">Student</th>
                  <th className="px-3 py-3 font-medium">Cohort</th>
                  <th className="px-3 py-3 font-medium">Last sync</th>
                  <th className="px-3 py-3 font-medium">Status</th>
                  <th className="px-5 py-3" />
                </tr>
              </thead>
              <tbody className="divide-y divide-white/[0.04]">
                {rows.map((a) => {
                  const s = sync.get(a.id);
                  return (
                    <tr key={a.id} className={a.disabled ? 'opacity-55' : undefined}>
                      <td className="px-5 py-3">
                        <div className="flex items-center gap-3">
                          <ProfileAvatar id={a.id} name={a.name} size="sm" />
                          <div className="min-w-0">
                            <div className="text-night-100">
                              {a.name} {a.role === 'admin' && <Badge tone="gold">admin</Badge>}
                            </div>
                            <div className="truncate text-[12px] text-night-500">{a.stage ?? a.email}</div>
                          </div>
                        </div>
                      </td>
                      <td className="px-3 py-3">
                        {a.role === 'student' ? (
                          <Select
                            aria-label={`Cohort for ${a.name}`}
                            className="h-8 w-48 text-[12.5px]"
                            value={a.cohortId ?? ''}
                            onChange={(e) => update.mutate({ id: a.id, patch: { cohortId: e.target.value } })}
                          >
                            {cohorts.data?.map((c) => (
                              <option key={c.id} value={c.id}>
                                {c.name}
                              </option>
                            ))}
                          </Select>
                        ) : (
                          <span className="text-night-500">—</span>
                        )}
                      </td>
                      <td className="px-3 py-3 text-night-300">
                        {s?.last ? (
                          <>
                            {timeAgo(s.last)}
                            <div className="text-[11.5px] text-night-500">
                              {s.courses} courses{s.outdated ? <span className="text-ember-300"> · {s.outdated} outdated</span> : null}
                            </div>
                          </>
                        ) : (
                          <span className="text-night-500">never</span>
                        )}
                      </td>
                      <td className="px-3 py-3">{a.disabled ? <Badge tone="rose">disabled</Badge> : <Badge tone="aurora">active</Badge>}</td>
                      <td className="px-5 py-3">
                        <div className="flex justify-end gap-1">
                          <Button variant="ghost" size="sm" onClick={() => setResetting(a)}>
                            <KeyRound /> Reset
                          </Button>
                          {a.role === 'student' && (
                            <Button variant="ghost" size="sm" onClick={() => update.mutate({ id: a.id, patch: { disabled: !a.disabled } })}>
                              {a.disabled ? <UserCheck /> : <UserX />} {a.disabled ? 'Enable' : 'Disable'}
                            </Button>
                          )}
                        </div>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          )}
        </QueryState>
      </Panel>
      <NewStudentDialog open={creating} onOpenChange={setCreating} cohorts={cohorts.data ?? []} />
      <ResetPasswordDialog account={resetting} onClose={() => setResetting(null)} />
    </>
  );
}

function NewStudentDialog({ open, onOpenChange, cohorts }: { open: boolean; onOpenChange: (v: boolean) => void; cohorts: CohortSummary[] }) {
  const create = useCreateAccount();
  const blank = { name: '', email: '', cohortId: '', stage: '', password: '' };
  const [form, setForm] = useState(blank);
  const set = (k: keyof typeof blank) => (e: { target: { value: string } }) => setForm({ ...form, [k]: e.target.value });

  const cohortId = form.cohortId || cohorts[0]?.id;

  const submit = (e: FormEvent) => {
    e.preventDefault();
    if (!cohortId) return toast.error('Create a cohort first: every student belongs to one.');
    create.mutate(
      { ...form, role: 'student', cohortId, stage: form.stage || undefined },
      {
        onSuccess: () => {
          setForm(blank);
          onOpenChange(false);
        },
      },
    );
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange} title="Add student" description="They can sign in on any device right away, then keep studying offline.">
      <form onSubmit={submit} className="grid gap-4 md:grid-cols-2">
        <div>
          <Label htmlFor="s-name">Name</Label>
          <Input id="s-name" value={form.name} onChange={set('name')} required />
        </div>
        <div>
          <Label htmlFor="s-email">Email</Label>
          <Input id="s-email" type="email" value={form.email} onChange={set('email')} required />
        </div>
        <div>
          <Label htmlFor="s-cohort">Cohort</Label>
          <Select id="s-cohort" value={form.cohortId} onChange={set('cohortId')}>
            {cohorts.map((c) => (
              <option key={c.id} value={c.id}>
                {c.name}
              </option>
            ))}
          </Select>
        </div>
        <div>
          <Label htmlFor="s-stage">Stage (optional)</Label>
          <Input id="s-stage" value={form.stage} onChange={set('stage')} placeholder="Semester 1, week 1" />
        </div>
        <div className="md:col-span-2">
          <Label htmlFor="s-password">Initial password</Label>
          <Input id="s-password" type="password" autoComplete="new-password" minLength={8} value={form.password} onChange={set('password')} required />
        </div>
        <div className="flex justify-end gap-2 md:col-span-2">
          <Button type="button" variant="ghost" onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button type="submit" variant="primary" loading={create.isPending}>
            Create account
          </Button>
        </div>
      </form>
    </Dialog>
  );
}

function ResetPasswordDialog({ account, onClose }: { account: Account | null; onClose: () => void }) {
  const update = useUpdateAccount();
  const [password, setPassword] = useState('');
  const submit = (e: FormEvent) => {
    e.preventDefault();
    if (!account) return;
    update.mutate(
      { id: account.id, patch: { password } },
      {
        onSuccess: () => {
          setPassword('');
          onClose();
        },
      },
    );
  };
  return (
    <Dialog
      open={Boolean(account)}
      onOpenChange={(v) => !v && onClose()}
      title={`Reset password${account ? ` for ${account.name}` : ''}`}
      description="Devices that already know the old password keep working offline until their next online sign-in."
    >
      <form onSubmit={submit} className="space-y-4">
        <div>
          <Label htmlFor="new-password">New password</Label>
          <Input id="new-password" type="password" autoComplete="new-password" minLength={8} value={password} onChange={(e) => setPassword(e.target.value)} required autoFocus />
        </div>
        <div className="flex justify-end gap-2">
          <Button type="button" variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button type="submit" variant="primary" loading={update.isPending}>
            Reset password
          </Button>
        </div>
      </form>
    </Dialog>
  );
}
