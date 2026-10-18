import { useState } from 'react';
import { Field } from '../components/Field';
import { ModeLinks } from '../components/ModeLinks';
import { Notice } from '../components/Notice';
import { PortalShell } from '../components/PortalShell';
import { SubmitButton } from '../components/SubmitButton';
import type { Banner } from '../portal-copy';
import type { PortalMode } from '../portal-modes';
import { signIn } from '../portal-api';
import { useSubmit } from '../use-submit';
import type { DemoAccount } from '@/lib/demo-accounts';
import { TryDemoSection } from './TryDemoSection';

export const SIGN_IN_LINKS: Array<{ mode: PortalMode; label: string }> = [
  { mode: 'register', label: 'Create an account' },
  { mode: 'magic-link', label: 'Email me a sign-in link' },
  { mode: 'recover', label: 'Forgot your password' },
];

export function SignInView({
  onAuthenticated,
  go,
  banner,
  demo = false,
  onSelfServe,
}: {
  onAuthenticated: () => void;
  go: (mode: PortalMode) => void;
  banner: Banner | null;
  demo?: boolean;
  /** Self-serve demo builds: leads with "Try the demo"; called once a persona is signed in. */
  onSelfServe?: (persona: DemoAccount) => void;
}) {
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const { busy, error, run } = useSubmit();

  return (
    <PortalShell eyebrow="Saint Elms University" title="Sign in" description="Your account and your place in the programme are both kept by the university.">
      {onSelfServe && <TryDemoSection onSignedIn={onSelfServe} />}
      <form
        className="space-y-4"
        noValidate
        onSubmit={(event) => {
          event.preventDefault();
          void run(async () => {
            await signIn({ email: email.trim(), password });
            setPassword('');
            onAuthenticated();
          });
        }}
      >
        {banner && <Notice tone={banner.tone} title={banner.title}>{banner.body}</Notice>}
        {error && <Notice tone="error">{error.message}</Notice>}
        <Field label="Email address" type="email" name="email" autoComplete="email" required value={email} onChange={(e) => setEmail(e.target.value)} disabled={busy} />
        <Field label="Password" type="password" name="password" autoComplete="current-password" required value={password} onChange={(e) => setPassword(e.target.value)} disabled={busy} />
        <SubmitButton idle="Sign in" busy={busy} busyLabel="Signing in" />
      </form>
      <div className="mt-5 border-t border-white/[0.07] pt-4">
        <ModeLinks current="sign-in" go={go} links={SIGN_IN_LINKS} />
      </div>
      {demo && (
        <div className="mt-4 border-t border-white/[0.07] pt-4">
          <ModeLinks current="sign-in" go={go} links={[{ mode: 'demo-sign-in', label: 'Sign in as a demo student' }]} />
        </div>
      )}
    </PortalShell>
  );
}