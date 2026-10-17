import { CONTRACT_VERSION, MAX_SUGGESTIONS, type ProactivitySettings, type SuggestedQuestion, type SuggestionsResponse, type TeacherId } from '@sef/shared';
import { errorFields, log } from '../config';
import { sha256Hex } from '../lib/hash';
import { acceptDraft, type Rephrase } from './draft';
import { diversify, rank } from './score';
import { extractSeeds, seedsFor, type Seed, type SeedInputs } from './seeds';
import type { SuggestionStore } from './store';
import { templateText } from './templates';

const CACHE_TTL_MS = 86_400_000;

export interface SuggestionDeps {
  store: SuggestionStore;
  inputs: () => Promise<Omit<SeedInputs, 'now'>>;
  /** The student's own recent messages to this teacher, newest first. */
  recentTurns: (teacher: TeacherId) => Promise<string[]>;
  proactivity: () => Promise<Pick<ProactivitySettings, 'nudges' | 'draftedAdvice'>>;
  /** Present only when a model can be resolved; drafted wording is still opt-in. */
  rephrase?: Rephrase;
  now?: () => Date;
}

const questionId = (teacher: TeacherId, seed: Seed) => `sq_${sha256Hex(`${teacher}|${seed.key}`).slice(0, 24)}`;

function fingerprint(teacher: TeacherId, drafted: boolean, seeds: Seed[]): string {
  return sha256Hex(JSON.stringify([teacher, drafted, seeds.map((s) => [s.key, s.slots])]));
}

/** Every entity name the student's stores mention — the drafted-wording check's "known world". */
function entityUniverse(seeds: Seed[]): Set<string> {
  return new Set(seeds.flatMap((seed) => Object.entries(seed.slots).filter(([slot]) => slot !== 'day').map(([, value]) => value)));
}

/**
 * The suggested-question bank. Seeds → policy scope → rank → template wording → cap 5,
 * cached per teacher and regenerated when the seed set changes or a day passes. Drafted
 * wording runs in the background and never delays a response.
 */
export class SuggestionService {
  private readonly drafting = new Map<TeacherId, Promise<void>>();

  constructor(private readonly deps: SuggestionDeps) {}

  private now() {
    return this.deps.now?.() ?? new Date();
  }

  async get(teacher: TeacherId): Promise<SuggestionsResponse> {
    const now = this.now();
    const settings = await this.deps.proactivity();
    if (!settings.nudges) return this.response(teacher, now, [], 'templates');

    const [inputs, turns] = await Promise.all([this.deps.inputs(), this.deps.recentTurns(teacher).catch(() => [])]);
    const all = extractSeeds({ ...inputs, now });
    const live = (seed: Seed) => seed.expiresAt > now.getTime();
    const chosen = diversify(rank(seedsFor(teacher, all).filter(live), now, turns), MAX_SUGGESTIONS);
    const drafted = settings.draftedAdvice && this.deps.rephrase !== undefined;
    const print = fingerprint(teacher, drafted, chosen);

    const cached = await this.deps.store.read(teacher);
    if (cached && cached.fingerprint === print && now.getTime() - Date.parse(cached.response.generatedAt) < CACHE_TTL_MS) {
      return { ...cached.response, questions: cached.response.questions.filter((q) => Date.parse(q.expiresAt) > now.getTime()) };
    }

    const response = this.response(
      teacher,
      now,
      chosen.map((seed) => this.question(teacher, seed, templateText(seed, teacher), now)),
      'templates',
    );
    await this.deps.store.write(teacher, print, response).catch((error) => log.warn('suggestion_cache_write_failed', { teacher, ...errorFields(error) }));
    log.info('suggestions_generated', { teacher, count: response.questions.length, kinds: chosen.map((s) => s.kind) });
    if (drafted && chosen.some((seed) => seed.draftable !== false)) this.scheduleDraft(teacher, print, chosen, entityUniverse(all), response);
    return response;
  }

  /** Resolves once any background drafting has settled (tests and shutdown). */
  async idle(): Promise<void> {
    await Promise.all(this.drafting.values());
  }

  private response(teacher: TeacherId, now: Date, questions: SuggestedQuestion[], mode: SuggestionsResponse['mode']): SuggestionsResponse {
    return { schemaVersion: CONTRACT_VERSION, teacher, questions, generatedAt: now.toISOString(), mode };
  }

  private question(teacher: TeacherId, seed: Seed, text: string, now: Date): SuggestedQuestion {
    return {
      id: questionId(teacher, seed),
      teacher,
      text,
      why: seed.why,
      seedRefs: seed.refs.slice(0, 10),
      generatedAt: now.toISOString(),
      expiresAt: new Date(seed.expiresAt).toISOString(),
    };
  }

  private scheduleDraft(teacher: TeacherId, print: string, seeds: Seed[], universe: Set<string>, base: SuggestionsResponse): void {
    if (this.drafting.has(teacher)) return;
    const run = this.draft(teacher, print, seeds, universe, base).finally(() => this.drafting.delete(teacher));
    this.drafting.set(teacher, run);
  }

  private async draft(teacher: TeacherId, print: string, seeds: Seed[], universe: Set<string>, base: SuggestionsResponse): Promise<void> {
    const rephrase = this.deps.rephrase;
    if (!rephrase) return;
    const targets = base.questions.map((question, index) => ({ question, index, seed: seeds[index]! })).filter((t) => t.seed.draftable !== false);
    if (!targets.length) return;
    let drafts: string[];
    try {
      drafts = await rephrase(
        teacher,
        targets.map((t) => t.question.text),
      );
    } catch (error) {
      log.warn('suggestion_draft_failed', { teacher, ...errorFields(error) });
      return;
    }
    const replaced = new Map<number, string>();
    targets.forEach((t, j) => {
      if (acceptDraft(drafts[j], t.seed, universe)) replaced.set(t.index, drafts[j]!.trim());
    });
    const rejected = targets.length - replaced.size;
    if (rejected) log.info('suggestion_draft_rejected', { teacher, rejected });
    if (!replaced.size) return;
    const questions = base.questions.map((q, i) => (replaced.has(i) ? { ...q, text: replaced.get(i)! } : q));
    const current = await this.deps.store.read(teacher);
    // A newer seed set may have replaced the bank while the model was thinking.
    if (current?.fingerprint !== print) return;
    const mode = replaced.size === questions.length ? 'drafted' : 'hybrid';
    await this.deps.store
      .write(teacher, print, { ...base, questions, mode })
      .catch((error) => log.warn('suggestion_cache_write_failed', { teacher, ...errorFields(error) }));
  }
}
