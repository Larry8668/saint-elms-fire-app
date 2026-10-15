import { AlertTriangle, Clock, Lock, RefreshCw, WifiOff } from 'lucide-react';
import type { ReactNode } from 'react';
import { describe, type ErrorKind } from '@/api/http';
import { Button } from './ui/button';
import { Panel } from './ui/primitives';

/**
 * Every failure in this app is shown as a state, never as a toast that vanishes: a stale
 * record, a wrong role and an unreachable server each need a different next step from the
 * person doing the registrar work.
 */
const PRESENTATION: Record<ErrorKind, { icon: typeof AlertTriangle; title: string; hint: string; tone: string }> = {
  conflict: {
    icon: RefreshCw,
    title: 'This record changed while you were looking at it',
    hint: 'Someone else saved first. Reload the record to see the current version, then apply your change again — nothing was overwritten.',
    tone: 'text-ember-300 border-ember-400/30 bg-ember-500/10',
  },
  reauthentication: {
    icon: Clock,
    title: 'Your session is too old for this change',
    hint: 'Sensitive changes need a sign-in from the last 30 minutes. Re-enter your password above, then submit the change again.',
    tone: 'text-gold-300 border-gold-400/30 bg-gold-400/10',
  },
  forbidden: {
    icon: Lock,
    title: 'Your role does not allow this',
    hint: 'The university refused this action for your account. An owner has to do it.',
    tone: 'text-gold-300 border-gold-400/30 bg-gold-400/10',
  },
  unauthenticated: {
    icon: Lock,
    title: 'Your session has ended',
    hint: 'Sign in again to continue. Nothing you typed has been sent.',
    tone: 'text-gold-300 border-gold-400/30 bg-gold-400/10',
  },
  network: {
    icon: WifiOff,
    title: 'The university server could not be reached',
    hint: 'Check your connection and try again. Nothing was saved.',
    tone: 'text-rose-400 border-rose-400/30 bg-rose-400/10',
  },
  unavailable: {
    icon: AlertTriangle,
    title: 'This service is unavailable right now',
    hint: 'The university server refused to answer. Try again shortly.',
    tone: 'text-rose-400 border-rose-400/30 bg-rose-400/10',
  },
  'not-found': {
    icon: AlertTriangle,
    title: 'That record no longer exists',
    hint: 'It may have been erased, or the link is out of date.',
    tone: 'text-night-300 border-white/10 bg-white/[0.04]',
  },
  invalid: {
    icon: AlertTriangle,
    title: 'The university rejected that change',
    hint: 'Adjust the details and submit again.',
    tone: 'text-ember-300 border-ember-400/30 bg-ember-500/10',
  },
  contract: {
    icon: AlertTriangle,
    title: 'This app cannot read the response',
    hint: 'The server answered with a shape this app does not understand. Nothing was changed.',
    tone: 'text-rose-400 border-rose-400/30 bg-rose-400/10',
  },
  unknown: {
    icon: AlertTriangle,
    title: 'Something went wrong',
    hint: 'Try again. If it keeps happening, tell an owner.',
    tone: 'text-rose-400 border-rose-400/30 bg-rose-400/10',
  },
};

export function ErrorPanel({
  error,
  onRetry,
  retryLabel = 'Try again',
  children,
}: {
  error: unknown;
  onRetry?: () => void;
  retryLabel?: string;
  /** Extra copy or a specific next step, e.g. a "Reload record" button on a conflict. */
  children?: ReactNode;
}) {
  const { kind, code, message } = describe(error);
  const view = PRESENTATION[kind];
  const Icon = view.icon;

  return (
    <Panel className={`flex items-start gap-3 border p-4 ${view.tone}`} role="alert">
      <Icon className="mt-0.5 size-4 shrink-0" aria-hidden />
      <div className="min-w-0 flex-1">
        <p className="text-sm font-medium">{view.title}</p>
        <p className="mt-1 text-[13px] leading-5 text-night-300">{view.hint}</p>
        <p className="mt-1.5 text-[13px] leading-5 text-night-200">{message}</p>
        {code && code !== 'unknown_error' && <p className="mt-1 font-mono text-[11px] text-night-500">{code}</p>}
        {children}
      </div>
      {onRetry && (
        <Button variant="outline" size="sm" onClick={onRetry} className="shrink-0">
          <RefreshCw aria-hidden />
          {retryLabel}
        </Button>
      )}
    </Panel>
  );
}