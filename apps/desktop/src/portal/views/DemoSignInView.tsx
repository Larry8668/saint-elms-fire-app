import { GraduationCap } from 'lucide-react';
import { useState } from 'react';
import { DEMO_ACCOUNTS, type DemoAccount } from '@/lib/demo-accounts';
import { cn } from '@/lib/cn';
import { Field } from '../components/Field';
import { ModeLinks } from '../components/ModeLinks';
import { Notice } from '../components/Notice';
import { PortalShell } from '../components/PortalShell';
import { SubmitButton } from '../components/SubmitButton';
import { DEMO_START, pickPersona, submitDemoSignIn, type DemoSignIn } from '../demo-sign-in';
import type { PortalMode } from '../portal-modes';
import { demoSignIn } from '../portal-api';

/** Signs in one of the seeded demo students; shown only when this university seeds them. */
export function DemoSignInView({ go, onSignedIn }: { go: (mode: PortalMode) => void; onSignedIn: (persona: DemoAccount) => void }) {
  const [state, setState] = useState<DemoSignIn>(DEMO_START);
  const [password, setPassword] = useState('');
  const busy = state.phase !== 'choosing';
  const picked = state.phase === 'choosing' ? state.personaId : state.persona.id;

  return (
    <PortalShell eyebrow="Saint Elms University" title="Demo student" description="Sign in as one of the demo students this university seeds. They skip admission and are already enrolled.">
      <form
        className="space-y-4"
        noValidate
        onSubmit={(event) => {
          event.preventDefault();
          void submitDemoSignIn(state, password, demoSignIn, setState).then((final) => {
            if (final.phase !== 'signed-in') return;
            setPassword('');
            onSignedIn(final.persona);
          });
        }}
      >
        {state.phase === 'choosing' && state.error && <Notice tone="error">{state.error.message}</Notice>}
        <fieldset className="grid gap-1.5" disabled={busy}>
          <legend className="mb-2 text-[13px] text-night-300">Who are you signing in as?</legend>
          {DEMO_ACCOUNTS.map((account) => (
            <label
              key={account.id}
              className={cn(
                'flex cursor-pointer items-center gap-3 rounded-xl border px-3 py-2.5 transition',
                picked === account.id ? 'border-beacon-400/40 bg-beacon-500/10' : 'border-white/[0.06] bg-white/[0.02] hover:border-white/[0.12]',
              )}
            >
              <input type="radio" name="persona" value={account.id} checked={picked === account.id} onChange={() => setState((s) => pickPersona(s, account.id))} className="sr-only" />
              <GraduationCap className="size-4 shrink-0 text-night-400" />
              <span className="min-w-0">
                <span className="block text-[14px] text-night-100">{account.label}</span>
                <span className="block truncate text-[12px] text-night-500">{account.detail}</span>
              </span>
            </label>
          ))}
        </fieldset>
        <Field label="Demo password" type="password" name="password" autoComplete="current-password" required value={password} onChange={(e) => setPassword(e.target.value)} disabled={busy} />
        <SubmitButton idle="Sign in" busy={busy} busyLabel="Signing in" />
      </form>
      <div className="mt-5 border-t border-white/[0.07] pt-4">
        <ModeLinks current="demo-sign-in" go={go} links={[{ mode: 'sign-in', label: 'Sign in with your email instead' }]} />
      </div>
    </PortalShell>
  );
}
