import { conceptKey, EDGE_TYPES, normalizeEdgeType, type BrainEditOp, type BrainProposal, type ConceptPage, type Evidence, type Lesson, type RejectedOp } from '@sef/shared';

export const SECTION_MAX_CHARS = 600;
const MIN_TEXT_CHARS = 3;

export interface ValidationContext {
  /** Concepts this ingest may touch: key → display label. */
  allowed: Map<string, string>;
  pages: Map<string, ConceptPage>;
  /** Released lessons that were part of this session or capture. */
  touchedLessons: Lesson[];
  evidence: Evidence;
}

export interface ValidationResult {
  ops: BrainEditOp[];
  rejected: RejectedOp[];
}

const clip = (text: string) => text.trim().slice(0, SECTION_MAX_CHARS);

/**
 * Turns a model proposal into edit ops, dropping anything that breaks the rules.
 * The model can be wrong; the brain cannot become inconsistent.
 */
export function validateProposal(proposal: BrainProposal, ctx: ValidationContext): ValidationResult {
  const ops: BrainEditOp[] = [];
  const rejected: RejectedOp[] = [];
  const touched = new Set<string>();

  const resolveKey = (name: string): string | null => {
    const key = conceptKey(name);
    if (ctx.allowed.has(key)) return key;
    const byLabel = [...ctx.allowed].find(([, label]) => label.toLowerCase() === name.trim().toLowerCase());
    return byLabel?.[0] ?? null;
  };

  const ensurePage = (key: string) => {
    if (touched.has(key)) return;
    touched.add(key);
    if (!ctx.pages.has(key)) {
      const refs = ctx.touchedLessons.filter((l) => l.concepts.some((c) => conceptKey(c) === key)).map((l) => l.id);
      ops.push({ op: 'create_page', key, concept: ctx.allowed.get(key)!, courseRefs: refs });
    }
    ops.push({ op: 'add_evidence', key, evidence: ctx.evidence });
  };

  for (const page of proposal.pages) {
    const key = resolveKey(page.concept);
    if (!key) {
      rejected.push({ op: { ...page }, reason: `Unknown concept "${page.concept}"` });
      continue;
    }
    ensurePage(key);
    if (page.in_my_words.trim().length >= MIN_TEXT_CHARS) {
      ops.push({ op: 'update_section', key, section: 'in_my_words', mode: 'replace', text: clip(page.in_my_words) });
    }
    if (page.where_i_got_stuck.trim().length >= MIN_TEXT_CHARS) {
      ops.push({ op: 'update_section', key, section: 'where_i_got_stuck', mode: 'append', text: clip(page.where_i_got_stuck) });
    }
  }

  const prereqEdges = collectPrerequisites(ctx.pages);
  for (const edge of proposal.edges) {
    const from = resolveKey(edge.from);
    const to = resolveKey(edge.to);
    if (!from || !to) {
      rejected.push({ op: { ...edge }, reason: `Edge references unknown concept (${edge.from} → ${edge.to})` });
      continue;
    }
    if (from === to) {
      rejected.push({ op: { ...edge }, reason: 'Self-loop' });
      continue;
    }
    const type = normalizeEdgeType(edge.type);
    if (!type) {
      rejected.push({ op: { ...edge }, reason: `Edge type "${edge.type}" not allowed (use ${EDGE_TYPES.join(', ')})` });
      continue;
    }
    if (type === 'prerequisite' && reaches(prereqEdges, to, from)) {
      rejected.push({ op: { ...edge }, reason: 'Would create a prerequisite cycle' });
      continue;
    }
    if (ctx.pages.get(from)?.links.some((l) => l.to === to && l.type === type)) continue;
    ensurePage(from);
    ensurePage(to);
    if (type === 'prerequisite') prereqEdges.push([from, to]);
    ops.push({ op: 'add_link', from, to, type, origin: edge.student_made ? 'student' : 'suggested', why: clip(edge.why) });
  }

  for (const m of proposal.misconceptions) {
    const key = resolveKey(m.concept);
    if (!key) {
      rejected.push({ op: { ...m }, reason: `Unknown concept "${m.concept}"` });
      continue;
    }
    const lesson = ctx.touchedLessons.find((l) => l.concepts.some((c) => conceptKey(c) === key)) ?? ctx.touchedLessons[0];
    if (!lesson) {
      rejected.push({ op: { ...m }, reason: 'Misconception must cite a released lesson' });
      continue;
    }
    if (m.student_claim.trim().length < MIN_TEXT_CHARS || m.course_says.trim().length < MIN_TEXT_CHARS) {
      rejected.push({ op: { ...m }, reason: 'Misconception is missing the claim or the course statement' });
      continue;
    }
    const duplicate = ctx.pages.get(key)?.misconceptions.some((x) => !x.resolved && similar(x.claim, m.student_claim));
    if (duplicate) continue;
    ensurePage(key);
    ops.push({ op: 'flag_misconception', key, claim: clip(m.student_claim), course: clip(m.course_says), lessonRef: lesson.id });
  }

  for (const r of proposal.resolved) {
    const key = resolveKey(r.concept);
    const open = key ? ctx.pages.get(key)?.misconceptions.find((x) => !x.resolved && similar(x.claim, r.claim)) : undefined;
    if (!key || !open) {
      rejected.push({ op: { ...r }, reason: 'No matching open misconception to resolve' });
      continue;
    }
    ensurePage(key);
    ops.push({ op: 'resolve_misconception', key, claim: open.claim });
  }

  return { ops, rejected };
}

function collectPrerequisites(pages: Map<string, ConceptPage>): Array<[string, string]> {
  const edges: Array<[string, string]> = [];
  for (const page of pages.values()) {
    for (const link of page.links) if (link.type === 'prerequisite') edges.push([page.key, link.to]);
  }
  return edges;
}

function reaches(edges: Array<[string, string]>, start: string, goal: string): boolean {
  const stack = [start];
  const seen = new Set<string>();
  while (stack.length) {
    const node = stack.pop()!;
    if (node === goal) return true;
    if (seen.has(node)) continue;
    seen.add(node);
    for (const [a, b] of edges) if (a === node) stack.push(b);
  }
  return false;
}

/** Loose match so "damping increases frequency" and "Damping increases the frequency" are one claim. */
function similar(a: string, b: string): boolean {
  const words = (s: string) => new Set(s.toLowerCase().split(/[^a-z0-9]+/).filter((w) => w.length > 3));
  const wa = words(a);
  const wb = words(b);
  if (!wa.size || !wb.size) return false;
  let shared = 0;
  for (const w of wa) if (wb.has(w)) shared += 1;
  return shared / Math.min(wa.size, wb.size) >= 0.6;
}
