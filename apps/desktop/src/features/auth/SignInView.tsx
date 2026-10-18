import { TEACHER_IDS, TEACHERS } from '@sef/shared';
import { ChevronDown, Cloud, Database, GraduationCap, HardDrive, ServerCrash, ShieldCheck, Sparkles, WifiOff, type LucideIcon } from 'lucide-react';
import { AnimatePresence, motion } from 'motion/react';
import { useRef, useState } from 'react';
import { Button } from '@/components/ui/button';
import { ConnectingScene } from '@/components/ui/connecting-scene';
import { EmptyState } from '@/components/ui/primitives';
import { TEACHER_LOOK } from '@/features/teachers/teacher-meta';
import { EngineError } from '@/lib/api';
import { cn } from '@/lib/cn';
import { DEMO_MODE } from '@/lib/demo';
import { DEMO_ACCOUNTS } from '@/lib/demo-accounts';
import { useHealth } from '@/lib/queries';
import { currentEngineTarget, forgetWorkspace, isHostedWithoutWorkspace } from '@/lib/seat';
import { useSession } from '@/lib/session';
import { portalUrl } from '@/lib/uni-url';
import { UNI_URL } from '@/lib/uni-url';
import { WorkspaceWakeNotice, useWorkspaceWake } from '@/features/workspace/WorkspaceWakeNotice';
import { personaClick, promptSubmit } from './demo-sign-in';
import { DeviceSignInCard } from './DeviceSignInCard';
import { HOSTED_SIGN_IN_NOTE, SIGN_IN_PROMISES, signInCopyMode, type PromiseIcon } from './sign-in-copy';
import { uniOfflineFrom } from './uni-offline';

const PROMISE_ICONS: Record<PromiseIcon, LucideIcon> = { device: HardDrive, shield: ShieldCheck, offline: WifiOff, server: Cloud, storage: Database };

export function SignInView() {
  const health = useHealth();
  const engineDown = health.isError;
  const mode = signInCopyMode();
  // A hosted workspace behind its edge gets its own notice, never the local "pnpm dev" one.
  const wake = useWorkspaceWake();
  // Signed out, public health still carries the bare uni boolean; that drives the banner and Continue.
  const uniOffline = uniOfflineFrom(health.data);
  const [openedAt] = useState(() => Date.now());

  return (
    <div className="sky-backdrop relative flex min-h-screen items-center justify-center overflow-y-auto px-6 py-12">
      <StarField />
      <div className="relative grid w-full max-w-5xl gap-12 lg:grid-cols-[1fr_420px] lg:items-center">
        <Pitch mode={mode} />
        <section className="glass-strong rounded-3xl p-7 animate-rise [animation-delay:80ms]">
          {mode === 'hosted' && <WorkspaceHost />}
          {mode === 'hosted' && (engineDown || wake.phase !== 'idle') ? (
            <WorkspaceWakeNotice failed={engineDown} />
          ) : mode === 'hosted' && health.isPending ? (
            // The first answer from the workspace has not come back yet.
            <ConnectingScene startedAt={openedAt} className="animate-rise py-6 [animation-delay:250ms]" />
          ) : engineDown && isHostedWithoutWorkspace(currentEngineTarget()) ? (
            <EmptyState
              icon={<GraduationCap />}
              title="Sign in through your university"
              body="Your workspace is opened from the university portal."
              action={
                <Button variant="primary" onClick={() => location.assign(portalUrl())}>
                  Open the university portal
                </Button>
              }
            />
          ) : engineDown ? (
            <EmptyState
              icon={<ServerCrash />}
              title="The engine isn't running"
              body='Start everything with "pnpm dev" (or "pnpm dev:engine"); this screen picks it up automatically.'
              action={<Button onClick={() => void health.refetch()}>Try again</Button>}
            />
          ) : (
            <>
              {mode === 'hosted' && <p className="mb-4 text-[12.5px] leading-5 text-night-400">{HOSTED_SIGN_IN_NOTE}</p>}
              <DeviceSignInCard uniOffline={uniOffline} />
              {DEMO_MODE && <DemoAccounts mode={mode} />}
            </>
          )}
        </section>
      </div>
    </div>
  );
}

/** Where this sign-in goes, so a student can see the workspace host before approving the code. */
function WorkspaceHost() {
  const target = currentEngineTarget();
  const host = target.kind === 'workspace' ? target.host : location.host;
  return (
    <div className="mb-3 flex flex-wrap items-center justify-between gap-2 rounded-xl border border-white/[0.08] bg-white/[0.03] px-3 py-2 text-[12.5px] text-night-300">
      <span>
        Signing in to <span className="font-mono text-night-100">{host}</span>
      </span>
      {target.kind === 'workspace' && (
        <Button
          size="sm"
          variant="ghost"
          onClick={() => {
            forgetWorkspace();
            location.reload();
          }}
        >
          Forget workspace
        </Button>
      )}
    </div>
  );
}

function Pitch({ mode }: { mode: 'hosted' | 'local' }) {
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
        {SIGN_IN_PROMISES[mode].map(({ icon, text }) => {
          const Icon = PROMISE_ICONS[icon];
          return (
            <span key={text} className="inline-flex items-center gap-1.5">
              <Icon className="size-3.5 text-night-500" /> {text}
            </span>
          );
        })}
      </div>
    </section>
  );
}

function DemoAccounts({ mode }: { mode: 'hosted' | 'local' }) {
  const { signIn } = useSession();
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  /** Hosted only: the persona whose password is being asked for. */
  const [asking, setAsking] = useState<string | null>(null);
  const [password, setPassword] = useState('');

  /** Demo personas are legacy accounts, so they sign in with a password, not the device flow. */
  const enter = async (email: string, secret: string) => {
    setBusy(email);
    setError(null);
    try {
      await signIn(email, secret);
    } catch (err) {
      setError(err instanceof EngineError ? err.message : 'Sign-in failed. Try again.');
      setBusy(null);
    }
  };

  const choose = (email: string) => {
    const click = personaClick(mode, email);
    if (click.kind === 'sign-in') {
      void enter(click.email, click.password);
    } else {
      setError(null);
      setPassword('');
      setAsking(click.email);
    }
  };

  const asked = DEMO_ACCOUNTS.find((a) => a.email === asking);

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
            {asked ? (
              <form
                className="grid gap-2 pt-3"
                onSubmit={(event) => {
                  event.preventDefault();
                  const click = promptSubmit(asked.email, password);
                  if (click?.kind === 'sign-in') void enter(click.email, click.password);
                }}
              >
                <p className="text-[13px] text-night-100">
                  {asked.label} <span className="text-night-500">· {asked.detail}</span>
                </p>
                <label htmlFor="demo-password" className="text-[12px] text-night-400">
                  Demo password for this university
                </label>
                <input
                  id="demo-password"
                  type="password"
                  autoComplete="current-password"
                  autoFocus
                  value={password}
                  onChange={(e) => setPassword(e.target.value)}
                  disabled={busy !== null}
                  className="rounded-xl border border-white/[0.08] bg-white/[0.03] px-3 py-2 text-[13px] text-night-100 outline-none focus:border-beacon-400/40"
                />
                <div className="flex gap-2">
                  <Button type="submit" size="sm" variant="primary" loading={busy !== null} disabled={password.length === 0}>
                    Sign in
                  </Button>
                  <Button
                    type="button"
                    size="sm"
                    variant="ghost"
                    disabled={busy !== null}
                    onClick={() => {
                      setAsking(null);
                      setPassword('');
                      setError(null);
                    }}
                  >
                    Back
                  </Button>
                </div>
              </form>
            ) : (
              <div className="grid gap-1.5 pt-3">
                {DEMO_ACCOUNTS.map(({ email, label, detail }) => (
                  <button
                    key={email}
                    type="button"
                    onClick={() => choose(email)}
                    disabled={busy !== null}
                    className={cn(
                      'flex cursor-pointer items-center gap-3 rounded-xl border px-3 py-2 text-left transition disabled:cursor-default disabled:opacity-60',
                      busy === email ? 'border-beacon-400/40 bg-beacon-500/10' : 'border-white/[0.05] bg-white/[0.02] hover:border-white/[0.12]',
                    )}
                  >
                    <GraduationCap className="size-4 shrink-0 text-night-400" />
                    <span className="min-w-0">
                      <span className="block text-[13px] text-night-100">{label}</span>
                      <span className="block truncate text-[11.5px] text-night-500">{detail}</span>
                    </span>
                  </button>
                ))}
              </div>
            )}
            {error && (
              <p role="alert" className="mt-2.5 rounded-xl border border-rose-400/25 bg-rose-400/10 p-2.5 text-[12.5px] text-rose-400">
                {error}
              </p>
            )}
            <p className="pt-2.5 text-[11.5px] text-night-500">
              {mode === 'hosted'
                ? 'Demo accounts are seeded by the university and bypass admission. Their password is set by whoever runs this server.'
                : 'Demo accounts are seeded locally and bypass university admission.'}
            </p>
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
