import { CircleCheck, CircleSlash, Clock, Cloud, LogOut, RefreshCw, ShieldAlert } from 'lucide-react';
import type { AdmissionMe } from '@sef/shared';
import { Button } from '@/components/ui/button';
import { WorkingLabel } from '@/components/ui/loading';
import { Badge, Eyebrow, Panel, Skeleton, SkeletonText } from '@/components/ui/primitives';
import { admissionState, type AdmissionState } from '../admission-state';
import type { Banner } from '../portal-copy';
import { Notice } from '../components/Notice';
import { ProgrammeApply } from '../components/ProgrammeApply';

export function AdmissionView({
  me,
  banner,
  refreshing,
  onRefresh,
  onSignOut,
  onOpenWorkspace,
}: {
  me: AdmissionMe;
  banner: Banner | null;
  refreshing: boolean;
  onRefresh: () => void;
  onSignOut: () => void;
  onOpenWorkspace: () => void;
}) {
  const state = admissionState(me);

  return (
    <div className="mx-auto w-full max-w-xl px-5 py-8 sm:px-8 sm:py-12">
      <header className="mb-6 flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0">
          <Eyebrow className="mb-1.5">Saint Elms University</Eyebrow>
          <h1 className="truncate font-display text-2xl text-night-100 sm:text-3xl">{me.user.name || me.user.email}</h1>
          <p className="mt-1 truncate text-[13px] text-night-500">{me.user.email}</p>
        </div>
        <Button size="sm" variant="ghost" onClick={onSignOut} disabled={refreshing}>
          <LogOut />
          Sign out
        </Button>
      </header>

      {banner && <div className="mb-4"><Notice tone={banner.tone} title={banner.title}>{banner.body}</Notice></div>}

      <Panel className="p-5 sm:p-7">{refreshing ? <AdmissionSkeleton /> : <AdmissionBody state={state} me={me} onApplied={onRefresh} onOpenWorkspace={onOpenWorkspace} />}</Panel>

      <div className="mt-4 flex justify-center">
        <Button size="sm" variant="ghost" disabled={refreshing} onClick={onRefresh}>
          {refreshing ? <WorkingLabel label="Checking your status" /> : <><RefreshCw />Refresh status</>}
        </Button>
      </div>
    </div>
  );
}

function AdmissionBody({ state, me, onApplied, onOpenWorkspace }: { state: AdmissionState; me: AdmissionMe; onApplied: () => void; onOpenWorkspace: () => void }) {
  if (state === 'not-applied') {
    return (
      <div className="space-y-5">
        <p className="text-[14px] leading-6 text-night-300">Your account is ready. Apply to the programme to be reviewed by the registrar.</p>
        <ProgrammeApply email={me.user.email} onApplied={onApplied} />
      </div>
    );
  }
  if (state === 'pending') {
    return (
      <Notice tone="info" title="Your application is with the registrar">
        <span className="flex gap-2">
          <Clock className="mt-0.5 size-4 shrink-0" />
          <span>
            Nothing more to do here. Use <strong>Refresh status</strong> below once you have heard back — the registrar is the only party that can move this on.
          </span>
        </span>
      </Notice>
    );
  }
  if (state === 'approved') {
    return (
      <div className="space-y-5">
        <Notice tone="success" title="You are enrolled">
          <span className="flex gap-2">
            <CircleCheck className="mt-0.5 size-4 shrink-0" />
            <span>The registrar has approved your place{me.enrolment?.cohortId ? ` in cohort ${me.enrolment.cohortId}` : ''}.</span>
          </span>
        </Notice>
        <div className="space-y-2">
          <Button variant="primary" size="lg" className="w-full" onClick={onOpenWorkspace}>
            <Cloud /> Open my workspace
          </Button>
          <p className="text-[12px] leading-5 text-night-500">Your workspace runs on the university&apos;s servers; your notes are saved to your university storage. Nothing to install.</p>
        </div>
        <div>
          <Eyebrow className="mb-2">Or study on your own device</Eyebrow>
          <ol className="list-decimal space-y-2 pl-5 text-[13.5px] leading-6 text-night-300">
            <li>Install and open the Saint Elms app on the device you will study on.</li>
            <li>Choose <em>Sign in with a device code</em>. The app shows a short code.</li>
            <li>
              Open the university's <a className="text-beacon-300 underline decoration-beacon-300/40 underline-offset-2 hover:decoration-beacon-300" href="/device">device approval page</a> and confirm that code.
            </li>
          </ol>
          <p className="mt-3 text-[12px] leading-5 text-night-500">
            The desktop app keeps your notes on that device instead.
          </p>
        </div>
      </div>
    );
  }
  return <ClosedState state={state} />;
}

const CLOSED: Record<Exclude<AdmissionState, 'not-applied' | 'pending' | 'approved'>, { badge: string; tone: 'rose' | 'ember' | 'neutral'; title: string; body: string }> = {
  rejected: { badge: 'Not admitted', tone: 'rose', title: 'Your application was not approved', body: 'The registrar decided against this application. There is nothing to retry here — the decision and its reason are on record with the university.' },
  suspended: { badge: 'Suspended', tone: 'ember', title: 'Your enrolment is suspended', body: 'Your place in the programme is on hold. Course material and study tools are unavailable while it stays this way. Contact the registrar to find out what has to change.' },
  withdrawn: { badge: 'Withdrawn', tone: 'neutral', title: 'You have withdrawn from the programme', body: 'Your enrolment was withdrawn. Signing in again does not bring it back — contact the registrar if you want to rejoin.' },
};

function ClosedState({ state }: { state: keyof typeof CLOSED }) {
  const copy = CLOSED[state];
  return (
    <div className="space-y-4">
      <div className="flex items-center gap-2">
        <Badge tone={copy.tone}>{copy.badge}</Badge>
        <ShieldAlert className="size-4 text-night-500" />
      </div>
      <div>
        <h2 className="font-display text-2xl leading-snug text-night-100">{copy.title}</h2>
        <p className="mt-2 text-[14px] leading-6 text-night-400">{copy.body}</p>
      </div>
      <p className="flex gap-2 text-[12.5px] leading-5 text-night-500">
        <CircleSlash className="mt-0.5 size-4 shrink-0" />
        This page cannot change an admission decision. Only the university can.
      </p>
    </div>
  );
}

function AdmissionSkeleton() {
  return (
    <div aria-busy>
      <Skeleton className="h-3 w-24" />
      <Skeleton className="mt-4 h-7 w-4/5" />
      <SkeletonText lines={3} className="mt-5" />
      <Skeleton className="mt-6 h-10 w-full rounded-xl" />
    </div>
  );
}