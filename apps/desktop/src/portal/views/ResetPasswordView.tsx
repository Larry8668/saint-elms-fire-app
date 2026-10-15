import { useState } from 'react';
import { Field } from '../components/Field';
import { Notice } from '../components/Notice';
import { PortalShell } from '../components/PortalShell';
import { SubmitButton } from '../components/SubmitButton';
import { resetPassword } from '../portal-api';
import { useSubmit } from '../use-submit';

export function ResetPasswordView({ token, errorCode, onDone, onStartOver }: { token: string | null; errorCode: string | null; onDone: () => void; onStartOver: () => void }) {
  const [password, setPassword] = useState('');
  const [confirm, setConfirm] = useState('');
  const [mismatch, setMismatch] = useState<string | null>(null);
  const { busy, error, run } = useSubmit();

  // A link without a token was never valid: the token lives in the query the server appended.
  if (!token || errorCode) {
    return (
      <PortalShell eyebrow="Saint Elms University" title="That link did not work" description="Password reset links are single-use and expire quickly. Ask for a fresh one.">
        <div className="space-y-4">
          <Notice tone="error">
            {errorCode ? `The university server rejected that link (${errorCode}).` : 'That link is missing its reset token.'}
          </Notice>
          <button
            type="button"
            onClick={onStartOver}
            className="inline-flex h-10 w-full cursor-pointer items-center justify-center rounded-xl bg-white/[0.06] text-sm font-medium text-night-100 transition hover:bg-white/[0.1]"
          >
            Request a new reset link
          </button>
        </div>
      </PortalShell>
    );
  }

  return (
    <PortalShell eyebrow="Saint Elms University" title="Choose a new password" description="Setting a new password signs out every other session on your devices.">
      <form
        className="space-y-4"
        noValidate
        onSubmit={(event) => {
          event.preventDefault();
          if (password !== confirm) {
            setMismatch('The two passwords do not match.');
            return;
          }
          setMismatch(null);
          void run(async () => {
            await resetPassword(token, password);
            setPassword('');
            setConfirm('');
            onDone();
          });
        }}
      >
        {error && <Notice tone="error">{error.message}</Notice>}
        <Field
          label="New password"
          type="password"
          name="new-password"
          autoComplete="new-password"
          required
          minLength={8}
          hint="At least 8 characters."
          value={password}
          onChange={(e) => setPassword(e.target.value)}
          disabled={busy}
        />
        <Field
          label="Confirm new password"
          type="password"
          name="confirm-password"
          autoComplete="new-password"
          required
          minLength={8}
          error={mismatch}
          value={confirm}
          onChange={(e) => setConfirm(e.target.value)}
          disabled={busy}
        />
        <SubmitButton idle="Set new password" busy={busy} busyLabel="Setting your password" />
      </form>
    </PortalShell>
  );
}