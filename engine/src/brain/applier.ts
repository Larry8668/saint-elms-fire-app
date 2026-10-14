import type { BrainDiffEntry, BrainEditOp, ConceptPage } from '@sef/shared';
import { computeStatus } from './mastery';
import { emptyPage } from './page-format';
import type { BrainVault } from './vault';

/** Applies validated ops to the vault and returns a per-page diff. */
export async function applyOps(vault: BrainVault, ops: BrainEditOp[]): Promise<BrainDiffEntry[]> {
  const now = new Date().toISOString();
  const working = new Map<string, { page: ConceptPage; created: boolean; statusBefore: ConceptPage['status'] }>();

  const load = async (key: string, concept?: string, refs: string[] = []) => {
    const cached = working.get(key);
    if (cached) return cached.page;
    const existing = await vault.get(key);
    const page = existing ? structuredClone(existing) : emptyPage(key, concept ?? key, refs, now);
    working.set(key, { page, created: !existing, statusBefore: computeStatus(existing ?? null) });
    return page;
  };

  for (const op of ops) {
    switch (op.op) {
      case 'create_page':
        await load(op.key, op.concept, op.courseRefs);
        break;
      case 'update_section': {
        const page = await load(op.key);
        const current = page.sections[op.section].trim();
        page.sections[op.section] = op.mode === 'append' && current ? `${current}\n- ${op.text}` : op.mode === 'append' ? `- ${op.text}` : op.text;
        break;
      }
      case 'add_link': {
        const page = await load(op.from);
        if (!page.links.some((l) => l.to === op.to && l.type === op.type)) {
          page.links.push({ to: op.to, type: op.type, origin: op.origin, why: op.why });
        }
        break;
      }
      case 'add_evidence': {
        const page = await load(op.key);
        if (!page.evidence.some((e) => e.kind === op.evidence.kind && e.ref === op.evidence.ref)) page.evidence.push(op.evidence);
        break;
      }
      case 'flag_misconception': {
        const page = await load(op.key);
        page.misconceptions.push({ claim: op.claim, course: op.course, lessonRef: op.lessonRef, flagged: now, resolved: false });
        break;
      }
      case 'resolve_misconception': {
        const page = await load(op.key);
        const target = page.misconceptions.find((m) => !m.resolved && m.claim === op.claim);
        if (target) target.resolved = true;
        break;
      }
    }
  }

  const diff: BrainDiffEntry[] = [];
  for (const { page, created, statusBefore } of working.values()) {
    const { before, after } = await vault.save(page);
    diff.push({
      key: page.key,
      concept: page.concept,
      change: created ? 'created' : 'updated',
      before: before ?? undefined,
      after,
      statusBefore,
      statusAfter: computeStatus(page),
    });
  }
  if (diff.length) await vault.writeIndex();
  return diff;
}
