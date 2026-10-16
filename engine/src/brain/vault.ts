import { appendFile, mkdir, readdir } from 'node:fs/promises';
import path from 'node:path';
import type { BrainLogEntry, ConceptPage, Evidence, PageLink } from '@sef/shared';
import { log } from '../config';
import { readText, writeFileAtomic } from '../lib/fs';
import { recentLogEntries, renderLogEntry } from './log-format';
import { computeStatus } from './mastery';
import { parsePage, serializePage } from './page-format';
import { VaultSchemaError } from './vault-errors';
import { conceptPageFromWikiPage, readPageFile, type PageMetadata } from './wiki-page-format';

const SCHEMA_MD = `# Brain schema

This folder is your second brain. Every file is plain markdown — open it in Obsidian or any editor.

- \`concepts/\` — one page per concept, as *you* understand it. Frontmatter is machine state; sections are yours.
- \`index.md\` — catalogue of every page with its status.
- \`log.md\` — append-only timeline of how your understanding grew.
- \`.history/\` — earlier versions of each page, used for diffs and undo.

Rules the brain keeper follows:
1. The model only *proposes* edits. A deterministic validator checks them before anything is written.
2. Status (met, shaky, solid) is computed from evidence — quizzes, sessions, flagged misconceptions — never by the model.
3. Links record their origin: course, student, peer or suggested.
4. Nothing from a peer enters this folder unless you accept it.
`;

/** Resolves an evidence id (quiz result, source record) back to the evidence it points at. */
export type EvidenceResolver = (id: string) => Promise<Evidence | null>;

/**
 * The student's brain on disk. Both page formats read back through the same ConceptPage
 * view: earlier concept pages verbatim, typed wiki pages via conceptPageFromWikiPage plus
 * the parts provenance cannot carry (resolved evidence ids, typed links, disputed claims).
 */
export class BrainVault {
  private readonly conceptsDir: string;
  private readonly historyDir: string;

  constructor(
    readonly root: string,
    private readonly resolveEvidence: EvidenceResolver = async () => null,
  ) {
    this.conceptsDir = path.join(root, 'concepts');
    this.historyDir = path.join(root, '.history');
  }

  async init(): Promise<void> {
    await mkdir(this.conceptsDir, { recursive: true });
    if (!(await readText(path.join(this.root, 'SCHEMA.md')))) {
      await writeFileAtomic(path.join(this.root, 'SCHEMA.md'), SCHEMA_MD);
      await writeFileAtomic(path.join(this.root, 'log.md'), '# Learning log\n\n');
      log.info('brain_vault_created', { root: this.root });
    }
  }

  /** Fresh reads, always: the wiki store can commit pages this vault never saw coming. */
  async all(): Promise<Map<string, ConceptPage>> {
    const pages = new Map<string, ConceptPage>();
    for (const name of await readdir(this.conceptsDir).catch(() => [] as string[])) {
      if (!name.endsWith('.md')) continue;
      const raw = await readText(path.join(this.conceptsDir, name));
      if (!raw) continue;
      const parsed = readPageFile(raw);
      const page = parsed.format === 1 ? parsed.legacy : parsed.format === 2 ? await this.conceptView(parsed.metadata, parsed.body) : null;
      if (page?.key) pages.set(page.key, page);
      else log.warn('brain_page_unreadable', { file: name });
    }
    return pages;
  }

  /**
   * A typed wiki page rendered as the concept view the rest of the app understands.
   * Evidence ids resolve back to quiz results and sources; claims still standing are the
   * knowledge — a disputed one is an open misconception, and typed links keep their origin.
   */
  async conceptView(metadata: PageMetadata, body: string): Promise<ConceptPage | null> {
    if (metadata.kind !== 'concept') return null;
    const view = conceptPageFromWikiPage(metadata, body);
    if (!view) return null;
    for (const id of metadata.learner?.evidenceIds ?? []) {
      const evidence = await this.resolveEvidence(id).catch(() => null);
      if (evidence && !view.evidence.some((e) => e.ref === evidence.ref && e.kind === evidence.kind)) view.evidence.push(evidence);
    }
    for (const claim of metadata.claims) {
      if (claim.status === 'disputed') {
        view.misconceptions.push({ claim: claim.text, course: 'Contradicted by another claim on this page.', flagged: metadata.updatedAt, resolved: false });
      }
    }
    const links: PageLink[] = metadata.links.map((link) => ({ to: link.toPageId, type: link.type, origin: link.origin, why: link.why }));
    for (const link of links) {
      if (!view.links.some((l) => l.to === link.to && l.type === link.type)) view.links.push(link);
    }
    view.status = computeStatus(view);
    view.updated = metadata.updatedAt;
    return view;
  }

  async get(key: string): Promise<ConceptPage | undefined> {
    return (await this.all()).get(key);
  }

  async raw(key: string): Promise<string | null> {
    return readText(this.pagePath(key));
  }

  private pagePath(key: string): string {
    return path.join(this.conceptsDir, `${key}.md`);
  }

  /**
   * Writes a legacy-format page, snapshotting the previous version and recomputing status.
   * A page that has been adopted into the typed wiki format must not be written here —
   * that would silently drop its claims and provenance — so the write refuses and the
   * caller routes through the proposal machinery instead.
   */
  async save(page: ConceptPage): Promise<{ before: string | null; after: string }> {
    const before = await readText(this.pagePath(page.key));
    if (before) {
      const parsed = readPageFile(before);
      if (parsed.format === 2) {
        throw new VaultSchemaError(`Page ${page.key} is in the typed wiki format; write through a proposal, not the legacy section editor.`);
      }
      const stamp = new Date().toISOString().replace(/[:.]/g, '-');
      await writeFileAtomic(path.join(this.historyDir, page.key, `${stamp}.md`), before);
    }
    const next = { ...page, status: computeStatus(page), updated: new Date().toISOString() };
    const after = serializePage(next);
    await writeFileAtomic(this.pagePath(page.key), after);
    return { before, after };
  }

  /** Writes a page exactly as given (timestamps included), without history. Used by the demo seeder. */
  async writeSeeded(page: ConceptPage): Promise<void> {
    const before = await readText(this.pagePath(page.key));
    if (before && readPageFile(before).format === 2) {
      throw new VaultSchemaError(`Page ${page.key} is in the typed wiki format; seeding would silently drop its claims.`);
    }
    const next = { ...page, status: computeStatus(page) };
    await writeFileAtomic(this.pagePath(page.key), serializePage(next));
  }

  async isEmpty(): Promise<boolean> {
    return (await this.all()).size === 0;
  }

  async writeIndex(): Promise<void> {
    const pages = [...(await this.all()).values()].sort((a, b) => a.concept.localeCompare(b.concept));
    const rows = pages.map((p) => {
      const open = p.misconceptions.filter((m) => !m.resolved).length;
      return `- [[${p.key}|${p.concept}]] · ${p.status}${open ? ` · ${open} open misconception${open > 1 ? 's' : ''}` : ''}`;
    });
    await writeFileAtomic(path.join(this.root, 'index.md'), `# Index\n\n${pages.length} concept pages.\n\n${rows.join('\n')}\n`);
  }

  async appendLog(entry: Omit<BrainLogEntry, 'at'>, at = new Date().toISOString()): Promise<void> {
    await appendFile(path.join(this.root, 'log.md'), renderLogEntry({ ...entry, at }));
  }

  async readLog(limit = 50): Promise<BrainLogEntry[]> {
    return recentLogEntries((await readText(path.join(this.root, 'log.md'))) ?? '', limit);
  }
}
