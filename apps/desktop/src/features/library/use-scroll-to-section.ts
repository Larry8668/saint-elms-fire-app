import { useEffect, type RefObject } from 'react';
import { log } from '@/lib/log';

const HEADINGS = '.prose-sky h1, .prose-sky h2, .prose-sky h3, .prose-sky h4';
const FLASH_MS = 2200;

const normalise = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();

/**
 * Scrolls a rendered lesson to a section cited by a teacher and briefly highlights it.
 * The engine indexes headings the same way (h1–h4 in document order); the heading text is a fallback
 * for markdown where the two counts could disagree.
 */
export function useScrollToSection(container: RefObject<HTMLElement | null>, lessonId: string | null, index?: number, heading?: string) {
  useEffect(() => {
    if (!lessonId || (index === undefined && !heading)) return;
    let flashed: HTMLElement | undefined;
    let timer: number | undefined;
    const frame = requestAnimationFrame(() => {
      const nodes = [...(container.current?.querySelectorAll<HTMLElement>(HEADINGS) ?? [])];
      const wanted = heading ? normalise(heading) : '';
      const byIndex = index !== undefined ? nodes[index] : undefined;
      const target = byIndex && (!wanted || normalise(byIndex.textContent ?? '').startsWith(wanted.slice(0, 24)))
        ? byIndex
        : nodes.find((n) => wanted && normalise(n.textContent ?? '').startsWith(wanted.slice(0, 24))) ?? byIndex;
      if (!target) {
        log.warn('section_not_found', { lessonId, index, heading });
        return;
      }
      target.scrollIntoView({ behavior: 'smooth', block: 'start' });
      target.classList.add('section-flash');
      flashed = target;
      timer = window.setTimeout(() => target.classList.remove('section-flash'), FLASH_MS);
    });
    return () => {
      cancelAnimationFrame(frame);
      window.clearTimeout(timer);
      flashed?.classList.remove('section-flash');
    };
  }, [container, lessonId, index, heading]);
}
