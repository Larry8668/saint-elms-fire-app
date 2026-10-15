import { cva, type VariantProps } from 'class-variance-authority';
import { forwardRef, type HTMLAttributes, type InputHTMLAttributes, type LabelHTMLAttributes, type ReactNode, type SelectHTMLAttributes, type TextareaHTMLAttributes } from 'react';
import { cn } from '@/lib/cn';

export function Panel({ className, ...props }: HTMLAttributes<HTMLDivElement>) {
  return <div className={cn('glass rounded-2xl', className)} {...props} />;
}

const badgeVariants = cva('inline-flex items-center gap-1.5 rounded-full px-2.5 py-0.5 text-[11.5px] font-medium tracking-wide', {
  variants: {
    tone: {
      neutral: 'bg-white/[0.06] text-night-300 border border-white/[0.06]',
      beacon: 'bg-beacon-500/15 text-beacon-200 border border-beacon-400/25',
      aurora: 'bg-aurora-500/15 text-aurora-300 border border-aurora-400/25',
      gold: 'bg-gold-400/15 text-gold-300 border border-gold-400/25',
      ember: 'bg-ember-500/15 text-ember-300 border border-ember-400/25',
      rose: 'bg-rose-400/15 text-rose-400 border border-rose-400/25',
    },
  },
  defaultVariants: { tone: 'neutral' },
});

export function Badge({ className, tone, ...props }: HTMLAttributes<HTMLSpanElement> & VariantProps<typeof badgeVariants>) {
  return <span className={cn(badgeVariants({ tone }), className)} {...props} />;
}

const fieldClass =
  'w-full rounded-xl border border-white/[0.09] bg-black/25 px-3.5 text-sm text-night-100 placeholder:text-night-500 transition focus:border-beacon-400/60 focus:bg-black/35 focus:outline-none focus:ring-2 focus:ring-beacon-500/20 disabled:opacity-50';

export const Input = forwardRef<HTMLInputElement, InputHTMLAttributes<HTMLInputElement>>(({ className, ...props }, ref) => (
  <input ref={ref} className={cn(fieldClass, 'h-10', className)} {...props} />
));
Input.displayName = 'Input';

export const Textarea = forwardRef<HTMLTextAreaElement, TextareaHTMLAttributes<HTMLTextAreaElement>>(({ className, ...props }, ref) => (
  <textarea ref={ref} className={cn(fieldClass, 'py-2.5 leading-6', className)} {...props} />
));
Textarea.displayName = 'Textarea';

export const Select = forwardRef<HTMLSelectElement, SelectHTMLAttributes<HTMLSelectElement>>(({ className, ...props }, ref) => (
  <select ref={ref} className={cn(fieldClass, 'h-10 appearance-none bg-[length:12px] bg-[right_0.9rem_center] bg-no-repeat pr-9', className)} style={{ backgroundImage: SELECT_CHEVRON }} {...props} />
));
Select.displayName = 'Select';

const SELECT_CHEVRON = `url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 12 12'%3E%3Cpath d='M3 4.5l3 3 3-3' fill='none' stroke='%239aa3b8' stroke-width='1.5'/%3E%3C/svg%3E")`;

export function Label({ className, ...props }: LabelHTMLAttributes<HTMLLabelElement>) {
  return <label className={cn('mb-1.5 block text-[12.5px] font-medium text-night-300', className)} {...props} />;
}

export function Eyebrow({ className, ...props }: HTMLAttributes<HTMLDivElement>) {
  return <div className={cn('text-[11px] font-semibold tracking-[0.18em] text-night-500 uppercase', className)} {...props} />;
}

export function Skeleton({ className }: { className?: string }) {
  return <div aria-hidden className={cn('skeleton rounded-lg', className)} />;
}

/** Paragraph-shaped skeleton; the last line is short so it reads as text, not a block. */
export function SkeletonText({ lines = 3, className }: { lines?: number; className?: string }) {
  return (
    <div className={cn('space-y-2.5', className)} aria-hidden>
      {Array.from({ length: lines }, (_, i) => (
        <Skeleton key={i} className={cn('h-3', i === lines - 1 ? 'w-3/5' : i % 2 ? 'w-[92%]' : 'w-full')} />
      ))}
    </div>
  );
}

export function EmptyState({ icon, title, body, action }: { icon: ReactNode; title: string; body: string; action?: ReactNode }) {
  return (
    <div className="flex flex-col items-center justify-center px-6 py-16 text-center animate-rise">
      <div className="mb-5 grid size-14 place-items-center rounded-2xl border border-white/10 bg-white/[0.04] text-beacon-300 [&_svg]:size-6">{icon}</div>
      <h3 className="font-display text-2xl text-night-100">{title}</h3>
      <p className="mt-2 max-w-md text-sm leading-6 text-night-400">{body}</p>
      {action && <div className="mt-6">{action}</div>}
    </div>
  );
}

export function PageHeader({ eyebrow, title, description, actions }: { eyebrow?: string; title: ReactNode; description?: ReactNode; actions?: ReactNode }) {
  return (
    <header className="flex flex-col gap-4 pb-6 md:flex-row md:items-end md:justify-between">
      <div>
        {eyebrow && <Eyebrow className="mb-2">{eyebrow}</Eyebrow>}
        <h1 className="font-display text-4xl leading-tight text-night-100 md:text-[44px]">{title}</h1>
        {description && <p className="mt-2 max-w-2xl text-[14.5px] leading-6 text-night-400">{description}</p>}
      </div>
      {actions && <div className="flex shrink-0 items-center gap-2">{actions}</div>}
    </header>
  );
}

/** A labelled fact. Used instead of a table so a narrow viewport stacks without scrolling sideways. */
export function Fact({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="min-w-0">
      <dt className="text-[11px] font-semibold tracking-[0.14em] text-night-500 uppercase">{label}</dt>
      <dd className="mt-1 text-sm break-words text-night-100">{children}</dd>
    </div>
  );
}