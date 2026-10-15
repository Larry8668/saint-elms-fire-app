import { useState } from 'react';
import { Field } from '../components/Field';
import { ModeLinks } from '../components/ModeLinks';
import { Notice } from '../components/Notice';
import { PortalShell } from '../components/PortalShell';
import { SubmitButton } from '../components/SubmitButton';
import type { PortalMode } from '../portal-modes';
import { registerAccount } from '../portal-api';
import { useSubmit } from '../use-submit';
import { SIGN_IN_LINKS } from './SignInView';

const PASSWORD_HINT = 'At least 8 characters.';

export function RegisterView({ go, onSent }: { go: (mode: PortalMode) => void; onSent: (email: string) => void }) {
  const [name, setName] = useState('');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const { busy, error, run } = useSubmit();

  return (
    <PortalShell
      eyebrow="Saint Elms University"
      title="Create your account"
      description="An account is not admission. Once your email is verified you can apply to the programme and wait for the registrar."
    >
      <form
        className="space-y-4"
        noValidate
        onSubmit={(event) => {
          event.preventDefault();
          void run(async () => {
            const address = email.trim();
            await registerAccount({ name: name.trim(), email: address, password });
            setPassword('');
            onSent(address);
          });
        }}
      >
        {error && <Notice tone="error">{error.message}</Notice>}
        <Field label="Full name" name="name" autoComplete="name" required maxLength={80} value={name} onChange={(e) => setName(e.target.value)} disabled={busy} />
        <Field label="Email address" type="email" name="email" autoComplete="email" required value={email} onChange={(e) => setEmail(e.target.value)} disabled={busy} />
        <Field
          label="Password"
          type="password"
          name="password"
          autoComplete="new-password"
          required
          minLength={8}
          hint={PASSWORD_HINT}
          value={password}
          onChange={(e) => setPassword(e.target.value)}
          disabled={busy}
        />
        <SubmitButton idle="Create account" busy={busy} busyLabel="Creating your account" />
      </form>
      <div className="mt-5 border-t border-white/[0.07] pt-4">
        <ModeLinks current="register" go={go} links={SIGN_IN_LINKS} />
      </div>
    </PortalShell>
  );
}