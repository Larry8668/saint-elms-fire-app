import { PAGE_SECTIONS, SECTION_TITLES, type ConceptPage, type PageSection } from '@sef/shared';
import { parse, stringify } from 'yaml';

/**
 * Concept pages are plain markdown with YAML frontmatter, readable in Obsidian.
 * Frontmatter holds machine state; sections hold the student's understanding.
 * The "Links" section is regenerated from frontmatter so Obsidian's graph view matches ours.
 */
export function serializePage(page: ConceptPage): string {
  const front = stringify({
    concept: page.concept,
    key: page.key,
    course_refs: page.courseRefs,
    status: page.status,
    evidence: page.evidence,
    misconceptions: page.misconceptions,
    links: page.links,
    updated: page.updated,
  }).trimEnd();
  const sections = PAGE_SECTIONS.map((s) => `## ${SECTION_TITLES[s]}\n${page.sections[s].trim() || '_Nothing yet._'}`).join('\n\n');
  const links = page.links.length
    ? page.links.map((l) => `- [[${l.to}]] · ${l.type.replace('_', ' ')} · ${l.origin}${l.why ? ` — ${l.why}` : ''}`).join('\n')
    : '_No links yet._';
  return `---\n${front}\n---\n# ${page.concept}\n\n${sections}\n\n## Links\n${links}\n`;
}

export function parsePage(raw: string): ConceptPage | null {
  const match = raw.match(/^---\n([\s\S]*?)\n---\n([\s\S]*)$/);
  if (!match) return null;
  const front = (parse(match[1]) ?? {}) as Record<string, unknown>;
  const body = match[2];
  const sections = Object.fromEntries(PAGE_SECTIONS.map((s) => [s, readSection(body, SECTION_TITLES[s])])) as Record<PageSection, string>;
  return {
    key: String(front.key ?? ''),
    concept: String(front.concept ?? front.key ?? ''),
    courseRefs: (front.course_refs as string[]) ?? [],
    status: (front.status as ConceptPage['status']) ?? 'met',
    evidence: (front.evidence as ConceptPage['evidence']) ?? [],
    misconceptions: (front.misconceptions as ConceptPage['misconceptions']) ?? [],
    links: (front.links as ConceptPage['links']) ?? [],
    updated: String(front.updated ?? ''),
    sections,
  };
}

function readSection(body: string, title: string): string {
  const escaped = title.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const match = body.match(new RegExp(`## ${escaped}\\n([\\s\\S]*?)(?=\\n## |$)`));
  const text = match?.[1].trim() ?? '';
  return text === '_Nothing yet._' ? '' : text;
}

export function emptyPage(key: string, concept: string, courseRefs: string[], now: string): ConceptPage {
  return {
    key,
    concept,
    courseRefs,
    status: 'met',
    evidence: [],
    misconceptions: [],
    links: [],
    updated: now,
    sections: { in_my_words: '', where_i_got_stuck: '', connections: '' },
  };
}
