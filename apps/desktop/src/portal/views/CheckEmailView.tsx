import { useState } from 'react';
import { Button } from '@/components/ui/button';
import { Notice } from '../components/Notice';
import { PortalShell } from '../components/PortalShell';
import { WorkingLabel } from '@/components/ui/loading';
import { MAIL_COPY, type MailReason } from '../portal-copy';
import { requestMagicLink, requestPasswordReset, sendVerificationEmail } from '../portal-api';
import { useSubmit } from '../use-submit';

/**
 * Answers "we sent you something" and offers the resend. It never claims the student has an
 * account: the reset copy reads the same whether or not the address is registered.
 */
export function CheckEmailView({ email, reason, onBack, onChangeEmail }: { email: string; reason: MailReason; onBack: () => void; onChangeEmail: () => void }) {
  const { busy, error, run } = useSubmit();
  const [sent, setSent] = useState(false);
  const copy = MAIL_COPY[reason];

  return (
    <PortalShell eyebrow="Saint Elms University" title={copy.title}>
      <div className="space-y-4">
        <Notice tone="success" title={`Sent to ${email}`}>
          {copy.body}
        </Notice>
        {sent && <Notice tone="info">A fresh link is on its way. The earlier link stays valid until it is used or it expires.</Notice>}
        {error && <Notice tone="error">{error.message}</Notice>}
        <Button variant="secondary" className="w-full" disabled={busy || sent} onClick={() => void run(async () => {
          if (reason === 'reset') await requestPasswordReset(email);
          else if (reason === 'verify') await sendVerificationEmail(email);
          else await requestMagicLink(email);
          setSent(true);
        })}>
          {busy ? <WorkingLabel label="Sending" /> : copy.resend}
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