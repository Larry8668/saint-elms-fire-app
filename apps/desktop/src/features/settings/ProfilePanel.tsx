import { ShieldCheck, WifiOff } from 'lucide-react';
import { Badge, Eyebrow, Panel } from '@/components/ui/primitives';
import { ProfileAvatar } from '@/features/auth/ProfileAvatar';
import { useStudent } from '@/lib/session';

/** Read-only identity: the university owns name and cohort; this device only caches them. */
export function ProfilePanel() {
  const { profile, mode } = useStudent();
  return (
    <Panel className="flex flex-col gap-5 p-6 md:flex-row md:items-center">
      <ProfileAvatar id={profile.id} name={profile.name} size="lg" />
      <div className="min-w-0 flex-1">
        <Eyebrow>Signed in as</Eyebrow>
        <div className="mt-1 font-display text-3xl text-night-100">{profile.name}</div>
        <div className="mt-1 text-[13px] text-night-400">
          {profile.email} · cohort <span className="text-night-200">{profile.cohortId}</span>
          {profile.stage && <> · {profile.stage}</>}
        </div>
      </div>
      <div className="flex flex-wrap gap-2">
        {profile.offlineReady && (
          <Badge tone="aurora">
            <WifiOff className="size-3" /> Offline sign-in ready
          </Badge>
        )}
        <Badge tone={mode === 'online' ? 'beacon' : 'ember'}>
          <ShieldCheck className="size-3" /> {mode === 'online' ? 'Verified by the university' : 'Signed in offline'}
        </Badge>
      </div>
    </Panel>
  );
}
