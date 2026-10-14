import { useQuery } from '@tanstack/react-query';
import { DEMO_ADMIN, DEMO_PASSWORD_DEFAULT, type DeviceProfile } from '@sef/shared';
import { ArrowRight, KeyRound, Landmark, ServerCrash, UserRound, WifiOff } from 'lucide-react';
import { AnimatePresence, motion } from 'motion/react';
import { useRef, useState, type FormEvent } from 'react';
import { Button } from '@/components/ui/button';
import { Badge, EmptyState, Eyebrow, Input, Label, Skeleton, StatusDot } from '@/components/ui/primitives';
import { api, EngineError } from '@/lib/api';
import { cn } from '@/lib/cn';
import { useHealth } from '@/lib/queries';
import { useSession } from '@/lib/session';
import { ProfileAvatar } from './ProfileAvatar';

type Target = { kind: 'profile'; profile: DeviceProfile } | { kind: 'admin' } | { kind: 'other' };

export function SignInView() {
  const health = useHealth();
  const profiles = useQuery({ queryKey: ['device-profiles'], queryFn: api.profiles, retry: 1 });
  const [target, setTarget] = useState<Target | null>(null);
  const online = health.data?.uni.reachable;

  return (
    <div className="sky-backdrop relative flex min-h-screen items-center justify-center overflow-y-auto px-6 py-12">
      <StarField />
      <div className="relative grid w-full max-w-5xl gap-10 lg:grid-cols-[1fr_440px] lg:items-center">
        <section className="animate-rise">
          <img src="/logo.svg" alt="" className="mb-6 size-12" />
          <h1 className="font-display text-5xl leading-[1.05] text-night-100 md:text-6xl">
            Saint Elms <span className="text-gradient italic">Fire</span>
          </h1>
          <p className="mt-4 max-w-md text-[15px] leading-7 text-night-300">
            Three AI teachers, a second brain that grows with you, and your whole course on this device. Works offline once you have signed in.
          </p>
          <div className="mt-6 inline-flex items-center gap-2.5 rounded-full border border-white/[0.08] bg-black/30 px-3.5 py-1.5 text-[12.5px] text-night-300">
            <StatusDot ok={health.isError ? false : online} pulse />
            {health.isError ? 'Local engine not running' : online === undefined ? 'Checking the university…' : online ? 'University online' : 'Offline: saved profiles only'}
          </div>
        </section>

        <section className="glass-strong rounded-3xl p-6 animate-rise [animation-delay:80ms]">
          {health.isError && profiles.isError ? (
            <EmptyState
              icon={<ServerCrash />}
              title="The engine isn't running"
              body='Start everything with "pnpm dev" (or "pnpm dev:engine"), then this screen will pick it up.'
              action={<Button onClick={() => void profiles.refetch()}>Try again</Button>}
            />
          ) : (
            <AnimatePresence mode="wait" initial={false}>
              {target ? (
                <motion.div key="form" initial={{ opacity: 0, x: 12 }} animate={{ opacity: 1, x: 0 }} exit={{ opacity: 0, x: -12 }} transition={{ duration: 0.18 }}>
                  <SignInForm target={target} online={online} onBack={() => setTarget(null)} />
                </motion.div>
              ) : (
                <motion.div key="picker" initial={{ opacity: 0, x: -12 }} animate={{ opacity: 1, x: 0 }} exit={{ opacity: 0, x: 12 }} transition={{ duration: 0.18 }}>
                  <ProfilePicker profiles={profiles.data} loading={profiles.isLoading} onPick={setTarget} />
                </motion.div>
              )}
            </AnimatePresence>
          )}
        </section>
      </div>
    </div>
  );
}

function ProfilePicker({ profiles, loading, onPick }: { profiles?: DeviceProfile[]; loading: boolean; onPick: (t: Target) => void }) {
  return (
    <div>
      <Eyebrow className="mb-3">Students on this device</Eyebrow>
      <div className="space-y-2">
        {loading && [0, 1, 2].map((i) => <ProfileCardSkeleton key={i} />)}
        {profiles?.map((profile) => (
          <button
            key={profile.id}
            onClick={() => onPick({ kind: 'profile', profile })}
            className="group flex w-full items-center gap-3.5 rounded-2xl border border-white/[0.06] bg-white/[0.025] p-3 text-left transition hover:border-beacon-400/40 hover:bg-beacon-500/[0.07]"
          >
            <ProfileAvatar id={profile.id} name={profile.name} />
            <div className="min-w-0 flex-1">
              <div className="flex items-center gap-2">
                <span className="font-medium text-night-100">{profile.name}</span>
                {profile.stage && <span className="truncate text-[12px] text-night-400">{profile.stage}</span>}
              </div>
              {profile.persona && <p className="mt-0.5 line-clamp-1 text-[12.5px] text-night-400">{profile.persona}</p>}
            </div>
            {profile.offlineReady && (
              <Badge tone="aurora" className="shrink-0">
                <WifiOff className="size-3" /> offline-ready
              </Badge>
            )}
            <ArrowRight className="size-4 shrink-0 text-night-600 transition group-hover:translate-x-0.5 group-hover:text-beacon-300" />
          </button>
        ))}
        {!loading && !profiles?.length && <p className="rounded-2xl border border-dashed border-white/10 p-4 text-sm text-night-400">No one has signed in on this device yet.</p>}
      </div>

      <div className="mt-5 grid grid-cols-2 gap-2">
        <Button variant="ghost" onClick={() => onPick({ kind: 'other' })}>
          <UserRound /> Another account
        </Button>
        <Button variant="ghost" onClick={() => onPick({ kind: 'admin' })}>
          <Landmark /> Registrar
        </Button>
      </div>
    </div>
  );
}

function SignInForm({ target, online, onBack }: { target: Target; online: boolean | undefined; onBack: () => void }) {
  const { signIn } = useSession();
  const presetEmail = target.kind === 'profile' ? target.profile.email : target.kind === 'admin' ? DEMO_ADMIN.email : '';
  const [email, setEmail] = useState(presetEmail);
  const [password, setPassword] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);
  const passwordRef = useRef<HTMLInputElement>(null);

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setPending(true);
    setError(null);
    try {
      await signIn(email.trim(), password);
    } catch (err) {
      setError(err instanceof EngineError ? err.message : 'Sign-in failed. Try again.');
      setPending(false);
    }
  };

  const adminOffline = target.kind === 'admin' && online === false;
  return (
    <form onSubmit={submit} className="space-y-4">
      <button type="button" onClick={onBack} className="text-[12.5px] text-night-400 hover:text-night-200">
        ← All profiles
      </button>

      {target.kind === 'profile' ? (
        <div className="flex items-center gap-3.5">
          <ProfileAvatar id={target.profile.id} name={target.profile.name} size="lg" />
          <div>
            <h2 className="font-display text-3xl text-night-100">{target.profile.name}</h2>
            <p className="text-[13px] text-night-400">{target.profile.email}</p>
          </div>
        </div>
      ) : (
        <h2 className="font-display text-3xl text-night-100">{target.kind === 'admin' ? 'Registrar sign-in' : 'Sign in'}</h2>
      )}

      {target.kind !== 'profile' && (
        <div>
          <Label htmlFor="email">Email</Label>
          <Input id="email" type="email" autoComplete="username" value={email} onChange={(e) => setEmail(e.target.value)} autoFocus={!presetEmail} required />
        </div>
      )}
      <div>
        <Label htmlFor="password">Password</Label>
        <Input
          ref={passwordRef}
          id="password"
          type="password"
          autoComplete="current-password"
          value={password}
          onChange={(e) => setPassword(e.target.value)}
          autoFocus={Boolean(presetEmail)}
          required
        />
        <button
          type="button"
          className="mt-2 inline-flex items-center gap-1.5 text-[12px] text-night-400 hover:text-beacon-300"
          onClick={() => {
            setPassword(DEMO_PASSWORD_DEFAULT);
            passwordRef.current?.focus();
          }}
        >
          <KeyRound className="size-3" /> Use demo password
        </button>
      </div>

      {adminOffline && <p className="rounded-xl border border-ember-400/25 bg-ember-500/10 p-3 text-[13px] text-ember-300">The registrar desk lives on the university server, which is unreachable right now.</p>}
      {target.kind === 'profile' && online === false && target.profile.offlineReady && (
        <p className="rounded-xl border border-aurora-400/20 bg-aurora-500/10 p-3 text-[13px] text-aurora-300">Offline: you'll sign in with the copy saved on this device.</p>
      )}
      {error && (
        <p role="alert" className="rounded-xl border border-rose-400/25 bg-rose-400/10 p-3 text-[13px] text-rose-400">
          {error}
        </p>
      )}

      <Button type="submit" variant="primary" size="lg" className="w-full" loading={pending} disabled={adminOffline}>
        Sign in
      </Button>
    </form>
  );
}

function ProfileCardSkeleton() {
  return (
    <div className="flex items-center gap-3.5 rounded-2xl border border-white/[0.04] p-3">
      <Skeleton className="size-10 rounded-full" />
      <div className="flex-1 space-y-2">
        <Skeleton className="h-3.5 w-32" />
        <Skeleton className="h-3 w-56" />
      </div>
    </div>
  );
}

/** Cheap decorative stars: pure CSS, no canvas, so the sign-in screen paints instantly. */
function StarField() {
  const stars = useRef(
    Array.from({ length: 70 }, (_, i) => ({
      left: `${(i * 37.7) % 100}%`,
      top: `${(i * 61.3) % 100}%`,
      size: i % 9 === 0 ? 2 : 1,
      delay: `${(i % 7) * 0.45}s`,
    })),
  ).current;
  return (
    <div aria-hidden className="pointer-events-none absolute inset-0 overflow-hidden">
      {stars.map((s, i) => (
        <span
          key={i}
          className={cn('absolute rounded-full bg-beacon-200 animate-twinkle', s.size === 2 && 'shadow-[0_0_6px] shadow-beacon-300')}
          style={{ left: s.left, top: s.top, width: s.size, height: s.size, animationDelay: s.delay }}
        />
      ))}
    </div>
  );
}
