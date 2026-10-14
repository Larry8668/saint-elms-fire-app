import type { ConceptPage, LintFinding } from '@sef/shared';
import { conceptKey } from '@sef/shared';
import type { CourseGraph } from './course-graph';
import { computeStatus } from './mastery';

const OVERSIZED_CHARS = 1500;

/**
 * Deterministic health checks. Findings double as teaching prompts:
 * the Guide opens with a Socratic question aimed at the top one.
 */
export function lintBrain(pages: Map<string, ConceptPage>, course: CourseGraph): LintFinding[] {
  const findings: LintFinding[] = [];

  for (const page of pages.values()) {
    for (const m of page.misconceptions.filter((x) => !x.resolved)) {
      findings.push({
        kind: 'misconception',
        key: page.key,
        concept: page.concept,
        message: `You said "${m.claim}", but the course says: ${m.course}`,
        prompt: `Earlier you said "${m.claim}" about ${page.concept}. What would you expect to happen if that were true — and does the lesson agree?`,
      });
    }
    const size = Object.values(page.sections).join('').length;
    if (size > OVERSIZED_CHARS) {
      findings.push({
        kind: 'oversized',
        key: page.key,
        concept: page.concept,
        message: `The page on ${page.concept} is getting long.`,
        prompt: `Can you sum up ${page.concept} in two sentences?`,
      });
    }
  }

  // A concept you are actively working on whose prerequisite lesson introduced something still shaky.
  const lessonsById = new Map(course.lessons.map((l) => [l.id, l]));
  for (const page of pages.values()) {
    const intro = course.concepts.get(page.key)?.introducedBy;
    if (!intro) continue;
    for (const prereqId of intro.prerequisites) {
      const prereq = lessonsById.get(prereqId);
      for (const label of prereq?.concepts ?? []) {
        const shaky = pages.get(conceptKey(label));
        if (shaky && computeStatus(shaky) === 'shaky' && shaky.key !== page.key) {
          findings.push({
            kind: 'shaky_prerequisite',
            key: page.key,
            concept: page.concept,
            message: `${page.concept} builds on ${shaky.concept}, which is still shaky.`,
            prompt: `Before going further with ${page.concept}, how would you explain ${shaky.concept} to a friend?`,
          });
        }
      }
    }
  }

  const order: Record<LintFinding['kind'], number> = { misconception: 0, shaky_prerequisite: 1, orphan: 2, oversized: 3 };
  return dedupe(findings).sort((a, b) => order[a.kind] - order[b.kind]);
}

function dedupe(findings: LintFinding[]): LintFinding[] {
  const seen = new Set<string>();
  return findings.filter((f) => {
    const id = `${f.kind}:${f.key}:${f.message}`;
    if (seen.has(id)) return false;
    seen.add(id);
    return true;
  });
}
