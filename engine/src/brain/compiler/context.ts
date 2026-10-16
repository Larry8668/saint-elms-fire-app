import { conceptKey, type SourceRecord } from '@sef/shared';
import type { CourseGraph } from '../course-graph';
import { INDEX_FILE, PAGE_KINDS } from '../vault-layout';
import type { PageSnapshot, WikiStore } from '../wiki-store';
import type { SourceBlob } from './citations';

/**
 * What the keeper model is shown. Bounded on every axis: the prompt stays small enough for
 * a local model to hold, and everything in it was read fresh from the vault at compile time.
 */
export interface KeeperContext {
  conventionsRevision: string;
  /** Pages the material plausibly touches — existing summaries the update must preserve. */
  pages: PageSnapshot[];
  /** Every readable page in the vault — normalize resolves out-of-scope targets from it. */
  allPages: PageSnapshot[];
  /** Every page in the vault: id → title. Links may target any of them, even out of scope. */
  pageIndex: Map<string, string>;
  /** The job's sources with the text their extraction produced. */
  blobs: SourceBlob[];
  /** Course concepts named in the material: conceptKey → label, for courseRefs and naming. */
  allowedConcepts: Map<string, string>;
  prompt: string;
}

const MAX_PAGES_IN_SCOPE = 10;
const MAX_PAGE_CHARS = 3000;
const MAX_INDEX_CHARS = 3000;
const MAX_SOURCE_CHARS = 6000;
const MAX_ALLOWED_CONCEPTS = 40;

interface KeeperContextOptions {
  /** Full extracted text of the job's sources, used to pick in-scope pages and concepts. */
  material: string;
  courseGraph: CourseGraph;
}

/**
 * Assembles the keeper's view: conventions revision, the index, the pages this material
 * plausibly touches (with their one-hop neighbourhood), and the source text itself.
 */
export async function keeperContext(store: WikiStore, blobs: SourceBlob[], opts: KeeperContextOptions): Promise<KeeperContext> {
  const conventions = await store.readConventions();
  const index = await store.readIndex();
  const material = opts.material.toLowerCase();

  const allowedConcepts = new Map<string, string>();
  for (const concept of opts.courseGraph.concepts.values()) {
    if (allowedConcepts.size >= MAX_ALLOWED_CONCEPTS) break;
    if (concept.label.length > 4 && material.includes(concept.label.toLowerCase())) allowedConcepts.set(concept.key, concept.label);
  }

  const sourceIds = new Set(blobs.map((blob) => blob.record.id));
  const all = await store.listPages();
  const pageIndex = new Map<string, string>();
  for (const page of all) {
    if (page.state === 'ok') pageIndex.set(page.id, page.metadata?.title ?? page.legacy?.concept ?? page.id);
  }
  const inScope = new Map<string, PageSnapshot>();
  const admit = (page: PageSnapshot | null | undefined) => {
    if (!page || page.state !== 'ok' || inScope.size >= MAX_PAGES_IN_SCOPE) return;
    inScope.set(page.id, page);
  };

  // Pages that already cite these sources are in scope, then pages whose title or mapped
  // concept appears in the material.
  for (const page of all) {
    if (page.metadata?.sourceIds.some((id) => sourceIds.has(id))) admit(page);
  }
  for (const page of all) {
    if (inScope.has(page.id)) continue;
    const title = (page.metadata?.title ?? page.legacy?.concept ?? '').toLowerCase();
    if (title.length > 4 && material.includes(title)) admit(page);
    else if (page.kind === 'concept' && allowedConcepts.has(page.id)) admit(page);
  }
  // One hop of neighbourhood: pages linked from an in-scope page, so an update does not
  // contradict or duplicate a page it could not see.
  for (const page of [...inScope.values()]) {
    for (const link of page.metadata?.links ?? []) {
      admit(all.find((candidate) => candidate.id === link.toPageId) ?? null);
    }
  }
  const pages = [...inScope.values()];

  const prompt = buildPrompt({ conventionsRevision: conventions.conventions.revision, index, pages, blobs, allowedConcepts });
  return { conventionsRevision: conventions.conventions.revision, pages, allPages: all.filter((page) => page.state === 'ok'), pageIndex, blobs, allowedConcepts, prompt };
}

function buildPrompt(input: {
  conventionsRevision: string;
  index: string | null;
  pages: PageSnapshot[];
  blobs: SourceBlob[];
  allowedConcepts: Map<string, string>;
}): string {
  const parts: string[] = [
    `SCHEMA REVISION: ${input.conventionsRevision} (the vault's rules; page kinds: ${PAGE_KINDS.join(', ')})`,
    `CURRENT ${INDEX_FILE}:\n${clip(input.index ?? '(empty — no pages yet)', MAX_INDEX_CHARS)}`,
  ];

  if (input.pages.length) {
    const lines = input.pages.map((page) => {
      const meta = page.metadata;
      const title = meta?.title ?? page.legacy?.concept ?? page.id;
      const claims = (meta?.claims ?? [])
        .filter((claim) => claim.status === 'current')
        .map((claim) => `      - [${claim.id}] ${claim.text}`)
        .join('\n');
      const learner = meta?.learner?.inMyWords?.trim() || page.legacy?.sections.in_my_words?.trim() || '';
      return [
        `    - id: ${page.id} · kind: ${page.kind} · revision: ${page.revision}`,
        `      title: ${title}`,
        `      summary: ${meta?.summary ?? page.legacy?.sections.in_my_words?.slice(0, 200) ?? '(none)'}`,
        learner ? `      student's own words: ${learner.slice(0, 400)}` : '',
        claims ? `      claims:\n${claims}` : '      claims: (none)',
        clip(page.body || '', MAX_PAGE_CHARS) ? `      body:\n${clip(page.body, MAX_PAGE_CHARS)}` : '',
      ]
        .filter(Boolean)
        .join('\n');
    });
    parts.push(`PAGES IN SCOPE (update only these; everything else stays):\n${lines.join('\n')}`);
  } else {
    parts.push('PAGES IN SCOPE: none — this material starts fresh pages.');
  }

  if (input.allowedConcepts.size) {
    parts.push(`COURSE CONCEPTS MENTIONED (exact labels): ${[...input.allowedConcepts.values()].join(' | ')}`);
  }

  const sourceLines = input.blobs.map((blob) => {
    const { record, text } = blob;
    const label = `### source ${record.id} — "${record.title}" (${record.kind}, origin ${record.origin}, revision ${record.revision})`;
    return `${label}\n${clip(text, MAX_SOURCE_CHARS)}`;
  });
  parts.push(`SOURCE MATERIAL (the only ground truth; quotes must be copied exactly):\n${sourceLines.join('\n\n')}`);
  return parts.join('\n\n');
}

const clip = (text: string, max: number): string => (text.length <= max ? text : `${text.slice(0, max)}…`);

/** Which page a draft title points at: an in-scope page by exact title or id, else a fresh id. */
export function pageIdFor(title: string, pages: PageSnapshot[], taken: Set<string>): { id: string; existing: PageSnapshot | null } {
  const normalized = title.trim().toLowerCase();
  const byTitle = pages.find((page) => (page.metadata?.title ?? page.legacy?.concept ?? '').trim().toLowerCase() === normalized);
  if (byTitle) return { id: byTitle.id, existing: byTitle };
  let id = conceptKey(title) || `page-${taken.size + 1}`;
  if (id.length > 120) id = id.slice(0, 120);
  let candidate = id;
  for (let n = 2; taken.has(candidate) || pages.some((page) => page.id === candidate); n += 1) candidate = `${id}-${n}`;
  return { id: candidate, existing: null };
}
