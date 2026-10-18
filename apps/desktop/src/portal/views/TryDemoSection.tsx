import { ArrowRight, GraduationCap, Sparkles } from 'lucide-react';
import { useState } from 'react';
import { WorkingLabel } from '@/components/ui/loading';
import { DEMO_ACCOUNTS, type DemoAccount } from '@/lib/demo-accounts';
import { DEMO_SELF_SERVE_PASSWORD } from '@/lib/demo-self-serve';
import { capture, identifyDemo } from '@/lib/analytics';
import { cn } from '@/lib/cn';
import { Notice } from '../components/Notice';
import { DEMO_START, selfServeSignIn, type DemoSignIn } from '../demo-sign-in';
import { demoSignIn } from '../portal-api';

/**
 * Self-serve demo builds only: the sign-in screen leads with the three demo students. One click
 * signs the persona in with the embedded password; the caller then opens the workspace itself.
 */
export function TryDemoSection({ onSignedIn }: { onSignedIn: (persona: DemoAccount) => void }) {
  const [state, setState] = useState<DemoSignIn>(DEMO_START);
  const busy = state.phase !== 'choosing';

  const pick = (persona: DemoAccount) => {
    if (busy) return;
    identifyDemo(persona.id);
    capture('demo_self_serve_started', { persona: persona.id });
    void selfServeSignIn(persona.id, DEMO_SELF_SERVE_PASSWORD, demoSignIn, setState).then((final) => {
      if (final.phase === 'signed-in') onSignedIn(final.persona);
    });
  };

  return (
    <section aria-labelledby="try-demo" className="mb-6 border-b border-white/[0.07] pb-6">
      <h2 id="try-demo" className="flex items-center gap-2 text-[15px] font-medium text-night-100">
        <Sparkles className="size-4 text-beacon-300" /> Try the demo
      </h2>
      <p className="mt-1 mb-3 text-[13px] leading-5 text-night-400">Pick a student. We sign you in and open their workspace; nothing to type.</p>
      {state.phase === 'choosing' && state.error && (
        <div className="mb-3">
          <Notice tone="error">{state.error.message}</Notice>
        </div>
      )}
      <div className="grid gap-1.5">
        {DEMO_ACCOUNTS.map((account) => {
          const active = state.phase !== 'choosing' && state.persona.id === account.id;
          return (
            <button
              key={account.id}
              type="button"
              onClick={() => pick(account)}
              disabled={busy}
              className={cn(
                'group flex cursor-pointer items-center gap-3 rounded-xl border px-3 py-3 text-left transition disabled:cursor-default',
                active ? 'border-beacon-400/40 bg-beacon-500/10' : 'border-white/[0.06] bg-white/[0.02] hover:border-beacon-400/30 hover:bg-beacon-500/[0.06] disabled:opacity-60',
              )}
            >
              <GraduationCap className="size-4 shrink-0 text-night-400" />
              <span className="min-w-0 flex-1">
                <span className="block text-[14px] text-night-100">{account.label}</span>
                <span className="block truncate text-[12px] text-night-500">{account.detail}</span>
              </span>
              {active ? (
                <WorkingLabel label="Signing in" className="text-[12px] text-beacon-200" />
              ) : (
                <ArrowRight className="size-4 shrink-0 text-night-600 transition group-hover:translate-x-0.5 group-hover:text-night-300" />
              )}
            </button>
          );
        })}
      </div>
    </section>
  );
}
