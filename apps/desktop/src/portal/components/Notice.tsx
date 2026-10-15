import { AlertTriangle, CheckCircle2, Info } from 'lucide-react';
import type { ReactNode } from 'react';
import { cn } from '@/lib/cn';

const TONES = {
  error: { icon: AlertTriangle, ring: 'border-rose-400/30 bg-rose-400/10 text-rose-300', role: 'alert' },
  info: { icon: Info, ring: 'border-white/10 bg-white/[0.04] text-night-300', role: 'status' },
  success: { icon: CheckCircle2, ring: 'border-aurora-400/30 bg-aurora-400/10 text-aurora-300', role: 'status' },
} as const;

export type NoticeTone = keyof typeof TONES;

/**
 * Errors are always visible and assertive; nothing in this app reports a failure quietly.
 */
export function Notice({ tone = 'info', title, children, action }: { tone?: NoticeTone; title?: string; children: ReactNode; action?: ReactNode }) {
  const { icon: Icon, ring, role } = TONES[tone];
  return (
    <div role={role} className={cn('rounded-xl border px-3.5 py-3 text-[13.5px] leading-6', ring)}>
      <div className="flex gap-2.5">
        <Icon className="mt-0.5 size-4 shrink-0" />
        <div className="min-w-0 flex-1">
          {title && <p className="font-medium">{title}</p>}
          <div className={cn(title && 'mt-0.5')}>{children}</div>
          {action && <div className="mt-3">{action}</div>}
        </div>
      </div>
    </div>
  );
}