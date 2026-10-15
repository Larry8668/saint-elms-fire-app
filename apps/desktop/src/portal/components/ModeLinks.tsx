import type { PortalMode } from '../portal-modes';

/** Cross-links between the signed-out modes. Rendered under every account form. */
export function ModeLinks({ current, go, links }: { current: PortalMode; go: (mode: PortalMode) => void; links: Array<{ mode: PortalMode; label: string }> }) {
  return (
    <nav aria-label="Other ways to continue" className="flex flex-wrap items-center justify-center gap-x-4 gap-y-2 text-[13px]">
      {links
        .filter((link) => link.mode !== current)
        .map((link) => (
          <button
            key={link.mode}
            type="button"
            onClick={() => go(link.mode)}
            className="cursor-pointer text-night-400 underline decoration-white/15 underline-offset-4 transition hover:text-beacon-300 hover:decoration-beacon-300/50"
          >
            {link.label}
          </button>
        ))}
    </nav>
  );
}