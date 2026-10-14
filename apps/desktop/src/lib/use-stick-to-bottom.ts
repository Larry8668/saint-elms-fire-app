import { useCallback, useEffect, useRef, useState } from 'react';

const NEAR_BOTTOM_PX = 120;

/**
 * Keeps a scroll container pinned to the newest content while the reader is at the bottom,
 * and leaves them alone once they scroll up to reread.
 */
export function useStickToBottom<T extends HTMLElement>(dependency: unknown) {
  const ref = useRef<T>(null);
  const pinned = useRef(true);
  const [atBottom, setAtBottom] = useState(true);

  const onScroll = useCallback(() => {
    const el = ref.current;
    if (!el) return;
    const near = el.scrollHeight - el.scrollTop - el.clientHeight < NEAR_BOTTOM_PX;
    pinned.current = near;
    setAtBottom(near);
  }, []);

  const scrollToBottom = useCallback((behavior: ScrollBehavior = 'smooth') => {
    const el = ref.current;
    if (!el) return;
    pinned.current = true;
    el.scrollTo({ top: el.scrollHeight, behavior });
  }, []);

  useEffect(() => {
    if (pinned.current) scrollToBottom('auto');
  }, [dependency, scrollToBottom]);

  return { ref, onScroll, atBottom, scrollToBottom };
}
