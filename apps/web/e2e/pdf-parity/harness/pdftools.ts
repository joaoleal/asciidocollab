/**
 * Structural PDF inspection over poppler's command-line tools (present on the parity host): page
 * count, extracted text layer, and a dependency-free rasterized "ink map" per page. The ink map is how
 * placement parity is measured for content that has no text layer (math glyph paths, diagram vectors):
 * poppler rasterizes each page to grayscale PGM, and this module reads the raw PGM bytes directly (no
 * image-decoding dependency) to derive, per page, the fraction of inked pixels and the normalized
 * bounding box of the ink. Comparing those against the reference render catches "did the artifact
 * render, and is it placed in the same region and at a comparable footprint" at an element-level
 * tolerance that absorbs rasterizer and engine antialiasing differences.
 *
 * One dimension is NOT expressible in poppler and is read with pdf.js instead — see
 * {@link internalLinkTargets} for the measurement and the reasoning.
 */

import { execFileSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
// The legacy build is the one meant to run outside a browser: it is the same code the app's PDF
// preview loads (pdfjs-dist is already a runtime dependency of this app), transpiled for a plain
// Node runtime, so reading a PDF here adds no dependency and no browser globals.
import { getDocument, type PDFDocumentProxy } from 'pdfjs-dist/legacy/build/pdf.mjs';

/** Per-page ink measurement derived from a grayscale raster of the page. */
export interface PageInk {
  /** Fraction of pixels darker than the ink threshold (0 = blank page, 1 = fully inked). */
  readonly darkFraction: number;
  /** Normalized bounding box of the inked pixels, or null when the page is blank. */
  readonly bbox: { readonly x0: number; readonly y0: number; readonly x1: number; readonly y1: number } | null;
}

function withTemporaryPdf<T>(bytes: Uint8Array, run: (pdfPath: string, directory: string) => T): T {
  const directory = mkdtempSync(path.join(tmpdir(), 'pdfparity-'));
  const pdfPath = path.join(directory, 'doc.pdf');
  writeFileSync(pdfPath, Buffer.from(bytes));
  try {
    return run(pdfPath, directory);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}

/** Number of pages in the PDF (via `pdfinfo`). */
export function pageCount(bytes: Uint8Array): number {
  return withTemporaryPdf(bytes, (pdfPath) => {
    const out = execFileSync('pdfinfo', [pdfPath], { encoding: 'utf8' });
    const match = /^Pages:\s+(\d+)/m.exec(out);
    if (match === null) {
      throw new Error('pdfinfo did not report a page count');
    }
    return Number(match[1]);
  });
}

/** Extracted text layer (via `pdftotext`, reading order preserved). */
export function extractText(bytes: Uint8Array): string {
  return withTemporaryPdf(bytes, (pdfPath) =>
    execFileSync('pdftotext', ['-layout', pdfPath, '-'], { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 }),
  );
}

/** Parse a binary PGM (P5) into width, height, and the raw grayscale sample bytes. */
function parsePgm(buffer: Buffer): { width: number; height: number; data: Buffer } {
  if (buffer[0] !== 0x50 || buffer[1] !== 0x35) {
    throw new Error('not a binary PGM (P5) raster');
  }
  let offset = 2;
  const tokens: number[] = [];
  while (tokens.length < 3) {
    while (offset < buffer.length && /\s/.test(String.fromCodePoint(buffer[offset]))) {
      offset += 1;
    }
    if (buffer[offset] === 0x23) {
      while (offset < buffer.length && buffer[offset] !== 0x0A) {
        offset += 1;
      }
      continue;
    }
    let token = '';
    while (offset < buffer.length && !/\s/.test(String.fromCodePoint(buffer[offset]))) {
      token += String.fromCodePoint(buffer[offset]);
      offset += 1;
    }
    tokens.push(Number(token));
  }
  const [width, height] = tokens;
  const data = buffer.subarray(offset + 1);
  return { width, height, data };
}

/** The grayscale sample below which a pixel counts as "inked". */
const INK_THRESHOLD = 250;

function inkOfPgm(buffer: Buffer): PageInk {
  const { width, height, data } = parsePgm(buffer);
  let dark = 0;
  let minX = width;
  let minY = height;
  let maxX = -1;
  let maxY = -1;
  for (let y = 0; y < height; y += 1) {
    const row = y * width;
    for (let x = 0; x < width; x += 1) {
      if (data[row + x] < INK_THRESHOLD) {
        dark += 1;
        if (x < minX) minX = x;
        if (x > maxX) maxX = x;
        if (y < minY) minY = y;
        if (y > maxY) maxY = y;
      }
    }
  }
  const total = width * height;
  const bbox =
    maxX < 0
      ? null
      : { x0: minX / width, y0: minY / height, x1: (maxX + 1) / width, y1: (maxY + 1) / height };
  return { darkFraction: total === 0 ? 0 : dark / total, bbox };
}

/** The element-level tolerance an ink-map comparison is held to (recorded by the fixture). */
export interface InkTolerance {
  readonly dpi: number;
  /** Minimum inked fraction a content page must have (proves the artifact actually rendered). */
  readonly minDarkFraction: number;
  /** Max allowed |ours-ref|/ref of the inked fraction (footprint parity, absorbs AA). */
  readonly maxDarkFractionRatioDelta: number;
  /** Max allowed per-edge difference of the normalized ink bounding box (placement parity). */
  readonly maxBboxEdgeDelta: number;
}

/** A single ink-map parity failure for a page. */
export interface InkMismatch {
  readonly page: number;
  readonly detail: string;
}

/** Compare our page ink maps against the reference's at the given tolerance; empty ⇒ parity. */
export function compareInkMaps(
  ours: readonly PageInk[],
  reference: readonly PageInk[],
  tolerance: InkTolerance,
): InkMismatch[] {
  const mismatches: InkMismatch[] = [];
  if (ours.length !== reference.length) {
    mismatches.push({ page: -1, detail: `page count ours=${ours.length} reference=${reference.length}` });
    return mismatches;
  }
  for (const [index, r] of reference.entries()) {
    const o = ours[index];
    if (r.darkFraction < tolerance.minDarkFraction) {
      continue; // Reference page is blank/near-blank; nothing to hold parity against.
    }
    if (o.darkFraction < tolerance.minDarkFraction) {
      mismatches.push({ page: index, detail: `our page has no ink (darkFraction=${o.darkFraction.toFixed(5)})` });
      continue;
    }
    const ratioDelta = Math.abs(o.darkFraction - r.darkFraction) / r.darkFraction;
    if (ratioDelta > tolerance.maxDarkFractionRatioDelta) {
      mismatches.push({
        page: index,
        detail: `ink footprint delta ${ratioDelta.toFixed(3)} > ${tolerance.maxDarkFractionRatioDelta} (ours=${o.darkFraction.toFixed(5)} ref=${r.darkFraction.toFixed(5)})`,
      });
    }
    if (o.bbox !== null && r.bbox !== null) {
      const edges: Array<'x0' | 'y0' | 'x1' | 'y1'> = ['x0', 'y0', 'x1', 'y1'];
      for (const edge of edges) {
        const delta = Math.abs(o.bbox[edge] - r.bbox[edge]);
        if (delta > tolerance.maxBboxEdgeDelta) {
          mismatches.push({
            page: index,
            detail: `ink bbox ${edge} delta ${delta.toFixed(3)} > ${tolerance.maxBboxEdgeDelta} (ours=${o.bbox[edge].toFixed(3)} ref=${r.bbox[edge].toFixed(3)})`,
          });
        }
      }
    }
  }
  return mismatches;
}

/** Rasterize every page to grayscale at `dpi` and return each page's ink measurement, in page order. */
export function pageInkMaps(bytes: Uint8Array, dpi: number): PageInk[] {
  return withTemporaryPdf(bytes, (pdfPath, directory) => {
    const prefix = path.join(directory, 'page');
    execFileSync('pdftoppm', ['-gray', '-r', String(dpi), pdfPath, prefix]);
    const pgms = readdirSync(directory)
      .filter((name) => name.startsWith('page') && name.endsWith('.pgm'))
      .toSorted((a, b) => a.localeCompare(b, undefined, { numeric: true }));
    return pgms.map((name) => inkOfPgm(readFileSync(path.join(directory, name))));
  });
}

/**
 * One `/Link` annotation whose destination lies inside the same document — the PDF form an AsciiDoc
 * cross-reference, a contents entry or a footnote round-trip takes. Links out of the document (a
 * `/URI` action) are not cross-references and are excluded.
 */
export interface InternalLink {
  /** 1-based page whose `/Annots` array carries the link (where the reader clicks). */
  readonly page: number;
  /**
   * 1-based page the destination resolves to, or null when it does not resolve — a dangling target,
   * which is exactly the defect a cross-reference comparison exists to catch, so it is reported
   * rather than dropped.
   */
  readonly targetPage: number | null;
  /**
   * The named destination the link goes through (`_section_1`, `_footnotedef_1`, an `[[anchor]]` id),
   * or null when the link carries an explicit destination array instead of a name.
   */
  readonly targetName: string | null;
}

/** True for any non-null object, so its properties can be read as `unknown` without an assertion. */
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

/** True for the `{ num, gen }` indirect reference pdf.js puts at the head of an explicit destination. */
function isPageReference(value: unknown): value is { num: number; gen: number } {
  return isRecord(value) && typeof value.num === 'number' && typeof value.gen === 'number';
}

/**
 * Resolve an explicit destination array (`[pageRef, /XYZ, …]`) to a 1-based page number, or null when
 * it points at nothing this document contains.
 */
async function destinationPage(pdfDocument: PDFDocumentProxy, destination: readonly unknown[] | null): Promise<number | null> {
  const target = destination === null ? undefined : destination[0];
  // The page-INDEX form (`[3, /XYZ, …]`), which appears in documents written without indirect page refs.
  if (typeof target === 'number') {
    return target >= 0 && target < pdfDocument.numPages ? target + 1 : null;
  }
  if (!isPageReference(target)) return null;
  try {
    return (await pdfDocument.getPageIndex(target)) + 1;
  } catch {
    return null; // The ref names no page in this document — a broken destination, reported as unresolved.
  }
}

/**
 * Every internal link in the document, in page order and, within a page, in `/Annots` order.
 *
 * WHY NOT POPPLER, unlike everything above: poppler cannot express this measurement. `pdftohtml -xml`
 * does emit link annotations, but it has already resolved each one to a target PAGE
 * (`<a href="doc.html#3">`) and discarded the destination NAME; `pdfinfo -dests` lists the named
 * destinations with their pages but has no way to attribute a name to the link that points at it, and
 * in a real document many names share one page — so the two outputs cannot be joined back into
 * "this link targets this name". Comparing pages alone would pass a render that wired every
 * cross-reference to the wrong anchor on the right page. pdf.js is the honest alternative available
 * here: it is already this app's PDF reader (`pdfjs-dist`, a declared runtime dependency), and it
 * exposes the annotation table and the destination name tree separately, which is precisely the join
 * poppler drops.
 *
 * @param bytes - The PDF file's bytes. Copied before parsing, because pdf.js takes ownership of (and
 *   may detach) the buffer it is handed, and callers here reuse the bytes for the poppler probes.
 * @returns One entry per internal link; an empty array for a document with no cross-references.
 */
export async function internalLinkTargets(bytes: Uint8Array): Promise<InternalLink[]> {
  const pdfDocument = await getDocument({
    data: new Uint8Array(bytes),
    useSystemFonts: false,
    verbosity: 0, // Errors only: font/standard-data notices would drown the parity run's output.
  }).promise;
  try {
    const links: InternalLink[] = [];
    for (let page = 1; page <= pdfDocument.numPages; page += 1) {
      const pdfPage = await pdfDocument.getPage(page);
      const annotations: unknown[] = await pdfPage.getAnnotations({ intent: 'display' });
      for (const annotation of annotations) {
        if (!isRecord(annotation) || annotation.subtype !== 'Link') continue;
        // A link that leaves the document. A plain `/URI` action carries no destination and would fall
        // through the branches below anyway; the guard is here for the remote go-to form (`/GoToR`),
        // where pdf.js reports BOTH a url and a destination name — one that names an anchor in the
        // OTHER file, so resolving it against this document's name tree would invent a local target.
        if (typeof annotation.url === 'string') continue;
        const destination = annotation.dest;
        if (typeof destination === 'string') {
          const explicit: unknown[] | null = await pdfDocument.getDestination(destination);
          links.push({ page, targetPage: await destinationPage(pdfDocument, explicit), targetName: destination });
        } else if (Array.isArray(destination)) {
          links.push({ page, targetPage: await destinationPage(pdfDocument, destination), targetName: null });
        }
      }
    }
    return links;
  } finally {
    // Releases the (fake, in-process) worker; without it the Node process keeps a live task per PDF.
    // pdfjs-dist 6 removed `PDFDocumentProxy.destroy()` — the loading task owns the worker.
    await pdfDocument.loadingTask.destroy();
  }
}
