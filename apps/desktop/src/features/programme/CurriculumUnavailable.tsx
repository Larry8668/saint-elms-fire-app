import { BookLock, KeyRound, MessageSquareWarning, RefreshCw, WifiOff } from 'lucide-react';
import type { DeviceProfile, SyncStatus } from '@sef/shared';
import { Badge, Panel } from '@/components/ui/primitives';
import { Button } from '@/components/ui/button';
import { admissionCopy, admissionOf } from '@/features/auth/admission';
import { refusalOf, type ProgrammeRefusal } from './manifest-view';

interface CurriculumUnavailableProps {
  error: unknown;
  status: SyncStatus | undefined;
  profile: DeviceProfile;
  onRetry: () => void;
  retrying: boolean;
}

interface RefusalCopy {
  icon: typeof BookLock;
  badge: string;
  title: string;
  body: string;
}

/** Copy for the admission-driven refusal: the state is server-derived, and the copy follows it. */
function admissionCopyFor(profile: DeviceProfile): string {
  const state = admissionOf(profile);
  if (state === 'legacy') {
    return 'The university releases the published curriculum to admitted students and staff. This profile signs in the legacy way, before admission checks existed, so the record is not released to it. Your released courses are unaffected.';
  }
  if (state === 'pending') {
    return 'Your application is still with the registrar. The published curriculum unlocks when the enrolment is approved — and not before.';
  }
  if (state === 'approved') {
    return 'The university declined to release the record to this enrolment just now. If your enrolment changed recently, sign out and back in while online.';
  }
  return `${admissionCopy(state).body} The published curriculum is released to approved students and staff.`;
}

function copyFor(reason: ProgrammeRefusal, profile: DeviceProfile): RefusalCopy {
  switch (reason) {
    case 'admission':
      return { icon: BookLock, badge: 'Not released to this profile', title: 'The curriculum stays closed for now', body: admissionCopyFor(profile) };
    case 'conflict':
      return {
        icon: MessageSquareWarning,
        badge: 'Conflict',
        title: 'A conflicting change interrupted that read',
        body: 'The university reported a conflict while this record was read — your enrolment may have changed just now. Nothing was retried behind your back. Try again, and if it repeats, sign out and back in while online.',
      };
    case 'no_session':
      return {
        icon: KeyRound,
        badge: 'Sign-in needed',
        title: 'No current university session on this device',
        body: 'The programme record is held only by the university, and this device has no current session to read it with. Sign out and sign back in while online. Everything already installed keeps working.',
      };
    case 'uni_unreachable':
      return {
        icon: WifiOff,
        badge: 'University unreachable',
        title: 'The university server is out of reach',
        body: 'This device does not keep a copy of the published curriculum, so it cannot be shown while the university is away. Installed courses still work — the structure appears here when you are back online.',
      };
    case 'unavailable':
      return {
        icon: MessageSquareWarning,
        badge: 'Not a gap in your record',
        title: 'The programme record could not be read',
        body: 'The university did not release the programme record to this device just now. If your enrolment changed recently, sign out and back in while online.',
      };
  }
}

/**
 * The full curriculum is genuinely unavailable here, and this says why rather than drawing an
 * empty curriculum. The reason comes from the engine's typed answer cross-referenced with real
 * device state — a plausible-looking fake would be worse than an honest gap.
 */
export function CurriculumUnavailable({ error, status, profile, onRetry, retrying }: CurriculumUnavailableProps) {
  const reason = refusalOf(error, status, profile);
  const copy = copyFor(reason, profile);
  const Icon = copy.icon;

  return (
    <Panel className="border-ember-400/20 p-5">
      <div className="flex items-start gap-3">
        <Icon aria-hidden className="mt-0.5 size-5 shrink-0 text-ember-400" />
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-2">
            <h2 className="text-[15px] font-semibold text-night-100">{copy.title}</h2>
            <Badge tone="ember">{copy.badge}</Badge>
          </div>
          <p className="mt-2 max-w-2xl text-[13.5px] leading-6 text-night-300">{copy.body}</p>
          <div className="mt-4">
            <Button variant="outline" size="sm" onClick={onRetry} loading={retrying}>
              {!retrying && <RefreshCw />} Try again
            </Button>
          </div>
        </div>
      </div>
    </Panel>
  );
}
