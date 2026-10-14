import type { Lesson } from '@sef/shared';

const STOPWORDS = new Set([
  'about', 'and', 'are', 'been', 'but', 'can', 'could', 'did', 'does', 'for', 'from', 'have', 'how', 'into',
  'not', 'our', 'over', 'should', 'that', 'the', 'their', 'them', 'there', 'these', 'they', 'this', 'those',
  'under', 'was', 'were', 'what', 'when', 'where', 'which', 'who', 'why', 'will', 'with', 'would', 'you', 'your',
  'explain', 'please', 'tell', 'walk', 'through', 'mean', 'means', 'quiz', 'me', 'my', 'is', 'it', 'its',
]);

export function queryTerms(text: string): string[] {
  const seen = new Set<string>();
  for (const term of text.toLowerCase().split(/[^a-z0-9]+/)) {
    if (term.length >= 3 && !STOPWORDS.has(term)) seen.add(term);
  }
  return [...seen];
}

function forms(term: string): string[] {
  const out = new Set([term]);
  if (term.endsWith('ies') && term.length > 4) out.add(`${term.slice(0, -3)}y`);
  else if (term.endsWith('es') && term.length > 4) out.add(term.slice(0, -2));
  else if (term.endsWith('s') && term.length > 3) out.add(term.slice(0, -1));
  else out.add(`${term}s`);
  return [...out];
}

function hits(field: string, termForms: string[]): number {
  const words = field.toLowerCase().split(/[^a-z0-9]+/);
  let count = 0;
  for (const word of words) if (termForms.includes(word)) count += 1;
  return count;
}

export interface LessonHit {
  lesson: Lesson;
  score: number;
  excerpt: string;
}

/**
 * Weighted keyword retrieval over lesson title, concepts, headings and body.
 * Deterministic and offline; good enough for ~500 lessons without a vector index.
 */
export function searchLessons(lessons: Lesson[], query: string, limit = 3): LessonHit[] {
  const terms = queryTerms(query);
  if (!terms.length) return [];
  const scored = lessons.map((lesson) => {
    const headings = lesson.markdown.split('\n').filter((l) => /^#{1,4}\s/.test(l)).join(' ');
    let covered = 0;
    const score = terms.reduce((total, term) => {
      const f = forms(term);
      const t = hits(lesson.title, f) * 8;
      const c = hits(lesson.concepts.join(' '), f) * 6;
      const h = hits(headings, f) * 4;
      const b = Math.min(hits(lesson.markdown, f), 5);
      if (t + c + h + b > 0) covered += 1;
      return total + t + c + h + b;
    }, 0);
    return { lesson, score: score * (covered / terms.length) };
  });
  const ranked = scored.filter((s) => s.score > 0).sort((a, b) => b.score - a.score);
  const floor = (ranked[0]?.score ?? 0) * 0.4;
  return ranked
    .filter((s) => s.score >= floor)
    .slice(0, limit)
    .map((s) => ({ ...s, excerpt: excerptFor(s.lesson, terms) }));
}

/** The window of the lesson body that best matches the query terms. */
export function excerptFor(lesson: Lesson, terms: string[], maxChars = 1400): string {
  const body = lesson.markdown;
  if (body.length <= maxChars) return body;
  const allForms = terms.flatMap(forms);
  const lower = body.toLowerCase();
  let bestStart = 0;
  let bestScore = -1;
  for (let start = 0; start < body.length; start += 250) {
    const slice = lower.slice(start, start + maxChars);
    const score = allForms.reduce((n, form) => n + (slice.split(form).length - 1), 0);
    if (score > bestScore) {
      bestScore = score;
      bestStart = start;
    }
  }
  const lineStart = body.lastIndexOf('\n', bestStart);
  const start = lineStart > 0 ? lineStart + 1 : bestStart;
  return body.slice(start, start + maxChars).trim();
}

/** Lessons that list a concept (by key) in their frontmatter. */
export function lessonsForConcept(lessons: Lesson[], key: string, keyOf: (label: string) => string): Lesson[] {
  return lessons.filter((l) => l.concepts.some((c) => keyOf(c) === key));
}
