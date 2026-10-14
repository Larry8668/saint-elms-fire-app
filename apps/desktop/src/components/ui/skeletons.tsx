import { cn } from '@/lib/cn';
import { Panel, Skeleton, SkeletonText } from './primitives';

/** Card grid placeholder matching the Library course cards and Brain page cards. */
export function CardGridSkeleton({ count = 6, className }: { count?: number; className?: string }) {
  return (
    <div className={cn('grid gap-3 md:grid-cols-2 lg:grid-cols-3', className)} aria-busy>
      {Array.from({ length: count }, (_, i) => (
        <Panel key={i} className="p-5">
          <div className="flex items-center justify-between">
            <Skeleton className="h-3 w-20" />
            <Skeleton className="h-5 w-14 rounded-full" />
          </div>
          <Skeleton className="mt-4 h-5 w-3/4" />
          <SkeletonText lines={2} className="mt-4" />
          <div className="mt-5 flex gap-1.5">
            <Skeleton className="h-5 w-16 rounded-full" />
            <Skeleton className="h-5 w-12 rounded-full" />
          </div>
        </Panel>
      ))}
    </div>
  );
}

/** Long-form reading placeholder: eyebrow, chips, title, paragraphs, an equation block. */
export function ArticleSkeleton({ className }: { className?: string }) {
  return (
    <div className={cn('mx-auto max-w-3xl px-8 py-10', className)} aria-busy>
      <Skeleton className="h-3 w-48" />
      <div className="mt-4 flex gap-2">
        {['w-16', 'w-28', 'w-24', 'w-20'].map((w) => (
          <Skeleton key={w} className={cn('h-5 rounded-full', w)} />
        ))}
      </div>
      <Skeleton className="mt-8 h-9 w-2/3" />
      <SkeletonText lines={4} className="mt-8" />
      <Skeleton className="mx-auto mt-8 h-14 w-1/2 rounded-xl" />
      <SkeletonText lines={5} className="mt-8" />
      <Skeleton className="mt-10 h-6 w-1/3" />
      <SkeletonText lines={3} className="mt-5" />
    </div>
  );
}

/** Settings-shaped placeholder: header, then panels of label + field pairs. */
export function FormSkeleton({ panels = 3, className }: { panels?: number; className?: string }) {
  return (
    <div className={cn('mx-auto max-w-4xl px-8 py-8', className)} aria-busy>
      <Skeleton className="h-3 w-24" />
      <Skeleton className="mt-3 h-10 w-56" />
      <Skeleton className="mt-3 h-3.5 w-full max-w-xl" />
      <div className="mt-8 space-y-6">
        {Array.from({ length: panels }, (_, p) => (
          <Panel key={p} className="grid gap-5 p-6 md:grid-cols-2">
            {Array.from({ length: 2 }, (_, f) => (
              <div key={f}>
                <Skeleton className="h-3 w-28" />
                <Skeleton className="mt-2 h-10 w-full rounded-xl" />
              </div>
            ))}
          </Panel>
        ))}
      </div>
    </div>
  );
}

/** Stacked panels with a title line, a sentence and a trailing action, e.g. findings lists. */
export function RowListSkeleton({ rows = 4 }: { rows?: number }) {
  return (
    <div className="space-y-3" aria-busy>
      {Array.from({ length: rows }, (_, i) => (
        <Panel key={i} className="flex items-center gap-4 p-5">
          <div className="min-w-0 flex-1">
            <div className="flex items-center gap-2">
              <Skeleton className="size-4 rounded-full" />
              <Skeleton className="h-3.5 w-40" />
              <Skeleton className="h-4 w-20 rounded-full" />
            </div>
            <Skeleton className="mt-3 h-3 w-4/5" />
          </div>
          <Skeleton className="h-8 w-32 rounded-xl" />
        </Panel>
      ))}
    </div>
  );
}

/** Vertical timeline placeholder: node, date, title, detail. */
export function TimelineSkeleton({ entries = 5 }: { entries?: number }) {
  return (
    <div className="relative ml-3 border-l border-white/[0.08] pl-8" aria-busy>
      {Array.from({ length: entries }, (_, i) => (
        <div key={i} className="relative pb-7">
          <Skeleton className="absolute top-0.5 -left-[45px] size-7 rounded-full" />
          <Skeleton className="h-2.5 w-24" />
          <Skeleton className="mt-2 h-4 w-64" />
          <Skeleton className="mt-2 h-3 w-96 max-w-full" />
        </div>
      ))}
    </div>
  );
}

/** Sheet body placeholder: a few titled sections of prose. */
export function SectionsSkeleton({ sections = 3 }: { sections?: number }) {
  return (
    <div className="space-y-6" aria-busy>
      {Array.from({ length: sections }, (_, i) => (
        <div key={i}>
          <Skeleton className="h-2.5 w-24" />
          <SkeletonText lines={i === 0 ? 4 : 2} className="mt-3" />
        </div>
      ))}
    </div>
  );
}
