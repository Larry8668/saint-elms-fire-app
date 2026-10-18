import { useCallback, useEffect, useMemo, useState } from 'react';
import type { AdmissionMe } from '@sef/shared';
import { Button } from '@/components/ui/button';
import { Panel, Skeleton, SkeletonText } from '@/components/ui/primitives';
import { PortalShell } from './components/PortalShell';
import { Notice } from './components/Notice';
import { goToMode, readPortalRoute, type PortalMode, type PortalRoute } from './portal-modes';
import type { Banner, MailReason } from './portal-copy';
import type { DemoAccount } from '@/lib/demo-accounts';
import { demoAvailable, demoSignOut, getMe, PortalError, signOut } from './portal-api';
import { AdmissionView } from './views/AdmissionView';
import { CheckEmailView } from './views/CheckEmailView';
import { DemoSignInView } from './views/DemoSignInView';
import { DemoStudentView } from './views/DemoStudentView';
import { MagicLinkView } from './views/MagicLinkView';
import { RecoverView } from './views/RecoverView';
import { RegisterView } from './views/RegisterView';
import { ResetPasswordView } from './views/ResetPasswordView';
import { SignInView } from './views/SignInView';
import { WorkspaceView } from './views/WorkspaceView';

/**
 * The university-hosted onboarding shell. Same origin as the account and admission endpoints,
 * so the session is nothing but an HttpOnly cookie this app never sees. It stops at
 * admission and the hand-off: the student dashboard runs on the workspace VM (or the local
 * engine), not on this page.
 */
export function PortalApp() {
  const [route, setRoute] = useState<PortalRoute>(readPortalRoute);
  const [me, setMe] = useState<AdmissionMe | null>(null);
  const [checking, setChecking] = useState(true);
  const [checkError, setCheckError] = useState<PortalError | null>(null);
  const [banner, setBanner] = useState<Banner | null>(null);
  const [mailbox, setMailbox] = useState<{ email: string; reason: MailReason } | null>(null);
  const [workspace, setWorkspace] = useState(false);
  /** Whether this university seeds demo students; the demo path is offered only then. */
  const [demo, setDemo] = useState(false);
  /** A signed-in demo student (legacy token, held by portal-api in memory). */
  const [demoStudent, setDemoStudent] = useState<DemoAccount | null>(null);

  useEffect(() => {
    void demoAvailable().then(setDemo);
  }, []);

  const probe = useCallback(async () => {
    setChecking(true);
    setCheckError(null);
    try {
      setMe(await getMe());
      setRoute((current) => (current.mode === 'admission' ? current : goToMode('admission')));
    } catch (caught) {
      if (!(caught instanceof PortalError)) throw caught;
      if (caught.status === 401) {
        setMe(null);
        setRoute((current) => (current.mode === 'admission' ? goToMode('sign-in') : current));
      } else {
        setCheckError(caught);
      }
    } finally {
      setChecking(false);
    }
  }, []);

  useEffect(() => {
    void probe();
  }, [probe]);

  const go = useCallback((mode: PortalMode) => {
    setBanner(null);
    setRoute(goToMode(mode));
  }, []);

  /** The outcome of the link the student just clicked, as written into the URL by the server. */
  const landingBanner = useMemo<Banner | null>(() => {
    if (route.landing === 'verified') return { tone: 'success', title: 'Email verified', body: 'Your address is verified. Sign in to continue.' };
    if (route.landing === 'link-error') {
      return { tone: 'error', title: 'That link did not work', body: `The university rejected it${route.errorCode ? ` (${route.errorCode})` : ''}. Request a fresh one below.` };
    }
    return null;
  }, [route]);

  const onMailSent = useCallback((email: string, reason: MailReason) => {
    setMailbox({ email, reason });
    setBanner(null);
    setRoute(goToMode('check-email'));
  }, []);

  const onSignOut = useCallback(() => {
    void signOut()
      .then(() => {
        setMe(null);
        setBanner(null);
        setRoute(goToMode('sign-in'));
      })
      .catch((caught: unknown) => {
        // Do not claim a sign-out that did not happen: the cookie may still be live.
        const message = caught instanceof PortalError ? caught.message : 'Signing out failed. Try again.';
        setBanner({ tone: 'error', title: 'Could not sign out', body: message });
      });
  }, []);

  if (demoStudent && workspace) return <WorkspaceView onBack={() => setWorkspace(false)} demoPersonaId={demoStudent.id} />;

  if (demoStudent) {
    return (
      <DemoStudentView
        persona={demoStudent}
        onOpenWorkspace={() => setWorkspace(true)}
        onSignOut={() => {
          demoSignOut();
          setDemoStudent(null);
          go('sign-in');
        }}
      />
    );
  }

  if (checking && !me) {
    return (
      <PortalShell eyebrow="Saint Elms University" title="Checking your account">
        <Panel className="p-5 sm:p-7">
          <div aria-busy>
            <Skeleton className="h-3 w-24" />
            <Skeleton className="mt-4 h-7 w-3/4" />
            <SkeletonText lines={3} className="mt-5" />
          </div>
        </Panel>
      </PortalShell>
    );
  }

  if (checkError && !me) {
    return (
      <PortalShell eyebrow="Saint Elms University" title="We could not reach the registrar service">
        <div className="space-y-4">
          <Notice tone="error">{checkError.message}</Notice>
          <Button variant="primary" className="w-full" onClick={() => void probe()}>
            Try again
          </Button>
          <button type="button" onClick={() => go('sign-in')} className="w-full cursor-pointer text-center text-[13px] text-night-400 underline decoration-white/15 underline-offset-4 hover:text-beacon-300">
            Continue to sign in
          </button>
        </div>
      </PortalShell>
    );
  }

  if (me && workspace) return <WorkspaceView onBack={() => setWorkspace(false)} />;

  if (me) {
    return <AdmissionView me={me} banner={banner} refreshing={checking} onRefresh={() => void probe()} onSignOut={onSignOut} onOpenWorkspace={() => setWorkspace(true)} />;
  }

  switch (route.mode) {
    case 'demo-sign-in':
      return demo ? <DemoSignInView go={go} onSignedIn={setDemoStudent} /> : <SignInView onAuthenticated={() => void probe()} go={go} banner={null} />;
    case 'register':
      return <RegisterView go={go} onSent={(email) => onMailSent(email, 'verify')} />;
    case 'magic-link':
      return <MagicLinkView go={go} onSent={(email) => onMailSent(email, 'magic-link')} />;
    case 'check-email':
      return mailbox ? (
        <CheckEmailView
          email={mailbox.email}
          reason={mailbox.reason}
          onBack={() => go('sign-in')}
          onChangeEmail={() => go(mailbox.reason === 'reset' ? 'recover' : 'sign-in')}
        />
      ) : (
        <SignInView onAuthenticated={() => void probe()} go={go} banner={null} demo={demo} />
      );
    case 'recover':
      return <RecoverView go={go} onSent={(email) => onMailSent(email, 'reset')} />;
    case 'reset-password':
      return (
        <ResetPasswordView
          token={route.resetToken}
          errorCode={route.errorCode}
          onDone={() => {
            setBanner({ tone: 'success', title: 'Password updated', body: 'Sign in with your new password.' });
            setRoute(goToMode('sign-in'));
          }}
          onStartOver={() => go('recover')}
        />
      );
    default:
      return <SignInView onAuthenticated={() => void probe()} go={go} banner={banner ?? landingBanner} demo={demo} />;
  }
}