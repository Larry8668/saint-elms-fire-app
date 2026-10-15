import { cva, type VariantProps } from 'class-variance-authority';
import { Loader2 } from 'lucide-react';
import { forwardRef, type ButtonHTMLAttributes } from 'react';
import { cn } from '@/lib/cn';

const buttonVariants = cva(
  'inline-flex items-center justify-center gap-2 whitespace-nowrap rounded-xl text-sm font-medium transition-all duration-200 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-beacon-400/60 disabled:pointer-events-none disabled:opacity-45 [&_svg]:size-4 [&_svg]:shrink-0 cursor-pointer',
  {
    variants: {
      variant: {
        primary:
          'bg-beacon-500 text-white shadow-[0_0_0_1px_oklch(1_0_0/0.12)_inset,0_10px_30px_-10px_var(--color-beacon-500)] hover:bg-beacon-400',
        secondary: 'bg-white/[0.06] text-night-100 border border-white/[0.08] hover:bg-white/[0.1] hover:border-white/[0.14]',
        ghost: 'text-night-300 hover:bg-white/[0.06] hover:text-night-100',
        outline: 'border border-white/12 text-night-200 hover:border-beacon-400/50 hover:text-night-100 hover:bg-beacon-500/10',
        ember: 'bg-ember-500/15 text-ember-300 border border-ember-400/30 hover:bg-ember-500/25',
        danger: 'bg-rose-400/15 text-rose-400 border border-rose-400/30 hover:bg-rose-400/25',
      },
      size: {
        sm: 'h-8 px-3 text-[13px]',
        md: 'h-10 px-4',
        lg: 'h-12 px-6 text-[15px]',
        icon: 'size-9',
      },
    },
    defaultVariants: { variant: 'secondary', size: 'md' },
  },
);

export interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement>, VariantProps<typeof buttonVariants> {
  loading?: boolean;
}

export const Button = forwardRef<HTMLButtonElement, ButtonProps>(({ className, variant, size, loading, children, disabled, ...props }, ref) => (
  <button ref={ref} className={cn(buttonVariants({ variant, size }), className)} disabled={disabled || loading} {...props}>
    {loading && <Loader2 className="animate-spin" aria-hidden />}
    {children}
  </button>
));
Button.displayName = 'Button';