import { DEMO_PASSWORD_DEFAULT, DEMO_PERSONAS, TEACHER_IDS, TEACHERS } from '@sef/shared';
import { ChevronDown, GraduationCap, HardDrive, ServerCrash, ShieldCheck, Sparkles, WifiOff } from 'lucide-react';
import { AnimatePresence, motion } from 'motion/react';
import { useRef, useState } from 'react';
import { Button } from '@/components/ui/button';
import { EmptyState } from '@/components/ui/primitives';
import { TEACHER_LOOK } from '@/features/teachers/teacher-meta';
import { EngineError } from '@/lib/api';
import { cn } from '@/lib/cn';
import { DEMO_MODE } from '@/lib/demo';
import { useHealth } from '@/lib/queries';
import { useSession } from '@/lib/session';
import { UNI_URL } from '@/lib/uni-url';
import { SeatEntry } from '@/features/seat/SeatEntry';
import { SeatWakeNotice, useSeatWake } from '@/features/seat/SeatWakeNotice';
import { engineTarget, isRemoteTarget } from '@/lib/seat';
import { DeviceSignInCard } from './DeviceSignInCard';
import { uniOfflineFrom } from './uni-offline';

const YEAR_LABEL = ['First-year', 'Second-year', 'Third-year'];

/** Demo accounts described by where they are in the programme, not by who they are. */
const DEMO_ACCOUNTS = DEMO_PERSONAS.map((p) => ({
  email: p.email,
  label: `${YEAR_LABEL[Math.max(0, Math.ceil(p.throughSemester / 2) - 1)] ?? 'Final-year'} student`,
  detail: p.stage,
  Icon: GraduationCap,
}));

const PROMISES = [
  { Icon: HardDrive, text: 'Your brain stays on this device' },
  { Icon: ShieldCheck, text: 'Open-weight models, built to GDPR/DPDP' },
  { Icon: WifiOff, text: 'Keeps working offline' },
];

export function SignInView() {
  const health = useHealth();
  const engineDown = health.isError;
  // A hosted seat may be asleep or paused: it gets its own notice, never the local "pnpm dev" one.
  const remote = isRemoteTarget(engineTarget());
  const wake = useSeatWake();
  // Signed out, public health still carries the bare uni boolean; that drives the banner and Continue.
  const uniOffline = uniOfflineFrom(health.data);

  return (
    <div className="sky-backdrop relative flex min-h-screen items-center justify-center overflow-y-auto px-6 py-12">
      <StarField />
      <div className="relative grid w-full max-w-5xl gap-12 lg:grid-cols-[1fr_420px] lg:items-center">
        <Pitch />
        <section className="glass-strong rounded-3xl p-7 animate-rise [animation-delay:80ms]">
          {remote && (engineDown || wake.phase !== 'idle') ? (
            <SeatWakeNotice failed={engineDown} />
          ) : engineDown ? (
            <EmptyState
              icon={<ServerCrash />}
              title="The engine isn't running"
              body='Start everything with "pnpm dev" (or "pnpm dev:engine"); this screen picks it up automatically.'
              action={<Button onClick={() => void health.refetch()}>Try again</Button>}
            />
          ) : (
            <>
              <DeviceSignInCard uniOffline={uniOffline} />
              {DEMO_MODE && <DemoAccounts />}
            </>
          )}
          <SeatEntry />
        </section>
      </div>
    </div>
  );
}

function Pitch() {
  return (
    <section className="animate-rise">
      <img src="/logo.svg" alt="" className="mb-6 size-12" />
      <h1 className="font-display text-5xl leading-[1.05] text-night-100 md:text-6xl">
        Saint Elms <span className="text-gradient italic">Fire</span>
      </h1>
      <p className="mt-4 max-w-md text-[15.5px] leading-7 text-night-300">A personal teacher with three minds, teaching from a living map of everything you have learned.</p>

      <ul className="mt-8 max-w-md space-y-3">
        {TEACHER_IDS.map((id, i) => {
          const look = TEACHER_LOOK[id];
          return (
            <motion.li key={id} initial={{ opacity: 0, x: -8 }} animate={{ opacity: 1, x: 0 }} transition={{ delay: 0.15 + i * 0.07 }} className="flex items-center gap-3.5">
              <span className={cn('grid size-9 shrink-0 place-items-center rounded-xl border bg-white/[0.04]', look.ring, look.accent)}>
                <look.Icon className="size-4" />
              </span>
              <span className="min-w-0">
                <span className="block text-[14px] font-medium text-night-100">{TEACHERS[id].voice}</span>
                <span className="block text-[12.5px] text-night-400">{TEACHERS[id].role}</span>
              </span>
            </motion.li>
          );
        })}
      </ul>

      <div className="mt-8 flex flex-wrap gap-x-5 gap-y-2 text-[12px] text-night-400">
        {PROMISES.map(({ Icon, text }) => (
          <span key={text} className="inline-flex items-center gap-1.5">
            <Icon className="size-3.5 text-night-500" /> {text}
          </span>
        ))}
      </div>
    </section>
  );
}

function DemoAccounts() {
  const { signIn } = useSession();
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  /** Demo personas live in the engine, not the university, so they sign in the legacy way. */
  const enter = async (email: string) => {
    setBusy(email);
    setError(null);
    try {
      await signIn(email, DEMO_PASSWORD_DEFAULT);
    } catch (err) {
      setError(err instanceof EngineError ? err.message : 'Sign-in failed. Try again.');
      setBusy(null);
    }
  };

  return (
    <div className="border-t border-white/[0.06] pt-4">
      <button type="button" onClick={() => setOpen((o) => !o)} aria-expanded={open} className="flex w-full cursor-pointer items-center gap-2 text-[12.5px] text-night-400 hover:text-night-200">
        <Sparkles className="size-3.5 text-beacon-300" />
        Exploring the demo?
        <ChevronDown className={cn('ml-auto size-3.5 transition', open && 'rotate-180')} />
      </button>
      <AnimatePresence initial={false}>
        {open && (
          <motion.div initial={{ height: 0, opacity: 0 }} animate={{ height: 'auto', opacity: 1 }} exit={{ height: 0, opacity: 0 }} transition={{ duration: 0.18 }} className="overflow-hidden">
            <div className="grid gap-1.5 pt-3">
              {DEMO_ACCOUNTS.map(({ email, label, detail, Icon }) => (
                <button
                  key={email}
                  type="button"
                  onClick={() => void enter(email)}
                  disabled={busy !== null}
                  className={cn(
                    'flex cursor-pointer items-center gap-3 rounded-xl border px-3 py-2 text-left transition disabled:cursor-default disabled:opacity-60',
                    busy === email ? 'border-beacon-400/40 bg-beacon-500/10' : 'border-white/[0.05] bg-white/[0.02] hover:border-white/[0.12]',
                  )}
                >
                  <Icon className="size-4 shrink-0 text-night-400" />
                  <span className="min-w-0">
                    <span className="block text-[13px] text-night-100">{label}</span>
                    <span className="block truncate text-[11.5px] text-night-500">{detail}</span>
                  </span>
                </button>
              ))}
            </div>
            {error && (
              <p role="alert" className="mt-2.5 rounded-xl border border-rose-400/25 bg-rose-400/10 p-2.5 text-[12.5px] text-rose-400">
                {error}
              </p>
            )}
            <p className="pt-2.5 text-[11.5px] text-night-500">Demo accounts are seeded locally and bypass university admission.</p>
            <p className="pt-1 text-[11.5px] text-night-500">
              Staff sign in at the{' '}
              <a href={`${UNI_URL}/admin`} target="_blank" rel="noreferrer noopener" className="text-night-300 underline underline-offset-2">
                registrar portal
              </a>{' '}
              — it is hosted by the university server and needs its database stack.
            </p>
          </motion.div>
        )}
      </AnimatePresence>
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
