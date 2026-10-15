import { useState, type FormEvent } from 'react';
import { Clock } from 'lucide-react';
import { ErrorPanel } from '@/components/error-panel';
import { Button } from '@/components/ui/button';
import { Input, Label, Panel } from '@/components/ui/primitives';
import { WorkingLabel } from '@/components/ui/loading';
import { useSession } from '@/state/session-context';

/**
 * The university gates sensitive staff mutations on a session younger than 30 minutes and
 * answers `reauthentication_required` when it is too old. This banner is that state: the
 * person signs in again and then resubmits their change themselves. Nothing is replayed for
 * them, because the record they were looking at may have moved while they were away.
 */
export function ReauthBanner() {
  const { reauthRequired, clearReauth, signIn, submitTwoFactor, refresh, me } = useSession();
  const [password, setPassword] = useState('');
  const [code, setCode] = useState('');
  const [challenge, setChallenge] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const [done, setDone] = useState(false);

  if (!reauthRequired) return null;

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    if (busy) return;
    setBusy(true);
    setError(null);
    try {
      if (challenge) {
        await submitTwoFactor(code.trim());
      } else {
        const outcome = await signIn(me?.user.email ?? '', password);
        if (outcome.kind === 'two-factor') {
          setChallenge(true);
          setBusy(false);
          return;
        }
      }
      await refresh();
      setDone(true);
      setPassword('');
      setCode('');
    } catch (failure) {
      setError(failure);
    } finally {
      setBusy(false);
    }
  };

  return (
    <Panel className="border-gold-400/30 bg-gold-400/[0.07] p-5">
      <div className="flex items-start gap-3">
        <Clock className="mt-0.5 size-4 shrink-0 text-gold-300" aria-hidden />
        <div className="min-w-0 flex-1">
          <p className="text-sm font-medium text-gold-300">Sign in again to make this change</p>
          <p className="mt-1 text-[13px] leading-5 text-night-300">
            {done
              ? 'You are signed in again. Submit your change once more — nothing was sent while your session was stale.'
              : 'Sensitive changes need a session from the last 30 minutes. Your change has not been sent.'}
          </p>

          {!done && me && (
            <form onSubmit={submit} className="mt-3.5 flex flex-col gap-2.5 sm:flex-row sm:items-end">
              <div className="min-w-0 flex-1">
                <Label htmlFor="reauth-password">{challenge ? 'Authenticator code' : 'Password'}</Label>
                {challenge ? (
                  <Input
                    id="reauth-password"
                    value={code}
                    onChange={(event) => setCode(event.target.value)}
                    inputMode="numeric"
                    autoComplete="one-time-code"
                    required
                  />
                ) : (
                  <Input
                    id="reauth-password"
                    type="password"
                    value={password}
                    onChange={(event) => setPassword(event.target.value)}
                    autoComplete="current-password"
                    required
                  />
                )}
              </div>
              <Button type="submit" variant="primary" size="md" loading={busy} disabled={busy}>
                Re-authenticate
              </Button>
            </form>
          )}

          {error !== null && (
            <div className="mt-3">
              <ErrorPanel error={error} />
            </div>
          )}
          {busy && !challenge && <WorkingLabel label="Signing in…" className="mt-2" />}

          <button
            type="button"
            className="mt-3 text-[12.5px] text-night-400 underline underline-offset-2 hover:text-night-200"
            onClick={clearReauth}
          >
            Dismiss and leave this change unsent
          </button>
        </div>
      </div>
    </Panel>
  );
}