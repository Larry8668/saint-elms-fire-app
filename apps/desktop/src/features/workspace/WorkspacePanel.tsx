import { Cloud, LogOut } from 'lucide-react';
import { useState } from 'react';
import { ConfirmButton } from '@/components/ui/confirm-button';
import { Eyebrow, Panel } from '@/components/ui/primitives';
import { useSession } from '@/lib/session';
import { DevicesCard } from './DevicesCard';
import { useWorkspaceInfo } from './use-workspace';

/** Settings on a hosted workspace: what it is, how to end it, and which devices are signed in to it. */
export function WorkspacePanel() {
  const info = useWorkspaceInfo();
  const { signOut } = useSession();
  const [ending, setEnding] = useState(false);
  if (!info.data?.hosted) return null;
  return (
    <div className="space-y-6">
      <Panel className="flex flex-col gap-4 p-6 md:flex-row md:items-center">
        <Cloud className="size-6 shrink-0 text-beacon-300" />
        <div className="min-w-0 flex-1">
          <Eyebrow>Your workspace</Eyebrow>
          <p className="mt-1 text-[13.5px] leading-6 text-night-300">
            Your workspace runs on the university&apos;s servers; your notes are saved to your university storage. Ending the session saves them one last time and deletes this machine. The sync status is in the sidebar.
          </p>
        </div>
        <ConfirmButton
          variant="secondary"
          confirmLabel="Save and end"
          loading={ending}
          onConfirm={() => {
            setEnding(true);
            void signOut().finally(() => setEnding(false));
          }}
        >
          <LogOut /> Sign out and end session
        </ConfirmButton>
      </Panel>
      <DevicesCard />
    </div>
  );
}
