import { TEACHERS, type SessionSummary, type TeacherId } from '@sef/shared';
import { History, MessageSquarePlus, Trash2, X } from 'lucide-react';
import { useState } from 'react';
import { Button } from '@/components/ui/button';
import { Sheet, SheetClose, Tooltip } from '@/components/ui/overlays';
import { Badge, Skeleton } from '@/components/ui/primitives';
import { cn } from '@/lib/cn';
import { useSessions } from '@/lib/queries';
import { timeAgo } from '@/lib/time';
import { useChat } from './chat-store';
import { TEACHER_LOOK } from './teacher-meta';

function SessionRow({ session, active, onOpen, onDelete }: { session: SessionSummary; active: boolean; onOpen: () => void; onDelete: () => void }) {
  const [confirming, setConfirming] = useState(false);
  return (
    <div
      className={cn(
        'group relative rounded-xl border px-3.5 py-3 transition',
        active ? 'border-beacon-400/30 bg-beacon-500/[0.08]' : 'border-white/[0.05] bg-white/[0.02] hover:border-white/[0.12] hover:bg-white/[0.04]',
      )}
    >
      <button onClick={onOpen} className="block w-full cursor-pointer text-left">
        <p className="line-clamp-2 pr-7 text-[13.5px] leading-5 text-night-100">{session.preview || 'Untitled conversation'}</p>
        <div className="mt-1.5 flex items-center gap-2 text-[11.5px] text-night-500">
          <span>{timeAgo(session.updatedAt)}</span>
          <span>·</span>
          <span>{Math.ceil(session.turns / 2)} exchange{session.turns > 2 ? 's' : ''}</span>
          {session.pending > 0 && <Badge tone="gold" className="ml-auto py-0 text-[10.5px]">not reflected</Badge>}
        </div>
      </button>
      <div className="absolute top-2.5 right-2.5">
        {confirming ? (
          <span className="flex items-center gap-1 rounded-lg bg-night-900 p-0.5 shadow-lg">
            <button onClick={onDelete} className="cursor-pointer rounded-md px-2 py-0.5 text-[11.5px] text-rose-400 hover:bg-rose-400/10">
              Delete
            </button>
            <button onClick={() => setConfirming(false)} aria-label="Cancel" className="cursor-pointer rounded-md p-1 text-night-400 hover:bg-white/10">
              <X className="size-3" />
            </button>
          </span>
        ) : (
          <button
            onClick={() => setConfirming(true)}
            aria-label="Delete conversation"
            className="cursor-pointer rounded-md p-1 text-night-600 opacity-0 transition group-hover:opacity-100 hover:bg-white/10 hover:text-rose-400 focus:opacity-100"
          >
            <Trash2 className="size-3.5" />
          </button>
        )}
      </div>
    </div>
  );
}

function SessionListSkeleton() {
  return (
    <div className="space-y-2" aria-busy>
      {[0, 1, 2, 3].map((i) => (
        <div key={i} className="rounded-xl border border-white/[0.04] px-3.5 py-3">
          <Skeleton className="h-3.5 w-11/12" />
          <Skeleton className="mt-2 h-3.5 w-2/3" />
          <Skeleton className="mt-3 h-2.5 w-28" />
        </div>
      ))}
    </div>
  );
}

/** Saved conversations with one teacher. They live in this student's workspace on the device. */
export function SessionList({ teacher, limit, onPicked }: { teacher: TeacherId; limit?: number; onPicked?: () => void }) {
  const sessions = useSessions(teacher);
  const { threads, open, remove } = useChat();
  if (sessions.isLoading) return <SessionListSkeleton />;
  if (sessions.isError) return <p className="text-[13px] text-rose-400">{(sessions.error as Error).message}</p>;
  const items = (sessions.data ?? []).slice(0, limit);
  if (!items.length) return <p className="rounded-xl border border-dashed border-white/10 p-4 text-[13px] text-night-400">No saved conversations with the {TEACHERS[teacher].name} yet.</p>;
  return (
    <div className="space-y-2">
      {items.map((s) => (
        <SessionRow
          key={s.id}
          session={s}
          active={threads[teacher].sessionId === s.id}
          onOpen={() => {
            void open(teacher, s.id);
            onPicked?.();
          }}
          onDelete={() => void remove(teacher, s.id)}
        />
      ))}
    </div>
  );
}

export function HistoryButton({ teacher }: { teacher: TeacherId }) {
  const [open, setOpen] = useState(false);
  const { reset } = useChat();
  const look = TEACHER_LOOK[teacher];
  return (
    <>
      <Tooltip content="Saved conversations on this device">
        <Button variant="ghost" size="sm" onClick={() => setOpen(true)}>
          <History /> History
        </Button>
      </Tooltip>
      <Sheet open={open} onOpenChange={setOpen}>
        <div className="flex items-center justify-between border-b border-white/[0.06] px-5 py-4">
          <div className="flex items-center gap-2.5">
            <look.Icon className={cn('size-4', look.accent)} />
            <h2 className="font-display text-2xl text-night-100">Conversations</h2>
          </div>
          <SheetClose className="rounded-lg p-1.5 text-night-400 hover:bg-white/10 hover:text-night-100" aria-label="Close">
            <X className="size-4" />
          </SheetClose>
        </div>
        <div className="flex-1 space-y-4 overflow-y-auto p-5">
          <Button
            variant="secondary"
            className="w-full"
            onClick={() => {
              reset(teacher);
              setOpen(false);
            }}
          >
            <MessageSquarePlus /> New conversation
          </Button>
          <SessionList teacher={teacher} onPicked={() => setOpen(false)} />
          <p className="text-[11.5px] leading-5 text-night-500">Saved as plain JSON in your workspace on this device. Images you sent are never stored.</p>
        </div>
      </Sheet>
    </>
  );
}
