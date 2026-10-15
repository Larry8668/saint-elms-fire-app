import { useState, type FormEvent } from 'react';
import { KeyRound, LogIn, ShieldCheck } from 'lucide-react';
import { describe } from '@/api/http';
import { verifyTwoFactor, type SignInOutcome } from '@/api/session';
import { ErrorPanel } from '@/components/error-panel';
import { Button } from '@/components/ui/button';
import { Input, Label, Panel } from '@/components/ui/primitives';
import { WorkingLabel } from '@/components/ui/loading';
import { useSession } from '@/state/session-context';
import { log } from '@/lib/log';

/**
 * Staff sign-in. There is no staff bootstrap and no admin token: a university owner runs
 * `staff:grant` at the server, and from there the person signs in with their own account.
 * A password alone is not a signed-in state — the shell only trusts a server session.
 */
export function SignInCard() {
  const { signIn, submitTwoFactor, refresh } = useSession();
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [code, setCode] = useState('');
  const [challenge, setChallenge] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(null);

  const finish = async (outcome: SignInOutcome) => {
    if (outcome.kind === 'two-factor') {
      log.info('admin_two_factor_required', { methods: outcome.methods.join(',') });
      setChallenge(true);
      setPassword('');
      return;
    }
    setBusy(true);
    // Evidence of a session, not of a form: re-read it before the shell claims anything.
    await refresh();
  };

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    if (busy) return;
    setBusy(true);
    setError(null);
    try {
      if (challenge) {
        await verifyTwoFactor(code.trim());
        setChallenge(false);
        setCode('');
        await refresh();
      } else {
        await finish(await signIn(email.trim(), password));
      }
    } catch (failure) {
      setError(failure);
    } finally {
      setBusy(false);
    }
  };

  return (
    <main className="mx-auto flex min-h-full w-full max-w-md flex-col justify-center px-5 py-12">
      <div className="mb-7">
        <p className="text-[11px] font-semibold tracking-[0.2em] text-beacon-300 uppercase">Saint Elms University</p>
        <h1 className="mt-2 font-display text-4xl text-night-100">Registrar</h1>
        <p className="mt-2 text-[14px] leading-6 text-night-400">
          Sign in with your staff account. You will be able to read student records and record admission decisions.
        </p>
      </div>

      <Panel className="p-6">
        <form onSubmit={submit} className="space-y-4">
          {challenge ? (
            <div>
              <Label htmlFor="totp">Authenticator code</Label>
              <Input
                id="totp"
                value={code}
                onChange={(event) => setCode(event.target.value)}
                inputMode="numeric"
                autoComplete="one-time-code"
                autoFocus
                required
              />
              <p className="mt-1.5 text-[12px] text-night-500">
                This account has two-factor authentication. Enter the current code from your authenticator.
              </p>
            </div>
          ) : (
            <>
              <div>
                <Label htmlFor="email">Email</Label>
                <Input
                  id="email"
                  type="email"
                  value={email}
                  onChange={(event) => setEmail(event.target.value)}
                  autoComplete="username"
                  autoFocus
                  required
                />
              </div>
              <div>
                <Label htmlFor="password">Password</Label>
                <Input
                  id="password"
                  type="password"
                  value={password}
                  onChange={(event) => setPassword(event.target.value)}
                  autoComplete="current-password"
                  required
                />
              </div>
            </>
          )}

          {error !== null && <ErrorPanel error={error} />}

          <Button type="submit" variant="primary" size="lg" className="w-full" loading={busy} disabled={busy}>
            {challenge ? <ShieldCheck aria-hidden /> : <LogIn aria-hidden />}
            {challenge ? 'Verify code' : 'Sign in'}
          </Button>
          {busy && <WorkingLabel label={challenge ? 'Verifying…' : 'Signing in…'} />}
        </form>

        {challenge && (
          <button
            type="button"
            className="mt-4 text-[12.5px] text-night-400 underline underline-offset-2 hover:text-night-200"
            onClick={() => {
              setChallenge(false);
              setError(null);
            }}
          >
            Use a different account
          </button>
        )}
      </Panel>

      <p className="mt-5 flex items-start gap-2 text-[12px] leading-5 text-night-500">
        <KeyRound className="mt-0.5 size-3.5 shrink-0" aria-hidden />
        Staff accounts are granted by a university owner with the <span className="font-mono">staff:grant</span> command on the
        server. There is no password reset from this screen — ask an owner to trigger a recovery email from the student record.
      </p>

      {(error !== null && (describe(error).kind === 'forbidden' || describe(error).kind === 'unauthenticated')) && (
        <p className="mt-3 text-[12px] text-gold-300">
          If your account is not staff yet, an owner has to grant the membership first.
        </p>
      )}
    </main>
  );
}