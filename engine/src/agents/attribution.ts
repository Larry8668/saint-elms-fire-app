import type { Lesson, SourceRef } from '@sef/shared';
import { queryTerms } from '../content/search';

export interface LessonSection {
  heading: string;
  /** Position among the lesson's h1–h4 headings (document order); -1 for text before the first heading. */
  index: number;
  text: string;
}

export type Attribution = Pick<SourceRef, 'cited' | 'section' | 'excerpt' | 'courseName'>;

const HEADING = /^(#{1,4})\s+(.+?)\s*#*\s*$/;
const FENCE = /^\s*(```|~~~)/;
/** An answer must share at least this many answer-specific terms with a lesson section to count as citing it. */
const MIN_SHARED_TERMS = 4;
/** …and at least this fraction of the best-matching lesson's overlap, so a weak runner-up isn't credited. */
const RELATIVE_FLOOR = 0.5;
const EXCERPT_CHARS = 360;

const stripInline = (s: string) => s.replace(/[*_`]/g, '').trim();

/**
 * Splits lesson markdown into heading-delimited sections. Heading indices count h1–h4 outside fenced code,
 * matching the order the reader renders them in, so `index` works as a deep-link anchor.
 */
export function lessonSections(markdown: string): LessonSection[] {
  const sections: Array<{ heading: string; index: number; lines: string[] }> = [{ heading: '', index: -1, lines: [] }];
  let inFence = false;
  let count = 0;
  for (const line of markdown.split('\n')) {
    if (FENCE.test(line)) inFence = !inFence;
    const match = inFence ? null : HEADING.exec(line);
    if (match) {
      sections.push({ heading: stripInline(match[2]!), index: count++, lines: [] });
      continue;
    }
    sections.at(-1)!.lines.push(line);
  }
  return sections.map((s) => ({ heading: s.heading, index: s.index, text: s.lines.join('\n').trim() })).filter((s) => s.text.length > 0);
}

const sharedCount = (terms: Set<string>, text: string) => {
  let n = 0;
  for (const t of queryTerms(text)) if (terms.has(t)) n += 1;
  return n;
};

/** Best paragraph of a section for the answer, trimmed without splitting inline maths. */
function excerptFrom(section: LessonSection, terms: Set<string>): string {
  const paragraphs = section.text.split(/\n\s*\n/).map((p) => p.trim()).filter((p) => p.length > 40 && !FENCE.test(p));
  const best = paragraphs.reduce<{ p: string; n: number }>((acc, p) => {
    const n = sharedCount(terms, p);
    return n > acc.n ? { p, n } : acc;
  }, { p: paragraphs[0] ?? section.text, n: -1 }).p;
  if (best.length <= EXCERPT_CHARS) return best;
  let cut = best.slice(0, EXCERPT_CHARS);
  const sentenceEnd = cut.lastIndexOf('. ');
  if (sentenceEnd > EXCERPT_CHARS / 2) cut = cut.slice(0, sentenceEnd + 1);
  if ((cut.match(/\$/g)?.length ?? 0) % 2 === 1) cut = cut.slice(0, cut.lastIndexOf('$')).trimEnd();
  return `${cut.trimEnd()}…`;
}

const normalise = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();

/**
 * Decides which retrieved lessons an answer actually drew on, and where. Deterministic: it measures how many
 * answer-specific terms (words in the answer but not in the question) each lesson section shares with the answer.
 * Question words are excluded because every retrieved lesson matches those by construction.
 */
export function attributeLessons(answer: string, question: string, lessons: Lesson[]): Map<string, Attribution> {
  const questionTerms = new Set(queryTerms(question));
  const answerTerms = new Set(queryTerms(answer).filter((t) => !questionTerms.has(t)));
  const answerText = normalise(answer);

  const scored = lessons.map((lesson) => {
    const sections = lessonSections(lesson.markdown);
    const best = sections.reduce<{ section?: LessonSection; n: number }>((acc, section) => {
      const n = sharedCount(answerTerms, `${section.heading}\n${section.text}`);
      return n > acc.n ? { section, n } : acc;
    }, { n: 0 });
    const named = lesson.title.length > 6 && answerText.includes(normalise(lesson.title));
    return { lesson, best, named };
  });

  const top = Math.max(0, ...scored.map((s) => s.best.n));
  const result = new Map<string, Attribution>();
  for (const { lesson, best, named } of scored) {
    const cited = named || (best.n >= MIN_SHARED_TERMS && best.n >= top * RELATIVE_FLOOR);
    const section = best.section;
    result.set(lesson.id, {
      cited,
      courseName: lesson.courseName,
      section: section && section.index >= 0 ? { heading: section.heading, index: section.index } : undefined,
      excerpt: section ? excerptFrom(section, answerTerms) : undefined,
    });
  }
  return result;
}
