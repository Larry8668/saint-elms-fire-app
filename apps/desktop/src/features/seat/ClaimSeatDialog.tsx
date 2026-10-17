import { CheckCircle2, Circle, Cloud, KeyRound, RotateCcw, XCircle } from 'lucide-react';
import { useEffect, useMemo, useRef, useState } from 'react';
import { Button } from '@/components/ui/button';
import { PixelLoader } from '@/components/ui/loading';
import { Dialog } from '@/components/ui/overlays';
import { Label } from '@/components/ui/primitives';
import { cn } from '@/lib/cn';
import { createSeatClient, inTauri } from '@/lib/instabox';
import { log } from '@/lib/log';
import { writeSeat } from '@/lib/seat';
import { UNI_URL } from '@/lib/uni-url';
import { CLAIM_STEPS, ClaimRunner, localProgressStore, STEP_LABEL, type ClaimView } from './claim';

/** The app version a seat runs. Release builds pin it; dev builds follow main. */
const SEAT_REF = ((import.meta.env.VITE_SEAT_REF as string | undefined) ?? 'main').trim();
/** A localhost uni is unreachable from a cloud box, so it is never offered as the default. */
const DEFAULT_UNI = /^https:\/\//.test(UNI_URL) ? UNI_URL : '';
const URL_PATTERN = /^https?:\/\/[A-Za-z0-9.-]+(:\d{1,5})?(\/[A-Za-z0-9._~/-]*)?$/;

export function ClaimSeatDialog({ open, onOpenChange }: { open: boolean; onOpenChange: (open: boolean) => void }) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange} title="Claim your seat" description="Your engine, vault and models on a cloud machine in your own Instabox account.">
      {inTauri() ? <ClaimFlow /> : <BrowserOnly />}
    </Dialog>
  );
}

function BrowserOnly() {
  return (
    <div className="space-y-3 text-[13.5px] leading-6 text-night-300">
      <p>Set up your seat from the Saint Elms Fire desktop app.</p>
      <p>
        Instabox does not accept calls from web pages, and your Instabox key belongs in your computer&apos;s keychain, not in a browser tab. Once the desktop app has set
        up your seat, you can open it from any browser at its own address.
      </p>
    </div>
  );
}

function ClaimFlow() {
  const client = useMemo(() => createSeatClient(), []);
  const [view, setView] = useState<ClaimView | null>(null);
  const [hasKey, setHasKey] = useState<boolean | null>(null);
  const [key, setKey] = useState('');
  const [uniUrl, setUniUrl] = useState(DEFAULT_UNI);
  const [busy, setBusy] = useState(false);
  const runner = useRef<ClaimRunner | null>(null);

  if (!runner.current) {
    runner.current = new ClaimRunner({
      client,
      store: localProgressStore(),
      remember: (seat) => writeSeat(seat),
      onChange: setView,
    });
  }

  useEffect(() => {
    setView(runner.current!.state);
    client
      .hasKey()
      .then(setHasKey)
      .catch((error) => {
        log.warn('seat_key_check_failed', { code: (error as { code?: string }).code });
        setHasKey(false);
      });
    return () => runner.current?.cancel();
  }, [client]);

  const uniOk = URL_PATTERN.test(uniUrl.trim());
  const keyNeeded = hasKey === false && !key.trim();

  const go = async (retry: boolean) => {
    if (!runner.current || busy) return;
    setBusy(true);
    const config = { machineName: 'sef-seat', gitRef: SEAT_REF, uniUrl: uniUrl.trim().replace(/\/+$/, ''), ...(key.trim() ? { key: key.trim() } : {}) };
    try {
      const result = retry ? await runner.current.retry(config) : await runner.current.run(config);
      if (key.trim() && result.steps.key === 'done') {
        setKey('');
        setHasKey(true);
      }
      log.info(result.complete ? 'seat_claimed' : 'seat_claim_stopped', { step: result.current, code: result.failure?.code });
    } finally {
      setBusy(false);
    }
  };

  if (!view) return null;
  const started = CLAIM_STEPS.some((s) => view.steps[s] !== 'pending');

  if (view.complete) {
    return (
      <div className="space-y-4">
        <Checklist view={view} />
        <p className="text-[13.5px] text-night-300">
          Your seat is ready at <span className="font-mono text-night-100">{view.seatUrl}</span>. Sign in there with your university account.
        </p>
        <Button variant="primary" className="w-full" onClick={() => window.location.reload()}>
          Continue to sign-in
        </Button>
      </div>
    );
  }

  return (
    <div className="space-y-5">
      {!started && (
        <ul className="space-y-1.5 text-[12.5px] leading-5 text-night-400">
          <li>A seat needs a network connection; there is no offline mode on a hosted seat. Vault export keeps a copy on any device.</li>
          <li>The machine lives in your Instabox account. The university cannot reach it; the hosting provider, like any cloud host, technically can.</li>
          <li>Setup takes about ten minutes the first time. You can close this and come back: it picks up where it stopped.</li>
        </ul>
      )}

      <div className="grid gap-3">
        <div>
          <Label htmlFor="seat-key">Instabox API key</Label>
          {hasKey ? (
            <p className="mt-1 flex items-center gap-2 text-[12.5px] text-night-400">
              <KeyRound className="size-3.5" /> Saved in your system keychain.
              <button type="button" className="cursor-pointer text-night-300 underline underline-offset-2" onClick={() => setHasKey(false)}>
                Replace
              </button>
            </p>
          ) : (
            <input
              id="seat-key"
              type="password"
              autoComplete="off"
              spellCheck={false}
              placeholder="ibk_…"
              value={key}
              onChange={(e) => setKey(e.target.value)}
              className="mt-1 h-10 w-full rounded-xl border border-white/10 bg-white/[0.03] px-3 font-mono text-[13px] text-night-100 outline-none focus:border-beacon-400/50"
            />
          )}
          <p className="mt-1 text-[11.5px] text-night-500">Create one under API Keys in the Instabox dashboard (Full access). It is stored in your keychain and sent only to Instabox.</p>
        </div>
        <div>
          <Label htmlFor="seat-uni">University server</Label>
          <input
            id="seat-uni"
            type="url"
            placeholder="https://uni.example.edu"
            value={uniUrl}
            onChange={(e) => setUniUrl(e.target.value)}
            className="mt-1 h-10 w-full rounded-xl border border-white/10 bg-white/[0.03] px-3 text-[13px] text-night-100 outline-none focus:border-beacon-400/50"
          />
        </div>
      </div>

      {started && <Checklist view={view} />}

      {view.failure && (
        <div role="alert" className="rounded-xl border border-rose-400/25 bg-rose-400/10 p-3 text-[12.5px] text-rose-300">
          {view.failure.message}
        </div>
      )}

      {view.bootstrap && (view.current === 'bootstrap' || view.failure?.retryFrom === 'bootstrap') && view.bootstrap.logTail && (
        <details className="rounded-xl border border-white/[0.06] bg-black/20 p-3">
          <summary className="cursor-pointer text-[12px] text-night-400">Setup log on the box</summary>
          <pre className="mt-2 max-h-48 overflow-auto font-mono text-[11px] leading-4 whitespace-pre-wrap text-night-400">{view.bootstrap.logTail}</pre>
        </details>
      )}

      <Button
        variant="primary"
        className="w-full"
        loading={busy}
        disabled={keyNeeded || !uniOk || hasKey === null}
        onClick={() => void go(Boolean(view.failure))}
      >
        {view.failure ? (
          <>
            <RotateCcw /> Retry
          </>
        ) : (
          <>
            <Cloud /> {started ? 'Continue' : 'Set up my seat'}
          </>
        )}
      </Button>
    </div>
  );
}

function Checklist({ view }: { view: ClaimView }) {
  return (
    <ol className="space-y-2">
      {CLAIM_STEPS.map((step) => {
        const status = view.steps[step];
        return (
          <li key={step} className="flex items-start gap-2.5 text-[13px]">
            <span className="mt-0.5">
              {status === 'done' ? (
                <CheckCircle2 className="size-4 text-emerald-400" />
              ) : status === 'error' ? (
                <XCircle className="size-4 text-rose-400" />
              ) : status === 'running' ? (
                <PixelLoader className="text-beacon-300" />
              ) : (
                <Circle className="size-4 text-night-600" />
              )}
            </span>
            <span className="min-w-0">
              <span className={cn(status === 'pending' ? 'text-night-500' : 'text-night-100')}>{STEP_LABEL[step]}</span>
              {status === 'running' && view.detail && <span className="block text-[11.5px] text-night-400">{view.detail}</span>}
            </span>
          </li>
        );
      })}
    </ol>
  );
}
