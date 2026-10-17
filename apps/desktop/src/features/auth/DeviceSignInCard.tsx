import { useQuery } from '@tanstack/react-query';
import { ArrowRight, Copy, Laptop, ShieldAlert } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import { toast } from 'sonner';
import type { DevicePollResult, DeviceProfile, DeviceSignInStart } from '@sef/shared';
import { Button } from '@/components/ui/button';
import { Label } from '@/components/ui/primitives';
import { api, EngineError } from '@/lib/api';
import { log } from '@/lib/log';
import { useSession } from '@/lib/session';
import { formatCountdown, initialPollInterval, nextPollIntervalSeconds, outcomeMessage, type GrantOutcome } from './device-grant';

/**
 * First-time university sign-in. The engine opens a device grant; the person approves it
 * in a browser on the university's own site. Nothing is typed into this window and no
 * password is handled here — the engine never sees one.
 */
export function DeviceSignInCard({ uniOffline }: { uniOffline: boolean }) {
  const { startDeviceSignIn, pollDeviceSignIn } = useSession();
  const [grant, setGrant] = useState<DeviceSignInStart | null>(null);
  const [starting, setStarting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [manual, setManual] = useState('');

  // Profiles are only used for the "already on this device" path.
  const profiles = useQuery({ queryKey: ['profiles'], queryFn: api.profiles, retry: false, staleTime: 30_000 });

  const begin = async () => {
    setStarting(true);
    setError(null);
    try {
      setGrant(await startDeviceSignIn());
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not reach the university server.');
    } finally {
      setStarting(false);
    }
  };

  const cancel = () => {
    setGrant(null);
    setError(null);
  };

  if (grant) {
    return <DeviceGrantPending grant={grant} poll={pollDeviceSignIn} onCancel={cancel} />;
  }

  const known = (profiles.data ?? []).filter((p) => p.offlineReady);

  return (
    <div className="space-y-4">
      <div>
        <h2 className="font-display text-3xl text-night-100">Sign in</h2>
        <p className="mt-1 text-[13px] text-night-400">Use your university account. We will show you a code to confirm in your browser.</p>
      </div>

      {uniOffline && (
        <div className="flex gap-2.5 rounded-xl border border-ember-400/25 bg-ember-500/[0.08] p-3 text-[12.5px] leading-5 text-ember-300">
          <ShieldAlert className="mt-0.5 size-3.5 shrink-0" />
          <span>The university server is unreachable, so first-time sign-in is unavailable. Students who signed in here before can still unlock offline.</span>
        </div>
      )}

      {error && (
        <p role="alert" className="rounded-xl border border-rose-400/25 bg-rose-400/10 p-3 text-[13px] text-rose-400">
          {error}
        </p>
      )}

      <Button variant="primary" size="lg" className="w-full" onClick={() => void begin()} loading={starting} disabled={uniOffline}>
        Continue with your university account
      </Button>

      {known.length > 0 && <KnownProfiles profiles={known} />}

      {profiles.isError && <p className="text-[12px] text-night-500">This engine is running, but its stored profiles could not be read.</p>}
    </div>
  );
}

/** Polls the grant the engine is holding and reports the outcome honestly. */
function DeviceGrantPending({ grant, poll, onCancel }: { grant: DeviceSignInStart; poll: () => Promise<DevicePollResult>; onCancel: () => void }) {
  const [secondsLeft, setSecondsLeft] = useState(grant.expiresInSeconds);
  const [outcome, setOutcome] = useState<GrantOutcome | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const pollInterval = useRef(initialPollInterval(grant));

  const target = grant.verificationUriComplete ?? grant.verificationUri;

  useEffect(() => {
    let stopped = false;
    let pollHandle: ReturnType<typeof setTimeout> | undefined;
    const countdown = setInterval(() => setSecondsLeft((s) => Math.max(0, s - 1)), 1000);

    const tick = async () => {
      try {
        const result = await poll();
        if (stopped) return;
        if (result.status === 'pending') {
          setMessage(null);
          pollInterval.current = nextPollIntervalSeconds(pollInterval.current, result);
        } else if (result.status === 'approved') {
          // The session is live now; Root swaps shells on its own.
          stopped = true;
          clearInterval(countdown);
          setMessage('Approved. Opening your dashboard…');
          return;
        } else {
          // Denied or expired: the card stays mounted so the outcome is actually seen.
          stopped = true;
          clearInterval(countdown);
          setOutcome(result.status);
          return;
        }
      } catch (err) {
        if (stopped) return;
        if (err instanceof EngineError && err.code === 'seat_not_yours') {
          stopped = true;
          clearInterval(countdown);
          setOutcome('seat_not_yours');
          return;
        }
        log.warn('device_poll_failed', { error: String(err) });
        setMessage('Lost contact with the university server. Still trying…');
      }
      pollHandle = setTimeout(() => void tick(), pollInterval.current * 1000);
    };

    void tick();
    return () => {
      stopped = true;
      clearInterval(countdown);
      clearTimeout(pollHandle);
    };
  }, [poll]);

  const copy = () => {
    void navigator.clipboard?.writeText(grant.userCode);
    toast.success('Code copied');
  };

  if (outcome) {
    return (
      <div className="space-y-4">
        <div>
          <h2 className="font-display text-3xl text-night-100">Confirm this device</h2>
        </div>
        <p role="alert" className="rounded-xl border border-rose-400/25 bg-rose-400/10 p-3 text-[13px] text-rose-400">
          {outcomeMessage(outcome)}
        </p>
        <Button variant="primary" size="lg" className="w-full" onClick={onCancel}>
          Start again
        </Button>
      </div>
    );
  }

  const expired = secondsLeft <= 0;

  return (
    <div className="space-y-4">
      <div>
        <h2 className="font-display text-3xl text-night-100">Confirm this device</h2>
        <p className="mt-1 text-[13px] text-night-400">Open the university site and enter this code. It expires in {formatCountdown(secondsLeft)}.</p>
      </div>

      <div className="flex items-center gap-3 rounded-2xl border border-white/[0.08] bg-white/[0.03] p-4">
        <Laptop className="size-5 shrink-0 text-night-400" />
        <code className="flex-1 text-center font-mono text-xl tracking-[0.2em] text-night-100">{grant.userCode}</code>
        <Button variant="ghost" size="icon" onClick={copy} aria-label="Copy code">
          <Copy />
        </Button>
      </div>

      {message && <p className="text-[13px] text-night-300">{message}</p>}

      <a
        href={target}
        target="_blank"
        rel="noreferrer noopener"
        className="inline-flex w-full items-center justify-center gap-2 rounded-xl bg-beacon-500 px-6 py-3 text-[15px] font-medium text-white transition hover:bg-beacon-400 aria-disabled:opacity-50"
        aria-disabled={expired}
        onClick={(e) => {
          if (expired) e.preventDefault();
        }}
      >
        Open the university site <ArrowRight className="size-4" />
      </a>

      <Button variant="ghost" className="w-full" onClick={onCancel}>
        Cancel
      </Button>
    </div>
  );
}

/** Profiles already unlocked on this machine, for signing in without the university. */
function KnownProfiles({ profiles }: { profiles: DeviceProfile[] }) {
  const { unlockOffline } = useSession();
  const [chosen, setChosen] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const unlock = async () => {
    if (!chosen) {
      setError('Pick one of the profiles listed on this device.');
      return;
    }
    setBusy(true);
    setError(null);
    try {
      await unlockOffline(chosen);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not unlock that profile.');
      setBusy(false);
    }
  };

  return (
    <div className="border-t border-white/[0.06] pt-4">
      <Label htmlFor="known-profile">Already signed in on this device?</Label>
      <div className="flex gap-2">
        <select
          id="known-profile"
          value={chosen}
          onChange={(e) => {
            setChosen(e.target.value);
            setError(null);
          }}
          className="min-w-0 flex-1 rounded-xl border border-white/[0.08] bg-white/[0.04] px-3 py-2 text-sm text-night-100 outline-none focus-visible:ring-2 focus-visible:ring-beacon-400/60"
        >
          <option value="">Choose a profile…</option>
          {profiles.map((p) => (
            <option key={p.id} value={p.id}>
              {p.name}
              {p.email ? ` · ${p.email}` : ''}
            </option>
          ))}
        </select>
        <Button onClick={() => void unlock()} loading={busy} disabled={!chosen}>
          Unlock
        </Button>
      </div>
      {error && <p className="pt-2 text-[12px] text-rose-400">{error}</p>}
    </div>
  );
}
