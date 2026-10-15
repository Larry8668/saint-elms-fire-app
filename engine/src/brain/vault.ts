import { appendFile, mkdir, readdir } from 'node:fs/promises';
import path from 'node:path';
import type { BrainLogEntry, ConceptPage } from '@sef/shared';
import { log } from '../config';
import { readText, writeFileAtomic } from '../lib/fs';
import { recentLogEntries, renderLogEntry } from './log-format';
import { computeStatus } from './mastery';
import { parsePage, serializePage } from './page-format';

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

/** The student's brain on disk: markdown pages plus index, log and history. */
export class BrainVault {
  private readonly conceptsDir: string;
  private readonly historyDir: string;
  private pages: Map<string, ConceptPage> | null = null;

  constructor(readonly root: string) {
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

  async all(): Promise<Map<string, ConceptPage>> {
    if (this.pages) return this.pages;
    const pages = new Map<string, ConceptPage>();
    for (const name of await readdir(this.conceptsDir).catch(() => [] as string[])) {
      if (!name.endsWith('.md')) continue;
      const raw = await readText(path.join(this.conceptsDir, name));
      const page = raw ? parsePage(raw) : null;
      if (page?.key) pages.set(page.key, page);
      else log.warn('brain_page_unreadable', { file: name });
    }
    this.pages = pages;
    return pages;
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

  /** Writes a page, snapshotting the previous version and recomputing status. */
  async save(page: ConceptPage): Promise<{ before: string | null; after: string }> {
    const before = await readText(this.pagePath(page.key));
    if (before) {
      const stamp = new Date().toISOString().replace(/[:.]/g, '-');
      await writeFileAtomic(path.join(this.historyDir, page.key, `${stamp}.md`), before);
    }
    const next = { ...page, status: computeStatus(page), updated: new Date().toISOString() };
    const after = serializePage(next);
    await writeFileAtomic(this.pagePath(page.key), after);
    (await this.all()).set(next.key, next);
    return { before, after };
  }

  /** Writes a page exactly as given (timestamps included), without history. Used by the demo seeder. */
  async writeSeeded(page: ConceptPage): Promise<void> {
    const next = { ...page, status: computeStatus(page) };
    await writeFileAtomic(this.pagePath(page.key), serializePage(next));
    (await this.all()).set(next.key, next);
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
