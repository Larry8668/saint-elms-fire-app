import path from 'node:path';
import type { Evidence } from '@sef/shared';
import { readJson } from '../lib/fs';
import type { EvidenceResolver } from './vault';
import type { WikiStore } from './wiki-store';

interface QuizResultRecord {
  id: string;
  quizId: string;
  score: number;
  outOf: number;
  at: string;
}

/** Evidence kinds a source record can honestly stand for: the student's own artifacts. */
const SOURCE_EVIDENCE_KIND: Record<string, Evidence['kind']> = {
  session: 'session',
  note: 'capture',
  image: 'capture',
  peer: 'share',
};

/**
 * Turns a learner.evidenceIds entry back into the evidence it points at. Quiz results are
 * files next to the quiz; sources are vault records. Anything else — or anything missing —
 * resolves to nothing rather than inventing evidence.
 */
export function evidenceResolver(quizzesDir: string, store: WikiStore): EvidenceResolver {
  return async (id) => {
    if (id.startsWith('res_')) {
      const result = await readJson<QuizResultRecord | null>(path.join(quizzesDir, `${id}.json`), null);
      return result ? { kind: 'quiz', ref: result.quizId, at: result.at, score: result.score, outOf: result.outOf } : null;
    }
    if (id.startsWith('src_')) {
      const record = await store.readSource(id);
      const kind = record ? SOURCE_EVIDENCE_KIND[record.kind] : undefined;
      return record && kind ? { kind, ref: record.id, at: record.createdAt, note: record.title } : null;
    }
    return null;
  };
}
