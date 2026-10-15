import type { ReactNode } from 'react';
import { Eyebrow, Panel } from '@/components/ui/primitives';

/**
 * One column, capped and centred, so the shell stays legible from a phone at the bottom of a
 * signup form up to a desktop browser.
 */
export function PortalShell({ eyebrow, title, description, children }: { eyebrow: string; title: string; description?: string; children: ReactNode }) {
  return (
    <main className="mx-auto flex min-h-full w-full max-w-xl flex-col justify-center px-5 py-10 sm:px-8">
      <header className="mb-7 text-center">
        <Eyebrow className="mb-3">{eyebrow}</Eyebrow>
        <h1 className="font-display text-3xl leading-tight text-night-100 sm:text-4xl">{title}</h1>
        {description && <p className="mx-auto mt-3 max-w-md text-[14px] leading-6 text-night-400">{description}</p>}
      </header>
      <Panel className="p-5 sm:p-7">{children}</Panel>
    </main>
  );
}