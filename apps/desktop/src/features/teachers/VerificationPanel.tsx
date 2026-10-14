import type { Verification } from '@sef/shared';
import { BookOpen, Brain, CheckCircle2, ChevronDown, Cpu, Globe, LifeBuoy, Wrench, XCircle } from 'lucide-react';
import { useState } from 'react';
import { cn } from '@/lib/cn';
import { safeHref } from '@/lib/url';

const SOURCE_ICON = { lesson: BookOpen, brain: Brain, web: Globe, support: LifeBuoy } as const;

/** "Why should I trust this answer?" — sources, checks, tool calls and the model that served it. */
export function VerificationPanel({ verification }: { verification: Verification }) {
  const [open, setOpen] = useState(false);
  const passed = verification.checks.filter((c) => c.passed).length;
  const allPassed = passed === verification.checks.length;

  return (
    <div className="mt-2.5">
      <button
        onClick={() => setOpen((o) => !o)}
        aria-expanded={open}
        className="flex cursor-pointer flex-wrap items-center gap-x-3 gap-y-1 rounded-full border border-white/[0.06] bg-white/[0.02] px-2.5 py-1 text-[11.5px] text-night-500 transition hover:border-white/[0.12] hover:text-night-300"
      >
        <span className={cn('flex items-center gap-1 font-medium', allPassed ? 'text-aurora-400' : 'text-ember-400')}>
          {allPassed ? <CheckCircle2 className="size-3.5" /> : <XCircle className="size-3.5" />}
          {passed}/{verification.checks.length} checks
        </span>
        <span>{verification.sources.length} source{verification.sources.length === 1 ? '' : 's'}</span>
        {verification.toolCalls.length > 0 && <span>{verification.toolCalls.length} tool call{verification.toolCalls.length === 1 ? '' : 's'}</span>}
        <span className="flex items-center gap-1">
          <Cpu className="size-3" /> {verification.model}
        </span>
        <ChevronDown className={cn('size-3.5 transition', open && 'rotate-180')} />
      </button>

      {open && (
        <div className="mt-2 space-y-3 rounded-xl border border-white/[0.06] bg-black/25 p-3.5 text-[12.5px] animate-rise">
          <div className="space-y-1">
            {verification.checks.map((c) => (
              <div key={c.id} className="flex items-start gap-2">
                {c.passed ? <CheckCircle2 className="mt-0.5 size-3.5 shrink-0 text-aurora-400" /> : <XCircle className="mt-0.5 size-3.5 shrink-0 text-ember-400" />}
                <span className="text-night-200">
                  {c.label}
                  {c.detail && <span className="text-night-500"> — {c.detail}</span>}
                </span>
              </div>
            ))}
          </div>
          {verification.sources.length > 0 && (
            <div>
              <div className="mb-1 text-[10.5px] font-semibold tracking-[0.16em] text-night-500 uppercase">Sources</div>
              <ul className="space-y-1">
                {verification.sources.map((s) => {
                  const Icon = SOURCE_ICON[s.kind];
                  const href = safeHref(s.url);
                  return (
                    <li key={`${s.kind}:${s.id}`} className="flex items-center gap-2 text-night-300">
                      <Icon className="size-3.5 shrink-0 text-night-500" />
                      {href ? (
                        <a href={href} target="_blank" rel="noreferrer" className="truncate text-beacon-300 hover:underline">
                          {s.title}
                        </a>
                      ) : (
                        <span className="truncate">{s.title}</span>
                      )}
                      {s.cited === false && <span className="shrink-0 text-[11px] text-night-500">retrieved, not used</span>}
                    </li>
                  );
                })}
              </ul>
            </div>
          )}
          {verification.toolCalls.length > 0 && (
            <div>
              <div className="mb-1 text-[10.5px] font-semibold tracking-[0.16em] text-night-500 uppercase">Tool calls</div>
              <ul className="space-y-1">
                {verification.toolCalls.map((t, i) => (
                  <li key={i} className="flex items-center gap-2 text-night-400">
                    <Wrench className="size-3 shrink-0" /> <code className="text-aurora-300">{t.tool}</code> {t.summary}
                  </li>
                ))}
              </ul>
            </div>
          )}
          <div className="text-night-500">Served by {verification.model} · {verification.provider}</div>
        </div>
      )}
    </div>
  );
}
