import { currentEngineTarget, isRemoteTarget, type EngineTarget } from '@/lib/seat';

/**
 * Which promises the sign-in screen may make. A hosted workspace runs on the university's
 * servers and keeps the vault in university storage, so it must never claim the brain stays on
 * this device or keeps working offline. Those claims belong to the local engine only.
 */
export type SignInCopyMode = 'hosted' | 'local';

export const signInCopyMode = (target: EngineTarget = currentEngineTarget()): SignInCopyMode => (isRemoteTarget(target) ? 'hosted' : 'local');

export type PromiseIcon = 'device' | 'shield' | 'offline' | 'server' | 'storage';

export const SIGN_IN_PROMISES: Record<SignInCopyMode, ReadonlyArray<{ icon: PromiseIcon; text: string }>> = {
  local: [
    { icon: 'device', text: 'Your brain stays on this device' },
    { icon: 'shield', text: 'Open-weight models, built to GDPR/DPDP' },
    { icon: 'offline', text: 'Keeps working offline' },
  ],
  hosted: [
    { icon: 'server', text: "Your workspace runs on the university's servers" },
    { icon: 'storage', text: 'Your notes are saved to your university storage' },
    { icon: 'shield', text: 'Open-weight models, built to GDPR/DPDP' },
  ],
};

/** The one line that explains the second sign-in on a hosted workspace. */
export const HOSTED_SIGN_IN_NOTE =
  'This workspace is a separate machine, so confirm it once with your university account. You are already signed in on the portal, so approving it takes one click.';

/** Where a student's own material is kept, for inline notes elsewhere in the app. */
export const whereItIsKept = (mode: SignInCopyMode = signInCopyMode()): string =>
  mode === 'hosted' ? 'saved to your university storage' : 'stays on this device';
