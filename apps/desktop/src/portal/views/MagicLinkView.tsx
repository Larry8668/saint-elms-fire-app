import { useState } from 'react';
import { Field } from '../components/Field';
import { ModeLinks } from '../components/ModeLinks';
import { Notice } from '../components/Notice';
import { PortalShell } from '../components/PortalShell';
import { SubmitButton } from '../components/SubmitButton';
import type { PortalMode } from '../portal-modes';
import { requestMagicLink } from '../portal-api';
import { useSubmit } from '../use-submit';
import { SIGN_IN_LINKS } from './SignInView';

export function MagicLinkView({ go, onSent }: { go: (mode: PortalMode) => void; onSent: (email: string) => void }) {
  const [email, setEmail] = useState('');
  const [name, setName] = useState('');
  const { busy, error, run } = useSubmit();

  return (
    <PortalShell eyebrow="Saint Elms University" title="Sign in with a link" description="We email you a one-time link instead of asking for a password. A new address creates an account automatically.">
      <form
        className="space-y-4"
        noValidate
        onSubmit={(event) => {
          event.preventDefault();
          void run(async () => {
            const address = email.trim();
            await requestMagicLink(address, name.trim() || undefined);
            onSent(address);
          });
        }}
      >
        {error && <Notice tone="error">{error.message}</Notice>}
        <Field label="Email address" type="email" name="email" autoComplete="email" required value={email} onChange={(e) => setEmail(e.target.value)} disabled={busy} />
        <Field
          label="Name (only if this address is new)"
          name="name"
          autoComplete="name"
          maxLength={80}
          hint="Used as your display name when the link creates your account."
          value={name}
          onChange={(e) => setName(e.target.value)}
          disabled={busy}
        />
        <SubmitButton idle="Email me a link" busy={busy} busyLabel="Sending your link" />
      </form>
      <div className="mt-5 border-t border-white/[0.07] pt-4">
        <ModeLinks current="magic-link" go={go} links={SIGN_IN_LINKS} />
      </div>
    </PortalShell>
  );
}