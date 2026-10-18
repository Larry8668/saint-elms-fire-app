import { useState } from 'react';
import { Button } from '@/components/ui/button';
import { Notice } from '../components/Notice';
import { PortalShell } from '../components/PortalShell';
import { WorkingLabel } from '@/components/ui/loading';
import { MAIL_COPY, type MailReason } from '../portal-copy';
import { mailOutcome, requestMagicLink, requestPasswordReset, sendVerificationEmail, type MailOutcome } from '../portal-api';
import { useSubmit } from '../use-submit';

/**
 * Answers "we sent you something" and offers the resend. It never claims the student has an
 * account: the reset copy reads the same whether or not the address is registered.
 */
export function CheckEmailView({ email, reason, initialOutcome = 'sent', onBack, onChangeEmail }: { email: string; reason: MailReason; initialOutcome?: MailOutcome; onBack: () => void; onChangeEmail: () => void }) {
  const { busy, error, run } = useSubmit();
  const [outcome, setOutcome] = useState<MailOutcome>(initialOutcome);
  const [resent, setResent] = useState(false);
  const failed = outcome === 'failed';
  const copy = MAIL_COPY[reason];

  return (
    <PortalShell eyebrow="Saint Elms University" title={copy.title}>
      <div className="space-y-4">
        {failed ? (
          <Notice tone="error" title="We could not send the email">
            The university could not deliver a message to {email}. Nothing was sent. Use Send again, or try once more in a few minutes.
          </Notice>
        ) : (
          <Notice tone="success" title={`Sent to ${email}`}>
            {copy.body}
          </Notice>
        )}
        {resent && !failed && <Notice tone="info">A fresh link is on its way. The earlier link stays valid until it is used or it expires.</Notice>}
        {error && <Notice tone="error">{error.message}</Notice>}
        <Button variant="secondary" className="w-full" disabled={busy || (resent && !failed)} onClick={() => void run(async () => {
          const next = await mailOutcome(async () => {
            if (reason === 'reset') await requestPasswordReset(email);
            else if (reason === 'verify') await sendVerificationEmail(email);
            else await requestMagicLink(email);
          });
          setOutcome(next);
          setResent(next === 'sent');
        })}>
          {busy ? <WorkingLabel label="Sending" /> : failed ? 'Send again' : copy.resend}
        </Button>
        <div className="flex flex-col items-center gap-2 pt-1 text-[13px]">
          <button type="button" onClick={onBack} className="cursor-pointer text-night-300 underline decoration-white/15 underline-offset-4 hover:text-beacon-300">
            Back to sign in
          </button>
          <button type="button" onClick={onChangeEmail} className="cursor-pointer text-night-500 underline decoration-white/10 underline-offset-4 hover:text-night-300">
            Use a different email address
          </button>
        </div>
      </div>
    </PortalShell>
  );
}