import { readdir, rm } from 'node:fs/promises';
import path from 'node:path';
import { StudyPlanSchema, type StudyPlan } from '@sef/shared';
import { log } from '../config';
import { readJson, writeJson } from '../lib/fs';

const ID = /^plan_[a-z0-9]{8,32}$/;

/**
 * One JSON file per plan under the profile root — operational state kept outside the vault,
 * so a plan never becomes a wiki page or enters an export. A file that fails the contract
 * is skipped and logged, never repaired by guessing.
 */
export class PlanStore {
  constructor(private readonly dir: string) {}

  private file(id: string): string | null {
    return ID.test(id) ? path.join(this.dir, `${id}.json`) : null;
  }

  async get(id: string): Promise<StudyPlan | null> {
    const file = this.file(id);
    if (!file) return null;
    let raw: unknown;
    try {
      raw = await readJson<unknown>(file, null);
    } catch (error) {
      log.warn('plan_unreadable', { id, issue: (error as Error).message });
      return null;
    }
    if (raw === null) return null;
    const parsed = StudyPlanSchema.safeParse(raw);
    if (!parsed.success) {
      log.warn('plan_unreadable', { id, issue: parsed.error.issues[0]?.message });
      return null;
    }
    return parsed.data;
  }

  async list(): Promise<StudyPlan[]> {
    const names = await readdir(this.dir).catch(() => [] as string[]);
    const plans = await Promise.all(names.filter((n) => n.endsWith('.json')).map((n) => this.get(n.slice(0, -5))));
    return plans.filter((p): p is StudyPlan => p !== null);
  }

  async put(plan: StudyPlan): Promise<void> {
    const file = this.file(plan.id);
    if (!file) throw new Error(`Invalid plan id: ${plan.id}`);
    await writeJson(file, StudyPlanSchema.parse(plan));
  }

  async remove(id: string): Promise<void> {
    const file = this.file(id);
    if (file) await rm(file, { force: true });
  }
}
