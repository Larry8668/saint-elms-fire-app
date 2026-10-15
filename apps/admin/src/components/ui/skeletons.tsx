import { cn } from '@/lib/cn';
import { Panel, Skeleton } from './primitives';

/** Registrar table placeholder: filter bar, then rows shaped like the real ones. */
export function StudentTableSkeleton({ rows = 6 }: { rows?: number }) {
  return (
    <div className="space-y-4" aria-busy>
      <Panel className="grid gap-3 p-4 sm:grid-cols-2 lg:grid-cols-4">
        {['h-10 w-full', 'h-10 w-full', 'h-10 w-full', 'h-10 w-full'].map((size, i) => (
          <Skeleton key={i} className={size} />
        ))}
      </Panel>
      <div className="space-y-2.5">
        {Array.from({ length: rows }, (_, i) => (
          <Panel key={i} className="flex flex-col gap-3 p-4 sm:flex-row sm:items-center">
            <div className="min-w-0 flex-1 space-y-2">
              <Skeleton className="h-4 w-56" />
              <Skeleton className="h-3 w-72" />
            </div>
            <div className="flex gap-2">
              <Skeleton className="h-5 w-20 rounded-full" />
              <Skeleton className="h-5 w-16 rounded-full" />
            </div>
          </Panel>
        ))}
      </div>
    </div>
  );
}

/** Student detail placeholder: identity facts, then a decision panel. */
export function StudentDetailSkeleton() {
  return (
    <div className="space-y-5" aria-busy>
      <Panel className="grid gap-5 p-6 sm:grid-cols-2 lg:grid-cols-3">
        {Array.from({ length: 6 }, (_, i) => (
          <div key={i}>
            <Skeleton className="h-2.5 w-24" />
            <Skeleton className="mt-2.5 h-4 w-40" />
          </div>
        ))}
      </Panel>
      <Panel className="space-y-4 p-6">
        <Skeleton className="h-4 w-48" />
        <Skeleton className="h-10 w-full" />
        <div className="flex flex-wrap gap-2">
          {['w-28', 'w-32', 'w-24'].map((w) => (
            <Skeleton key={w} className={cn('h-9 rounded-xl', w)} />
          ))}
        </div>
      </Panel>
    </div>
  );
}

/** Staff or audit rows: a dot, a title line and a trailing action-shaped block. */
export function RowListSkeleton({ rows = 5, className }: { rows?: number; className?: string }) {
  return (
    <div className={cn('space-y-3', className)} aria-busy>
      {Array.from({ length: rows }, (_, i) => (
        <Panel key={i} className="flex items-center gap-4 p-5">
          <div className="min-w-0 flex-1 space-y-2">
            <div className="flex items-center gap-2">
              <Skeleton className="h-3.5 w-40" />
              <Skeleton className="h-4 w-20 rounded-full" />
            </div>
            <Skeleton className="h-3 w-64 max-w-full" />
          </div>
          <Skeleton className="hidden h-8 w-28 rounded-xl sm:block" />
        </Panel>
      ))}
    </div>
  );
}