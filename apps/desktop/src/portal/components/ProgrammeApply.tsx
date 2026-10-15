import { useCallback, useEffect, useState } from 'react';
import type { ProgrammeSummary } from '@sef/shared';
import { Button } from '@/components/ui/button';
import { WorkingLabel } from '@/components/ui/loading';
import { Eyebrow, Skeleton, SkeletonText } from '@/components/ui/primitives';
import { Notice } from './Notice';
import { applyToProgramme, listProgrammes, PortalError, sendVerificationEmail } from '../portal-api';
import { useSubmit } from '../use-submit';

export function ProgrammeApply({ email, onApplied }: { email: string; onApplied: () => void }) {
  const [programme, setProgramme] = useState<ProgrammeSummary | null>(null);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<PortalError | null>(null);
  const [needsVerification, setNeedsVerification] = useState(false);
  const [resent, setResent] = useState(false);
  const apply = useSubmit();
  const resend = useSubmit();

  const load = useCallback(() => {
    setLoading(true);
    setLoadError(null);
    listProgrammes()
      .then((programmes) => {
        setProgramme(programmes[0] ?? null);
        // An unverified mailbox cannot apply yet; say so instead of showing a dead button.
        if (programmes.length === 0) setNeedsVerification(true);
      })
      .catch((caught: unknown) => {
        if (!(caught instanceof PortalError)) throw caught;
        if (caught.status === 403) setNeedsVerification(true);
        else setLoadError(caught);
      })
      .finally(() => setLoading(false));
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  const shown = programme;

  return (
    <div className="space-y-4">
      <div>
        <Eyebrow className="mb-2">Programme</Eyebrow>
        {loading && (
          <div aria-busy>
            <Skeleton className="h-6 w-3/4" />
            <SkeletonText lines={2} className="mt-3" />
          </div>
        )}
        {!loading && shown && (
          <>
            <h2 className="font-display text-2xl leading-snug text-night-100">{shown.name}</h2>
            <p className="mt-2 text-[12.5px] leading-5 text-night-500">{shown.institution}</p>
          </>
        )}
        {!loading && !shown && loadError && (
          <Notice tone="error" title="Programme details unavailable" action={<Button size="sm" variant="secondary" onClick={load}>Try again</Button>}>
            {loadError.message}
          </Notice>
        )}
      </div>

      {!loading && shown && (
        <>
          {needsVerification && (
            <Notice
              tone="error"
              title="Verify your email address first"
              action={
                <Button
                  size="sm"
                  variant="secondary"
                  disabled={resend.busy || resent}
                  onClick={() =>
                    void resend.run(async () => {
                      await sendVerificationEmail(email);
                      setResent(true);
                    })
                  }
                >
                  {resend.busy ? <WorkingLabel label="Sending" /> : resent ? 'Verification email sent' : 'Resend the verification email'}
                </Button>
              }
            >
              Opening the verification link unlocks the application.
            </Notice>
          )}
          {resend.error && <Notice tone="error">{resend.error.message}</Notice>}
          {apply.error && !needsVerification && <Notice tone="error">{apply.error.message}</Notice>}
          <Button
            variant="primary"
            className="w-full"
            disabled={apply.busy}
            onClick={() =>
              void apply.run(async () => {
                try {
                  await applyToProgramme(shown.id);
                } catch (caught) {
                  if (caught instanceof PortalError && caught.status === 403) setNeedsVerification(true);
                  throw caught;
                }
                onApplied();
              })
            }
          >
            {apply.busy ? <WorkingLabel label="Sending your application" /> : 'Apply to this programme'}
          </Button>
          <p className="text-[12px] leading-5 text-night-500">
            Applying does not enrol you. The registrar reviews every application and the decision appears here.
          </p>
        </>
      )}
    </div>
  );
}