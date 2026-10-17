import { CircleCheck, Cloud, LogOut } from 'lucide-react';
import type { DemoAccount } from '@/lib/demo-accounts';
import { Button } from '@/components/ui/button';
import { Eyebrow, Panel } from '@/components/ui/primitives';
import { Notice } from '../components/Notice';

/** A signed-in demo student: already enrolled, so the only next step is the workspace. */
export function DemoStudentView({ persona, onSignOut, onOpenWorkspace }: { persona: DemoAccount; onSignOut: () => void; onOpenWorkspace: () => void }) {
  return (
    <div className="mx-auto w-full max-w-xl px-5 py-8 sm:px-8 sm:py-12">
      <header className="mb-6 flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0">
          <Eyebrow className="mb-1.5">Saint Elms University · demo student</Eyebrow>
          <h1 className="truncate font-display text-2xl text-night-100 sm:text-3xl">{persona.label}</h1>
          <p className="mt-1 truncate text-[13px] text-night-500">{persona.detail}</p>
        </div>
        <Button size="sm" variant="ghost" onClick={onSignOut}>
          <LogOut />
          Sign out
        </Button>
      </header>
      <Panel className="p-5 sm:p-7">
        <div className="space-y-5">
          <Notice tone="success" title="Enrolled for the demo">
            <span className="flex gap-2">
              <CircleCheck className="mt-0.5 size-4 shrink-0" />
              <span>Demo students are seeded already enrolled, so there is no application to make.</span>
            </span>
          </Notice>
          <div className="space-y-2">
            <Button variant="primary" size="lg" className="w-full" onClick={onOpenWorkspace}>
              <Cloud /> Open my workspace
            </Button>
            <p className="text-[12px] leading-5 text-night-500">Your workspace runs on the university&apos;s servers; your notes are saved to your university storage. Nothing to install.</p>
          </div>
        </div>
      </Panel>
    </div>
  );
}
