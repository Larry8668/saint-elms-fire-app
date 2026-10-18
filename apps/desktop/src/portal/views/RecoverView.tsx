import { useState } from 'react';
import { Field } from '../components/Field';
import { Notice } from '../components/Notice';
import { PortalShell } from '../components/PortalShell';
import { SubmitButton } from '../components/SubmitButton';
import { requestPasswordReset, mailOutcome, type MailOutcome } from '../portal-api';
import { useSubmit } from '../use-submit';

export function RecoverView({ go, onSent }: { go: (mode: 'sign-in') => void; onSent: (email: string, outcome: MailOutcome) => void }) {
  const [email, setEmail] = useState('');
  const { busy, error, run } = useSubmit();

  return (
    <PortalShell eyebrow="Saint Elms University" title="Reset your password" description="We email a single-use link that brings you back here to choose a new password.">
      <form
        className="space-y-4"
        noValidate
        onSubmit={(event) => {
          event.preventDefault();
          void run(async () => {
            const address = email.trim();
            const outcome = await mailOutcome(() => requestPasswordReset(address));
            onSent(address, outcome);
          });
        }}
      >
        {error && <Notice tone="error">{error.message}</Notice>}
        <Field label="Email address" type="email" name="email" autoComplete="email" required value={email} onChange={(e) => setEmail(e.target.value)} disabled={busy} />
        <SubmitButton idle="Send the reset link" busy={busy} busyLabel="Sending the reset link" />
      </form>
      <div className="mt-5 border-t border-white/[0.07] pt-4 text-center text-[13px]">
        <button type="button" onClick={() => go('sign-in')} className="cursor-pointer text-night-400 underline decoration-white/15 underline-offset-4 hover:text-beacon-300">
          Back to sign in
        </button>
      </div>
    </PortalShell>
  );
}