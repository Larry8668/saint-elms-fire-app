import { LogOut, Wifi, WifiOff } from 'lucide-react';
import { AnimatePresence, motion } from 'motion/react';
import { useEffect, useRef, useState } from 'react';
import { ProfileAvatar } from '@/features/auth/ProfileAvatar';
import { Button } from '@/components/ui/button';
import { useHealth } from '@/lib/queries';
import { useSession, useStudent } from '@/lib/session';

/** Avatar at the bottom of the sidebar: who is signed in, whether we are online, and sign-out. */
export function ProfileMenu() {
  const { profile } = useStudent();
  const { signOut } = useSession();
  const health = useHealth();
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  const online = health.data?.uni?.reachable;

  useEffect(() => {
    if (!open) return;
    const close = (e: MouseEvent) => ref.current && !ref.current.contains(e.target as Node) && setOpen(false);
    const esc = (e: KeyboardEvent) => e.key === 'Escape' && setOpen(false);
    document.addEventListener('mousedown', close);
    document.addEventListener('keydown', esc);
    return () => {
      document.removeEventListener('mousedown', close);
      document.removeEventListener('keydown', esc);
    };
  }, [open]);

  return (
    <div ref={ref} className="relative">
      <button onClick={() => setOpen((o) => !o)} aria-label={`Account: ${profile.name}`} aria-expanded={open} className="relative rounded-full ring-offset-2 ring-offset-night-950 transition hover:ring-2 hover:ring-beacon-400/40">
        <ProfileAvatar id={profile.id} name={profile.name} size="sm" />
        {online === false && <span className="absolute -right-0.5 -bottom-0.5 size-3 rounded-full border-2 border-night-950 bg-ember-400" />}
      </button>
      <AnimatePresence>
        {open && (
          <motion.div
            initial={{ opacity: 0, x: -6, scale: 0.98 }}
            animate={{ opacity: 1, x: 0, scale: 1 }}
            exit={{ opacity: 0, x: -6, scale: 0.98 }}
            transition={{ duration: 0.14 }}
            className="glass-strong absolute bottom-0 left-12 z-50 w-72 rounded-2xl p-4"
          >
            <div className="flex items-center gap-3">
              <ProfileAvatar id={profile.id} name={profile.name} />
              <div className="min-w-0">
                <div className="font-medium text-night-100">{profile.name}</div>
                <div className="truncate text-[12px] text-night-400">{profile.email}</div>
              </div>
            </div>
            <dl className="mt-4 space-y-1.5 text-[12.5px]">
              {profile.stage && <Row label="Stage" value={profile.stage} />}
              <Row label="Cohort" value={profile.cohortId} />
              <Row
                label="Connection"
                value={
                  online === false ? (
                    <span className="inline-flex items-center gap-1 text-ember-300">
                      <WifiOff className="size-3" /> Offline, studying from this device
                    </span>
                  ) : (
                    <span className="inline-flex items-center gap-1 text-aurora-300">
                      <Wifi className="size-3" /> Online
                    </span>
                  )
                }
              />
            </dl>
            <Button variant="ghost" size="sm" className="mt-4 w-full justify-start" onClick={() => void signOut()}>
              <LogOut /> Sign out
            </Button>
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
}

function Row({ label, value }: { label: string; value: React.ReactNode }) {
  return (
    <div className="flex justify-between gap-3">
      <dt className="text-night-500">{label}</dt>
      <dd className="text-right text-night-200">{value}</dd>
    </div>
  );
}
