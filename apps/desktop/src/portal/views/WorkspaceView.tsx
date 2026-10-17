import { Check, Circle, RotateCcw, X } from 'lucide-react';
import { useCallback, useEffect, useRef, useState } from 'react';
import type { SessionStepStatus } from '@sef/shared';
import { Button } from '@/components/ui/button';
import { ConnectingScene } from '@/components/ui/connecting-scene';
import { WorkingLabel } from '@/components/ui/loading';
import { Eyebrow, Panel } from '@/components/ui/primitives';
import { cn } from '@/lib/cn';
import { log } from '@/lib/log';
import { Notice } from '../components/Notice';
import { endWorkspace, getWorkspace, PortalError, probeWorkspaceHealth, startWorkspace } from '../portal-api';
import { handoffUrl, runWorkspaceFlow, type FlowFailure, type WorkspaceFlow } from '../workspace/session-flow';

const FAILURE_COPY: Record<FlowFailure, { title: string; body: string }> = {
  unavailable: { title: 'Hosted workspaces are not available', body: 'This university server has no hosted workspaces set up. Use the desktop app instead.' },
  unapproved: { title: 'Your account cannot open a workspace', body: 'Only approved, enrolled students can. Refresh your status, or contact the registrar.' },
  signed_out: { title: 'You were signed out', body: 'Sign in again to open your workspace.' },
  spawn_failed: { title: 'We could not start your workspace', body: 'Something went wrong on the university’s side. Nothing of yours was lost. Try again.' },
  ended: { title: 'Your workspace ended', body: 'It was closed before it finished starting (signed out elsewhere, or ended by staff). Open a new one.' },
  network: { title: 'Lost contact with the university', body: 'Check your connection, then try again.' },
  unreachable: { title: 'Your workspace is not answering this browser', body: 'The university started it, but it did not answer here within a minute and a half. Try again.' },
  sync_error: { title: 'Your notes could not be restored', body: 'Your workspace started but could not load your notes from university storage. Try again; if it keeps failing, contact support.' },
  timeout: { title: 'Starting is taking far too long', body: 'Try again in a few minutes.' },
};

/** The web app, when it is hosted apart from the VM (set on the portal build); unset = the VM serves its own UI. */
const APP_URL = import.meta.env.VITE_APP_URL as string | undefined;

const CONNECT_STEP = (restoring: boolean): SessionStepStatus => ({
  name: 'health',
  label: restoring ? 'Restoring your notes' : 'Connecting this browser',
  status: 'active',
});

/** The real step the university reports, as the waiting scene's primary line; null once it failed. */
function realStep(flow: WorkspaceFlow, steps: SessionStepStatus[]): string | undefined | null {
  switch (flow.phase) {
    case 'requesting':
      return 'Asking the university for a workspace';
    case 'queued':
      return 'Waiting for a free workspace';
    case 'previous-stopping':
      return 'Saving your previous workspace';
    case 'spawning':
    case 'connecting':
      return steps.find((s) => s.status === 'active')?.label;
    case 'ready':
      return 'Opening your workspace';
    case 'failed':
      return null;
  }
}

/** "Starting your workspace…": the real steps from the university, then the hand-off. */
export function WorkspaceView({ onBack }: { onBack: () => void }) {
  const [flow, setFlow] = useState<WorkspaceFlow>({ phase: 'requesting' });
  const [startedAt, setStartedAt] = useState(() => Date.now());
  const [cancelling, setCancelling] = useState(false);
  const [cancelError, setCancelError] = useState<string | null>(null);
  const controller = useRef<AbortController | null>(null);

  const run = useCallback(() => {
    controller.current?.abort();
    const abort = new AbortController();
    controller.current = abort;
    setStartedAt(Date.now());
    void runWorkspaceFlow(
      {
        start: startWorkspace,
        status: getWorkspace,
        probe: probeWorkspaceHealth,
        sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
        now: () => Date.now(),
      },
      setFlow,
      abort.signal,
    ).then((final) => {
      if (abort.signal.aborted) return;
      if (final.phase === 'ready') {
        log.info('workspace_handoff', {});
        window.location.assign(handoffUrl(final.url, APP_URL));
      } else if (final.phase === 'failed') {
        log.warn('workspace_failed', { reason: final.reason });
      }
    });
  }, []);

  useEffect(() => {
    run();
    return () => controller.current?.abort();
  }, [run]);

  const cancel = async () => {
    setCancelling(true);
    setCancelError(null);
    try {
      await endWorkspace();
      controller.current?.abort();
      onBack();
    } catch (error) {
      // Do not claim the lease ended when the university did not confirm it.
      setCancelError(error instanceof PortalError ? error.message : 'Could not cancel. Try again.');
    } finally {
      setCancelling(false);
    }
  };

  const steps =
    flow.phase === 'spawning' || flow.phase === 'queued'
      ? flow.steps
      : flow.phase === 'connecting'
        ? [...flow.steps.map((s) => ({ ...s, status: 'done' as const })), CONNECT_STEP(flow.restoring)]
        : [];
  const step = realStep(flow, steps);

  return (
    <div className="mx-auto w-full max-w-xl px-5 py-8 sm:px-8 sm:py-12">
      <Eyebrow className="mb-1.5">Saint Elms University</Eyebrow>
      <h1 className="font-display text-2xl text-night-100 sm:text-3xl">{flow.phase === 'failed' ? FAILURE_COPY[flow.reason].title : 'Starting your workspace…'}</h1>
      <p className="mt-1 text-[13px] text-night-500">Your workspace runs on the university&apos;s servers; your notes are saved to your university storage.</p>

      <Panel className="mt-6 p-5 sm:p-7" aria-live="polite">
        {step !== null && <ConnectingScene step={step} startedAt={startedAt} className={flow.phase === 'requesting' || flow.phase === 'ready' ? undefined : 'mb-5'} />}

        {flow.phase === 'queued' && (
          <div className="space-y-3">
            <p className="text-[14px] leading-6 text-night-300">
              {flow.position === null
                ? 'All workspaces are in use right now. You are in the queue.'
                : flow.position === 1
                  ? 'All workspaces are in use right now. You are next in the queue.'
                  : `All workspaces are in use right now. You are number ${flow.position} in the queue.`}{' '}
              This page carries on by itself when one frees up.
            </p>
          </div>
        )}

        {flow.phase === 'previous-stopping' && (
          <div className="space-y-3">
            <p className="text-[14px] leading-6 text-night-300">Your last workspace is saving your notes before it shuts down. A new one starts right after, so nothing is restored from an old copy.</p>
          </div>
        )}

        {(flow.phase === 'spawning' || flow.phase === 'connecting') && (
          <div className="space-y-4">
            {flow.phase === 'spawning' && flow.waitingForCapacity && (
              <Notice tone="info">The university&apos;s machine provider is busy. Still trying; this can take a few minutes.</Notice>
            )}
            <StepList steps={steps} />
          </div>
        )}

        {flow.phase === 'failed' && (
          <div className="space-y-4">
            <Notice tone="error">{FAILURE_COPY[flow.reason].body}</Notice>
            <div className="flex flex-wrap gap-2">
              {flow.retryable && (
                <Button variant="primary" onClick={run}>
                  <RotateCcw /> Try again
                </Button>
              )}
              <Button variant="ghost" onClick={onBack}>
                Back
              </Button>
            </div>
          </div>
        )}
      </Panel>

      {(flow.phase === 'queued' || flow.phase === 'spawning') && (
        <div className="mt-4 flex flex-col items-center gap-2">
          <Button size="sm" variant="ghost" loading={cancelling} onClick={() => void cancel()}>
            <X /> Cancel
          </Button>
          {cancelError && <p className="text-[12.5px] text-rose-400">{cancelError}</p>}
        </div>
      )}
    </div>
  );
}

function StepList({ steps }: { steps: SessionStepStatus[] }) {
  return (
    <ol className="space-y-2.5">
      {steps.map((step) => (
        <li key={`${step.name}-${step.label}`} className={cn('flex items-center gap-3 text-[14px]', step.status === 'pending' ? 'text-night-500' : 'text-night-200')}>
          {step.status === 'active' ? (
            // WorkingLabel carries its own PixelLoader, in the same column as the icons. The scene above shows the elapsed time.
            <WorkingLabel label={step.label} className="gap-3 text-[14px] text-beacon-200" />
          ) : (
            <>
              <span className="grid size-3.5 shrink-0 place-items-center">
                {step.status === 'done' ? <Check className="size-4 text-aurora-300" /> : step.status === 'failed' ? <X className="size-4 text-rose-400" /> : <Circle className="size-3 text-night-600" />}
              </span>
              <span>{step.label}</span>
            </>
          )}
        </li>
      ))}
    </ol>
  );
}
