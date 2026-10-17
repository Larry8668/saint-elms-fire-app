import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Laptop, Trash2 } from 'lucide-react';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';
import { Badge, Eyebrow, Panel, Skeleton } from '@/components/ui/primitives';
import { api, EngineError } from '@/lib/api';
import { timeAgo } from '@/lib/time';

/** "Signed-in devices": this workspace engine's own sign-ins (PR-37b), each revocable but the current one. */
export function DevicesCard() {
  const queryClient = useQueryClient();
  const sessions = useQuery({ queryKey: ['auth-sessions'], queryFn: api.authSessions });
  const revoke = useMutation({
    mutationFn: api.revokeAuthSession,
    onSuccess: () => {
      toast.success('Signed that device out');
      void queryClient.invalidateQueries({ queryKey: ['auth-sessions'] });
    },
    onError: (error) => toast.error(error instanceof EngineError ? error.message : 'Could not sign that device out.'),
  });

  return (
    <Panel className="p-6">
      <Eyebrow className="mb-3">Signed-in devices</Eyebrow>
      {sessions.isPending ? (
        <div aria-busy className="space-y-2">
          <Skeleton className="h-10 w-full rounded-xl" />
          <Skeleton className="h-10 w-full rounded-xl" />
        </div>
      ) : sessions.isError ? (
        <p role="alert" className="text-[13px] text-rose-400">
          {sessions.error instanceof EngineError ? sessions.error.message : 'Could not load your devices.'}
        </p>
      ) : (
        <ul className="space-y-2">
          {sessions.data.sessions.map((s) => (
            <li key={s.id} className="flex items-center gap-3 rounded-xl border border-white/[0.06] bg-white/[0.02] px-3 py-2">
              <Laptop className="size-4 shrink-0 text-night-400" />
              <span className="min-w-0 flex-1">
                <span className="block truncate text-[13px] text-night-100">{s.deviceLabel || 'Unnamed device'}</span>
                <span className="block text-[11.5px] text-night-500">
                  {s.lastSeenAt ? `Active ${timeAgo(s.lastSeenAt)}` : s.createdAt ? `Signed in ${timeAgo(s.createdAt)}` : 'Signed in'}
                  {s.mode === 'offline' ? ' · offline sign-in' : ''}
                </span>
              </span>
              {s.current ? (
                <Badge tone="beacon">This device</Badge>
              ) : (
                <Button variant="ghost" size="sm" loading={revoke.isPending && revoke.variables === s.id} onClick={() => revoke.mutate(s.id)} aria-label={`Sign out ${s.deviceLabel}`}>
                  <Trash2 /> Sign out
                </Button>
              )}
            </li>
          ))}
        </ul>
      )}
    </Panel>
  );
}
