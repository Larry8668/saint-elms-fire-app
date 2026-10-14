import { cn } from '@/lib/cn';

const GRADIENTS = [
  'from-beacon-400 to-aurora-400',
  'from-ember-400 to-rose-400',
  'from-aurora-400 to-gold-400',
  'from-beacon-500 to-ember-400',
  'from-gold-400 to-beacon-400',
];

const hash = (s: string) => [...s].reduce((h, c) => (h * 31 + c.charCodeAt(0)) >>> 0, 7);

/** Initial on a gradient that is stable per profile id. */
export function ProfileAvatar({ id, name, size = 'md', className }: { id: string; name: string; size?: 'sm' | 'md' | 'lg'; className?: string }) {
  return (
    <span
      className={cn(
        'grid shrink-0 place-items-center rounded-full bg-gradient-to-br font-semibold text-night-950',
        GRADIENTS[hash(id) % GRADIENTS.length],
        size === 'sm' && 'size-8 text-[13px]',
        size === 'md' && 'size-10 text-[15px]',
        size === 'lg' && 'size-14 text-xl',
        className,
      )}
      aria-hidden
    >
      {name.slice(0, 1).toUpperCase()}
    </span>
  );
}
