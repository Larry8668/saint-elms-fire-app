import path from 'node:path';
import { checkPageCount, INGEST_LIMITS, type Limits } from './limits';
import type { PdfReader } from './extract';

/**
 * PDF text extraction via pdfjs-dist, pinned in the workspace.
 *
 * This runs entirely on-device and never uploads the document. Two things matter beyond
 * "does it parse": a malformed PDF must fail cleanly rather than wedge the job, and the
 * page count must be known *before* any page is rendered so the limit can be enforced up
 * front rather than discovered half way through.
 */

interface PdfTaskLike {
  promise: Promise<PdfDocumentLike>;
  destroy: () => Promise<void>;
}

type PdfJsModule = {
  getDocument: (options: Record<string, unknown>) => PdfTaskLike;
};

interface PdfPageLike {
  getTextContent: () => Promise<{ items: unknown[] }>;
  cleanup: () => void;
}

interface PdfDocumentLike {
  numPages: number;
  getPage: (n: number) => Promise<PdfPageLike>;
  /** pdfjs 6 exposes cleanup() on the document; tearing the task down is `task.destroy()`. */
  cleanup: () => boolean | void;
}

/** Item shapes pdfjs emits are loosely typed upstream; only the text we care about is read. */
const itemText = (item: unknown): string => {
  if (!item || typeof item !== 'object') return '';
  const record = item as { str?: unknown };
  return typeof record.str === 'string' ? record.str : '';
};

export class PdfParseError extends Error {
  constructor(
    message: string,
    readonly code: 'malformed' | 'encrypted' | 'unsupported',
  ) {
    super(message);
  }
}

/** Releases the worker and the parsed document. Safe to call more than once. */
const closeTask = async (document: PdfDocumentLike, task: PdfTaskLike | null): Promise<void> => {
  try {
    document.cleanup();
  } catch {
    // A document that never opened has nothing to clean.
  }
  await task?.destroy().catch(() => {});
};

/** Absolute path to the metric data shipped with pdfjs, needed for text positioning. */
const standardFontDataUrl = (): string => {
  const specifier = import.meta.resolve('pdfjs-dist/package.json');
  const dir = path.dirname(new URL(specifier).pathname);
  return `${path.join(dir, 'standard_fonts')}${path.sep}`;
};

const loadPdfJs = async (): Promise<PdfJsModule> => {
  // The legacy build is the Node-targeted one; the default entry expects a DOM.
  const module = (await import('pdfjs-dist/legacy/build/pdf.mjs')) as unknown as PdfJsModule;
  return module;
};

/**
 * Opens the document and returns a page reader. The page count is read from the opened
 * document, so `extractPdf` can refuse an over-long file before rendering anything.
 */
export async function openPdf(bytes: Uint8Array, limits: Limits = {}): Promise<PdfReader & { close: () => Promise<void> }> {
  let pdfjs: PdfJsModule;
  try {
    pdfjs = await loadPdfJs();
  } catch (error) {
    throw new PdfParseError(`The PDF reader could not be loaded: ${(error as Error).message}`, 'unsupported');
  }

  let task: PdfTaskLike | null = null;
  let document: PdfDocumentLike;
  try {
    task = pdfjs.getDocument({
      data: bytes,
      useSystemFonts: false,
      // Widths come from the bundled metric data; without it pdfjs warns and guesses.
      standardFontDataUrl: standardFontDataUrl(),
      isEvalSupported: false,
      disableFontFace: true,
    });
    document = await task.promise;
  } catch (error) {
    await task?.destroy().catch(() => {});
    const message = (error as Error).name === 'PasswordException' || /password/i.test((error as Error).message);
    throw new PdfParseError(
      message ? 'That PDF is password-protected and cannot be read here.' : 'That PDF could not be opened; it may be damaged.',
      message ? 'encrypted' : 'malformed',
    );
  }

  const pageRejection = checkPageCount(document.numPages, limits);
  if (pageRejection) {
    await closeTask(document, task);
    throw new PdfParseError(pageRejection.message, 'unsupported');
  }

  const maxChars = limits.maxExtractedChars ?? INGEST_LIMITS.maxExtractedChars;
  return {
    pages: document.numPages,
    async readPage(page: number): Promise<string> {
      const handle = await document.getPage(page);
      try {
        const content = await handle.getTextContent();
        return content.items.map(itemText).join(' ').slice(0, maxChars);
      } finally {
        handle.cleanup();
      }
    },
    async close(): Promise<void> {
      await closeTask(document, task);
    },
  };
}
