import { PowerOff } from 'lucide-react';
import { useWorkspaceHeartbeat, useWorkspaceInfo, workspacePortalUrl } from './use-workspace';

/** Keeps a hosted workspace's lease alive from the app shell, and says so plainly when it has ended. */
export function WorkspaceSession() {
  const info = useWorkspaceInfo();
  const { ended } = useWorkspaceHeartbeat(info.data?.hosted === true);
  if (!ended) return null;
  return (
    <div role="alert" className="mx-6 mt-4 rounded-2xl border border-ember-400/25 bg-ember-400/[0.07] p-4 text-[13px] leading-6 text-night-200">
      <p className="flex items-center gap-2 font-medium text-night-100">
        <PowerOff className="size-4 text-ember-300" /> This workspace session has ended
      </p>
      <p className="mt-1 text-[12.5px] text-night-400">
        The university closes a workspace after a period without use, and saves your notes to your university storage when it does. Anything you do here now may not be kept.
      </p>
      <a href={workspacePortalUrl()} className="mt-3 inline-flex items-center rounded-xl bg-beacon-500 px-3 py-1.5 text-[13px] font-medium text-white hover:bg-beacon-400">
        Open a new workspace
      </a>
    </div>
  );
}
