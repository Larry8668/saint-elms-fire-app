import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from 'react';
import { TEACHER_IDS, type TeacherId } from '@sef/shared';
import { log } from './log';

export const VIEWS = ['sky', 'teachers', 'library', 'brain', 'contribute', 'peers', 'settings'] as const;
export type View = (typeof VIEWS)[number];

export interface NavState {
  view: View;
  /** Lesson open in the library reader. */
  lessonId?: string;
  /** Heading to scroll to in that lesson: its position among the lesson's h1–h4 headings. */
  section?: number;
  /** Text of that heading, used to find it if the index drifts. History state only. */
  sectionHeading?: string;
  /** Concept focused in the sky or brain. */
  conceptKey?: string;
  /**
   * Vault page to focus — any kind, resolved through the graph's pageId anchors. This is the
   * stable deep-link the timeline and the next milestone (PR-21) hang selection off.
   */
  page?: string;
  teacher?: TeacherId;
  /** Text to pre-fill in the chat composer. Kept in history state only, never in the URL. */
  draft?: string;
  /** Page preselected in the publish dialog on the peers view. History state only. */
  sharePage?: string;
}

interface NavContextValue extends NavState {
  go: (view: View, params?: Omit<NavState, 'view'>) => void;
  back: () => void;
}

const NavContext = createContext<NavContextValue | null>(null);

const URL_PARAMS = { lessonId: 'lesson', conceptKey: 'concept', teacher: 'teacher', page: 'page' } as const;

/** Hash routes (`#/teachers?teacher=guide`) work in the browser and under Tauri's custom protocol alike. */
function toHash(state: NavState): string {
  const params = new URLSearchParams();
  for (const [key, name] of Object.entries(URL_PARAMS)) {
    const value = state[key as keyof typeof URL_PARAMS];
    if (value) params.set(name, value);
  }
  if (state.lessonId && state.section !== undefined) params.set('section', String(state.section));
  const query = params.toString();
  return `#/${state.view}${query ? `?${query}` : ''}`;
}

function fromHash(hash: string): NavState {
  const [path = '', query = ''] = hash.replace(/^#\/?/, '').split('?');
  const view = (VIEWS as readonly string[]).includes(path) ? (path as View) : 'sky';
  const params = new URLSearchParams(query);
  const teacher = params.get('teacher');
  const lessonId = params.get('lesson') ?? undefined;
  const rawSection = params.get('section') ?? '';
  return {
    view,
    lessonId,
    section: lessonId && /^\d+$/.test(rawSection) ? Number(rawSection) : undefined,
    conceptKey: params.get('concept') ?? undefined,
    page: params.get('page') ?? undefined,
    teacher: teacher && (TEACHER_IDS as readonly string[]).includes(teacher) ? (teacher as TeacherId) : undefined,
  };
}

const readHistory = (): NavState => (window.history.state as NavState | null)?.view ? (window.history.state as NavState) : fromHash(window.location.hash);

export function NavProvider({ children }: { children: ReactNode }) {
  const [state, setState] = useState<NavState>(readHistory);

  useEffect(() => {
    window.history.replaceState(state, '', toHash(state));
    const onPop = () => setState(readHistory());
    window.addEventListener('popstate', onPop);
    return () => window.removeEventListener('popstate', onPop);
  }, []);

  // Desktop shells have no back button: support the usual shortcuts and mouse side buttons.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const mod = e.metaKey || e.ctrlKey;
      if ((mod && e.key === '[') || (e.altKey && e.key === 'ArrowLeft')) window.history.back();
      if ((mod && e.key === ']') || (e.altKey && e.key === 'ArrowRight')) window.history.forward();
    };
    const onMouse = (e: MouseEvent) => {
      if (e.button === 3) window.history.back();
      if (e.button === 4) window.history.forward();
    };
    window.addEventListener('keydown', onKey);
    window.addEventListener('mouseup', onMouse);
    return () => {
      window.removeEventListener('keydown', onKey);
      window.removeEventListener('mouseup', onMouse);
    };
  }, []);

  const go = useCallback((view: View, params: Omit<NavState, 'view'> = {}) => {
    const next: NavState = { view, ...params };
    log.info('navigate', { view, ...params, draft: params.draft ? '[draft]' : undefined });
    const hash = toHash(next);
    if (hash === window.location.hash) window.history.replaceState(next, '', hash);
    else window.history.pushState(next, '', hash);
    setState(next);
  }, []);

  const back = useCallback(() => window.history.back(), []);

  const value = useMemo(() => ({ ...state, go, back }), [state, go, back]);
  return <NavContext.Provider value={value}>{children}</NavContext.Provider>;
}

export function useNav(): NavContextValue {
  const ctx = useContext(NavContext);
  if (!ctx) throw new Error('useNav must be used inside NavProvider');
  return ctx;
}
