import { useEffect, useState } from 'react';
import { isIdentifier } from '../api/guards';

/**
 * Hash routing, so the staff portal never needs a server-side SPA fallback: the uni serves
 * `/admin` from the built `index.html`, and every view lives behind the fragment.
 *
 * Filters and pagination are kept in the fragment too, so a registrar can send a colleague
 * the exact list they are looking at rather than describing it.
 */
export interface Route {
  view: 'students' | 'staff' | 'erasure' | 'audit';
  /** Student profile id for the `students` view's detail pane. */
  id: string | null;
  params: URLSearchParams;
}

const VIEWS = new Set(['students', 'staff', 'erasure', 'audit']);

const parse = (hash: string): Route => {
  const path = hash.replace(/^#/, '');
  const [pathname, search = ''] = path.split('?');
  const segments = pathname.split('/').filter(Boolean);
  const first = segments[0] ?? 'students';
  const view = VIEWS.has(first) ? (first as Route['view']) : 'students';
  return {
    view,
    // An unrecognised detail segment is dropped, not passed on as a profile id.
    id: view === 'students' && segments[1] && isIdentifier(segments[1]) ? segments[1] : null,
    params: new URLSearchParams(search),
  };
};

export function useHashRoute(): { route: Route; navigate: (to: string) => void } {
  const [hash, setHash] = useState(() => window.location.hash);

  useEffect(() => {
    const onChange = () => setHash(window.location.hash);
    window.addEventListener('hashchange', onChange);
    return () => window.removeEventListener('hashchange', onChange);
  }, []);

  return {
    route: parse(hash),
    navigate: (to: string) => {
      window.location.hash = to;
    },
  };
}

/** Builds a `#/view?a=b` fragment from the current filters, overriding only what changed. */
export function linkTo(view: string, overrides: Record<string, string | number | undefined>, base: URLSearchParams): string {
  const params = new URLSearchParams(base);
  for (const [key, value] of Object.entries(overrides)) {
    if (value === undefined || value === '') params.delete(key);
    else params.set(key, String(value));
  }
  const query = params.toString();
  return query ? `#/${view}?${query}` : `#/${view}`;
}