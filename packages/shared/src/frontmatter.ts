import type { Lesson } from './content';

export interface Frontmatter {
  fields: Record<string, string>;
  lists: Record<string, string[]>;
  body: string;
}

/**
 * Courseware uses `***` delimiters (not `---`) with flat `key: value` scalars
 * and `key:` followed by `  - item` lists.
 */
export function parseFrontmatter(raw: string, delimiter = '***'): Frontmatter | null {
  const lines = raw.replace(/\r\n/g, '\n').split('\n');
  if (lines[0]?.trim() !== delimiter) return null;
  const fields: Record<string, string> = {};
  const lists: Record<string, string[]> = {};
  let listKey: string | null = null;
  let index = 1;
  let closed = false;
  for (; index < lines.length; index += 1) {
    const line = lines[index];
    if (line.trim() === delimiter) {
      index += 1;
      closed = true;
      break;
    }
    const item = line.match(/^\s+-\s+(.*)$/);
    if (item && listKey) {
      lists[listKey].push(unquote(item[1].trim()));
      continue;
    }
    const match = line.match(/^([A-Za-z][A-Za-z0-9_]*):\s*(.*)$/);
    if (!match) continue;
    const value = match[2].trim();
    fields[match[1]] = unquote(value);
    listKey = value ? null : match[1];
    if (listKey) lists[listKey] = [];
  }
  if (!closed) return null;
  return { fields, lists, body: lines.slice(index).join('\n').trim() };
}

function unquote(value: string): string {
  return value.replace(/^["']|["']$/g, '');
}

const OVERVIEW_MAX_CHARS = 900;

/** The lesson's Overview section, cut at a sentence boundary. */
export function lessonOverview(body: string): string | undefined {
  const match = body.match(/## Overview\n+([\s\S]*?)(?=\n## |$)/);
  if (!match) return undefined;
  const text = match[1].replace(/\s+/g, ' ').trim();
  if (!text) return undefined;
  if (text.length <= OVERVIEW_MAX_CHARS) return text;
  const head = text.slice(0, OVERVIEW_MAX_CHARS);
  const end = head.lastIndexOf('. ');
  return end > OVERVIEW_MAX_CHARS / 2 ? head.slice(0, end + 1) : `${head.trimEnd()}…`;
}

function num(value: string | undefined, fallback: number): number {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

/** Turns one courseware markdown file into a Lesson, or null if it has no frontmatter. */
export function lessonFromMarkdown(raw: string, fallbackId: string): Lesson | null {
  const parsed = parseFrontmatter(raw);
  if (!parsed) return null;
  const { fields, lists, body } = parsed;
  const courseId = fields.courseId || 'unassigned';
  const moduleNumber = num(fields.moduleNumber, 1);
  return {
    id: fields.lessonId || fallbackId,
    courseId,
    courseName: fields.courseName || courseId,
    moduleId: fields.moduleId || `${courseId}-module-${moduleNumber}`,
    moduleName: fields.moduleName || `Module ${moduleNumber}`,
    subjectId: fields.subjectId || 'programme',
    semesterNumber: num(fields.semesterNumber, 0),
    order: num(fields.lessonNumber ?? fields.releaseOrder, 0),
    title: fields.lessonName || fields.title || fallbackId,
    summary: lessonOverview(body),
    concepts: lists.concepts ?? [],
    prerequisites: lists.prerequisites ?? [],
    tags: lists.tags ?? [],
    estimatedStudyMinutes: fields.estimatedStudyMinutes ? num(fields.estimatedStudyMinutes, 0) : undefined,
    markdown: body,
  };
}
