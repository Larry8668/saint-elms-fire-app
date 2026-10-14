import type { UseQueryResult } from '@tanstack/react-query';
import { AlertTriangle } from 'lucide-react';
import type { ReactNode } from 'react';
import { Button } from '@/components/ui/button';
import { Eyebrow, Panel, Skeleton } from '@/components/ui/primitives';
import { cn } from '@/lib/cn';

export function StatCard({ label, value, hint, tone = 'neutral' }: { label: string; value: ReactNode; hint?: string; tone?: 'neutral' | 'ember' | 'aurora' }) {
  return (
    <Panel className="p-5">
      <Eyebrow>{label}</Eyebrow>
      <div className={cn('mt-2 font-display text-4xl', tone === 'ember' ? 'text-ember-300' : tone === 'aurora' ? 'text-aurora-300' : 'text-night-100')}>{value}</div>
      {hint && <p className="mt-1 text-[12.5px] text-night-400">{hint}</p>}
    </Panel>
  );
}

export function StatCardSkeleton() {
  return (
    <Panel className="p-5">
      <Skeleton className="h-3 w-24" />
      <Skeleton className="mt-3 h-9 w-16" />
      <Skeleton className="mt-2 h-3 w-32" />
    </Panel>
  );
}

export function TableSkeleton({ rows = 6, cols = 4 }: { rows?: number; cols?: number }) {
  return (
    <div className="divide-y divide-white/[0.04]" aria-busy>
      {Array.from({ length: rows }, (_, r) => (
        <div key={r} className="flex items-center gap-4 px-5 py-3.5">
          {Array.from({ length: cols }, (_, c) => (
            <Skeleton key={c} className={cn('h-3.5', c === 0 ? 'w-40' : 'flex-1')} />
          ))}
        </div>
      ))}
    </div>
  );
}

/** Renders loading / error / data for a query so every tab handles all three states the same way. */
export function QueryState<T>({ query, skeleton, children }: { query: UseQueryResult<T>; skeleton: ReactNode; children: (data: T) => ReactNode }) {
  if (query.isPending) return <>{skeleton}</>;
  if (query.isError) {
    return (
      <div className="flex flex-col items-center gap-3 px-6 py-12 text-center">
        <AlertTriangle className="size-6 text-ember-400" />
        <p className="max-w-sm text-sm text-night-300">{(query.error as Error).message}</p>
        <Button size="sm" onClick={() => void query.refetch()}>
          Retry
        </Button>
      </div>
    );
  }
  return <>{children(query.data)}</>;
}

export function TabHeader({ title, description, actions }: { title: string; description: string; actions?: ReactNode }) {
  return (
    <header className="mb-6 flex flex-col gap-3 md:flex-row md:items-end md:justify-between">
      <div>
        <h1 className="font-display text-4xl text-night-100">{title}</h1>
        <p className="mt-1.5 max-w-2xl text-[14px] leading-6 text-night-400">{description}</p>
      </div>
      {actions && <div className="flex shrink-0 gap-2">{actions}</div>}
    </header>
  );
}

export const semesterLabel = (n: number) => (n === 0 ? 'University support' : `Semester ${n}`);

export function groupBySemester<T extends { semesterNumber: number }>(rows: T[]): Array<[number, T[]]> {
  const map = new Map<number, T[]>();
  for (const row of rows) map.set(row.semesterNumber, [...(map.get(row.semesterNumber) ?? []), row]);
  return [...map.entries()].sort((a, b) => a[0] - b[0]);
}
