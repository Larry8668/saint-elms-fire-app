import type { BrainDiffEntry, BrainEditOp, RejectedOp } from '@sef/shared';
import { motion } from 'motion/react';
import { AlertTriangle, ArrowRight, Link2, ShieldCheck, Sparkles } from 'lucide-react';
import { Badge } from '@/components/ui/primitives';
import { STATUS_STYLE } from '@/lib/brain-style';

/** What a brain update did: pages touched, status moves, misconceptions, and what the validator refused. */
export function BrainDiff({ diff, applied, rejected, model, durationMs }: { diff: BrainDiffEntry[]; applied: BrainEditOp[]; rejected: RejectedOp[]; model?: string; durationMs?: number }) {
  const flagged = applied.filter((o): o is Extract<BrainEditOp, { op: 'flag_misconception' }> => o.op === 'flag_misconception');
  const resolved = applied.filter((o) => o.op === 'resolve_misconception');
  const links = applied.filter((o): o is Extract<BrainEditOp, { op: 'add_link' }> => o.op === 'add_link');

  if (!diff.length && !rejected.length) {
    return <p className="text-sm text-night-400">Nothing in this material touched a concept from your courses, so your brain was left as it was.</p>;
  }

  return (
    <div className="space-y-5">
      <div className="flex flex-wrap gap-2">
        <Badge tone="beacon">
          <Sparkles className="size-3" /> {diff.length} page{diff.length === 1 ? '' : 's'}
        </Badge>
        {flagged.length > 0 && <Badge tone="ember">{flagged.length} misconception{flagged.length === 1 ? '' : 's'} flagged</Badge>}
        {resolved.length > 0 && <Badge tone="gold">{resolved.length} resolved</Badge>}
        {links.length > 0 && <Badge tone="aurora">{links.length} link{links.length === 1 ? '' : 's'}</Badge>}
        <Badge tone={rejected.length ? 'rose' : 'neutral'}>
          <ShieldCheck className="size-3" /> {rejected.length} rejected by validator
        </Badge>
      </div>

      <ul className="space-y-2">
        {diff.map((entry, i) => (
          <motion.li
            key={entry.key}
            initial={{ opacity: 0, x: -8 }}
            animate={{ opacity: 1, x: 0 }}
            transition={{ delay: i * 0.06 }}
            className="flex items-center justify-between gap-3 rounded-xl border border-white/[0.06] bg-white/[0.03] px-3.5 py-2.5"
          >
            <div className="min-w-0">
              <div className="truncate text-sm font-medium text-night-100">{entry.concept}</div>
              <div className="text-xs text-night-400">{entry.change === 'created' ? 'New page in your brain' : 'Page updated'}</div>
            </div>
            <div className="flex shrink-0 items-center gap-1.5">
              <Badge tone={STATUS_STYLE[entry.statusBefore].tone}>{STATUS_STYLE[entry.statusBefore].label}</Badge>
              <ArrowRight className="size-3.5 text-night-500" />
              <Badge tone={STATUS_STYLE[entry.statusAfter].tone}>{STATUS_STYLE[entry.statusAfter].label}</Badge>
            </div>
          </motion.li>
        ))}
      </ul>

      {flagged.length > 0 && (
        <div className="space-y-2">
          {flagged.map((m, i) => (
            <div key={i} className="rounded-xl border border-ember-400/25 bg-ember-500/[0.07] p-3.5 text-sm">
              <div className="mb-1 flex items-center gap-1.5 text-[12px] font-semibold tracking-wide text-ember-300 uppercase">
                <AlertTriangle className="size-3.5" /> Misconception
              </div>
              <p className="text-night-200">“{m.claim}”</p>
              <p className="mt-1.5 text-night-400">
                <span className="text-night-300">The course says:</span> {m.course}
              </p>
            </div>
          ))}
        </div>
      )}

      {links.length > 0 && (
        <div className="space-y-1.5">
          {links.map((l, i) => (
            <div key={i} className="flex items-center gap-2 text-sm text-night-300">
              <Link2 className="size-3.5 text-aurora-400" />
              <span className="text-night-100">{l.from}</span> <span className="text-night-500">{l.type.replace('_', ' ')}</span> <span className="text-night-100">{l.to}</span>
              <Badge tone={l.origin === 'student' ? 'aurora' : 'neutral'}>{l.origin}</Badge>
            </div>
          ))}
        </div>
      )}

      {rejected.length > 0 && (
        <details className="rounded-xl border border-white/[0.06] bg-black/20 p-3 text-sm">
          <summary className="cursor-pointer text-night-300">What the validator refused, and why</summary>
          <ul className="mt-2 space-y-1 text-xs text-night-400">
            {rejected.map((r, i) => (
              <li key={i}>• {r.reason}</li>
            ))}
          </ul>
        </details>
      )}

      {model && (
        <p className="text-xs text-night-500">
          Proposed by {model}
          {durationMs ? ` in ${(durationMs / 1000).toFixed(1)}s` : ''} · checked and written by the deterministic brain engine.
        </p>
      )}
    </div>
  );
}
