/** Full-screen loading state shown while a session is restored or a shell is loading. */
export function BootSplash({ label = 'Lighting the lanterns' }: { label?: string }) {
  return (
    <div className="sky-backdrop grid h-screen place-items-center" role="status" aria-live="polite">
      <div className="flex flex-col items-center gap-5 animate-rise">
        <div className="relative size-14">
          <span className="absolute inset-0 animate-ping rounded-full bg-beacon-400/20" />
          <img src="/logo.svg" alt="" className="relative size-14" />
        </div>
        <p className="text-[13px] tracking-wide text-night-400">{label}…</p>
      </div>
    </div>
  );
}
