/** Short, unambiguous timestamps for registrar tables. Falls back to the raw value when unparsable. */
export function formatTimestamp(value: string | null | undefined): string {
  if (!value) return '—';
  const parsed = Date.parse(value);
  if (Number.isNaN(parsed)) return value;
  return new Date(parsed).toLocaleString(undefined, {
    year: 'numeric',
    month: 'short',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
  });
}

/** Relative age, for "updated 3 minutes ago" lines beside an exact time. */
export function formatRelative(value: string | null | undefined): string {
  if (!value) return '—';
  const parsed = Date.parse(value);
  if (Number.isNaN(parsed)) return '';
  const seconds = Math.round((Date.now() - parsed) / 1000);
  if (seconds < 60) return 'just now';
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `${minutes} min ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `${hours} h ago`;
  return `${Math.round(hours / 24)} d ago`;
}

export const displayName = (legal: string, preferred: string | null): string =>
  preferred && preferred.trim() ? `${legal} (${preferred})` : legal;