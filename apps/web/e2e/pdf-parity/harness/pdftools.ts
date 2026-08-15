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
import { getDocument, OPS, type PDFDocumentProxy } from 'pdfjs-dist/legacy/build/pdf.mjs';

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

/**
 * Parse a binary Netpbm raster — PGM (`P5`, one sample per pixel) or PPM (`P6`, three) — into its
 * dimensions and its raw sample bytes.
 *
 * Both forms carry the same header, which is why one parser reads them: a magic number, three
 * whitespace-separated decimals, and then the samples. Reading the bytes directly is what keeps this
 * module free of an image-decoding dependency, and poppler writes both without being asked to.
 *
 * @param buffer - The file's bytes.
 * @param magic - The magic digit the caller asked poppler for, so a raster in the other form is a
 *   loud failure rather than samples read at the wrong stride.
 * @returns The dimensions and the sample bytes.
 */
function parseNetpbm(buffer: Buffer, magic: 5 | 6): { width: number; height: number; data: Buffer } {
  if (buffer[0] !== 0x50 || buffer[1] !== 0x30 + magic) {
    throw new Error(`not a binary P${magic} raster`);
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
  const { width, height, data } = parseNetpbm(buffer, 5);
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

// ── Per-construct appearance, for the Print preview's fidelity oracle ────────────────────────────
//
// The measurements below answer a different question from everything above. Ink maps and text layers
// ask "did the same thing get drawn in the same place"; these ask "in what typeface, at what size, in
// what colour, inside what page". They exist because the Print preview claims to reproduce the PDF's
// appearance, and a claim about appearance can only be checked against a PDF that was really rendered.
//
// pdf.js rather than poppler, for the same reason `internalLinkTargets` uses it: poppler's text output
// has already discarded the font identity and the fill colour by the time it reaches a caller. pdf.js
// exposes the text layer's per-item font key alongside a style table, and the operator stream with its
// colour operators intact — which is the join poppler drops.

/** One run of text as the PDF draws it, with the appearance it is drawn in. */
export interface TextRun {
  /** 1-based page it is drawn on. */
  readonly page: number;
  /** The text itself. */
  readonly text: string;
  /**
   * The typeface, as the embedded font names itself — subset prefixes (`ABCDEF+`) removed, so
   * `ABCDEF+NotoSerif-Bold` reads as `NotoSerif-Bold`.
   */
  readonly fontFamily: string;
  /** Size in PDF points, from the text matrix rather than from any declared value. */
  readonly fontSizePt: number;
  /** Left edge in points from the page's left edge. */
  readonly xPt: number;
  /** Baseline in points from the page's bottom edge. */
  readonly yPt: number;
  /** Advance width in points. */
  readonly widthPt: number;
}

/** A drawn colour, as three channels in 0–255. */
export type Rgb = readonly [number, number, number];

/** One run of text with the appearance in force when it was drawn. */
export interface DrawnRun {
  /** 1-based page it is drawn on. */
  readonly page: number;
  /** The text itself, as the show-text operator carried it. */
  readonly text: string;
  /** The fill colour in force. Defaults to black, which is the PDF's own initial fill colour. */
  readonly colour: Rgb;
  /** The typeface in force, as the embedded font names itself, without its subset prefix. */
  readonly fontFamily: string;
  /** The size the font was set at, in points. */
  readonly fontSizePt: number;
}

/** A page's size and the box its ink actually occupies, both in points. */
export interface PageGeometry {
  /** 1-based page number. */
  readonly page: number;
  /** Page width in points. */
  readonly widthPt: number;
  /** Page height in points. */
  readonly heightPt: number;
  /** Distance from the left page edge to the leftmost ink, in points. */
  readonly leftInsetPt: number;
  /** Distance from the right page edge to the rightmost ink, in points. */
  readonly rightInsetPt: number;
  /** Distance from the top page edge to the topmost ink, in points. */
  readonly topInsetPt: number;
  /** Distance from the bottom page edge to the lowest ink, in points. */
  readonly bottomInsetPt: number;
  /** Width of the inked column, in points. */
  readonly contentWidthPt: number;
}

/**
 * The tolerances every Print-fidelity comparison is held to, declared once.
 *
 * Once, because a tolerance that each spec states for itself is a tolerance that drifts: the first
 * comparison to fail widens its own copy, and nothing anywhere records that the others no longer
 * agree with it. Widening any of these is a design decision about how faithful the preview claims to
 * be — it belongs here, with a reason, not in the spec that happened to fail.
 */
export const PRINT_FIDELITY_TOLERANCE = {
  /** Typeface: exact. A different face is a different set of line breaks, which is the whole claim. */
  fontFamily: 'exact' as const,
  /** Font size, in points. Absorbs the rounding between a theme's value and a text matrix. */
  fontSizePt: 0.25,
  /** Colour, per channel out of 255. Absorbs the PDF's own float→byte rounding. */
  colourChannel: 2,
  /** Page size and insets, in points. Half a point is below what any display resolves. */
  geometryPt: 0.5,
  /**
   * How far a FIRST baseline may sit from where the renderer puts it, on top of `geometryPt`.
   *
   * A property of the instrument, not a claim about the preview, and allowed only where a comparison
   * crosses the two line models — a baseline the browser placed against one prawn placed. It is NOT
   * for comparing two positions inside the same model — a step from one baseline to the next, or a
   * box against a box — where the rounding is common to both sides and cancels.
   *
   * ## Where the number comes from
   *
   * Prawn places a block's first baseline at `leading / 2 + (ascender + line_gap) x size`, in points,
   * and the stylesheet asks for exactly that: the line box it sets is `(ascender + descender +
   * line_gap) x size + leading`, so CSS half-leading is `leading / 2` and the CSS baseline is the
   * same number. Measured against the reference PDFs the two agree to the digit — the default
   * theme's title is 27pt x 1.068 = 28.836pt below the content top on the page, and the preview asks
   * for 28.836pt. There is no modelling error left for this allowance to cover.
   *
   * What it covers is the pixel grid underneath. Chromium rounds a face's ascent and its descent to
   * whole CSS pixels at the size it is drawing, and then places the baseline at
   *
   *     round(A) + floor((L - round(A) - round(D)) / 2)
   *
   * — verified directly against Blink over 33 line-heights from 45px to 53px at one size, exact at
   * every one. Writing `ea = round(A) - A` and `ed = round(D) - D`, both in `[-0.5, 0.5)`, and `h =
   * (L - A - D) / 2` for the half-leading the model wants, the placement error is
   *
   *     ea + floor(h - (ea + ed) / 2) - h  ∈  ((ea - ed) / 2 - 1, (ea - ed) / 2]  ⊂  (-1.5, +0.5)
   *
   * so a first baseline may sit up to **1.5 CSS pixels above** where the page puts it and half a
   * pixel below. The `floor` is the whole of the asymmetry: it is a one-pixel cliff that a line box
   * lands on whenever the rounded ascent and descent add up to more than the exact line box, which
   * is by how the document title of every anchor fixture loses a pixel — `round(38.448) +
   * round(10.512) = 49` against a line box of `48.96`, so a half-leading of `-0.02px` floors to a
   * whole one. Measured: 1.086pt at the title of `default-theme`, `rich-theme` and
   * `letter-geometry`, 0.90pt at `project-font`, all inside the 1.125pt the bound allows.
   *
   * It was two CSS pixels, on an argument that counted three independent half-pixel roundings. There
   * are two roundings, not three — the half-leading is derived from them rather than rounded on its
   * own — and the third term is a floor rather than a rounding, which is why the bound is not
   * symmetric. 1.5 CSS pixels is what the corrected derivation buys.
   */
  lineBoxQuantisationPt: (1.5 * 72) / 96,
  /** Where a full line of body text breaks, in characters. */
  lineBreakCharacters: 1,
};

/**
 * Strip the six-character subset prefix an embedded font carries (`1464ea+NotoSerif` → `NotoSerif`).
 *
 * The prefix identifies the subset, not the typeface: two renders of the same document with the same
 * font produce different prefixes whenever the glyph set differs by one character. Comparing names
 * with it attached would report a font change every time the text changed.
 */
export function baseFontName(name: string): string {
  return /^[\da-z]{6}\+/i.test(name) ? name.slice(7) : name;
}

/** Open a PDF for reading, on a copy of the bytes (pdf.js takes ownership of the buffer it is given). */
async function openPdf(bytes: Uint8Array): Promise<PDFDocumentProxy> {
  return getDocument({
    data: new Uint8Array(bytes),
    useSystemFonts: false,
    verbosity: 0,
  }).promise;
}

/** True for a text-layer item that carries text rather than a line break marker. */
function isTextItem(item: unknown): item is {
  str: string;
  transform: number[];
  width: number;
  fontName: string;
} {
  return (
    isRecord(item) &&
    typeof item.str === 'string' &&
    Array.isArray(item.transform) &&
    typeof item.fontName === 'string'
  );
}

/**
 * Every run of text in the document, with the typeface and size it is drawn in.
 *
 * The size comes from the text matrix rather than from a declared value: a PDF may set a font at one
 * size and then scale the text matrix, and what a reader sees is the product. Reading the product is
 * the only measurement that cannot be fooled.
 *
 * @param bytes - The PDF file's bytes.
 * @returns One entry per text run, in page order and then in drawing order.
 */
export async function textRuns(bytes: Uint8Array): Promise<TextRun[]> {
  const pdfDocument = await openPdf(bytes);
  try {
    const runs: TextRun[] = [];
    for (let page = 1; page <= pdfDocument.numPages; page += 1) {
      const pdfPage = await pdfDocument.getPage(page);
      // The operator list must be built first: it is what resolves the page's fonts into `commonObjs`,
      // and the text layer's `styles` table reports only a CSS generic (`serif`) rather than the
      // embedded font's own name — which is the one thing this measurement is about.
      await pdfPage.getOperatorList();
      const content = await pdfPage.getTextContent();
      for (const item of content.items) {
        if (!isTextItem(item) || item.str === '') continue;
        const [a, b] = item.transform;
        const x = item.transform[4];
        const y = item.transform[5];
        // The text matrix's scale, which is the size the glyphs are actually drawn at.
        const size = Math.hypot(a, b);
        runs.push({
          page,
          text: item.str,
          fontFamily: baseFontName(embeddedFontName(pdfPage, item.fontName)),
          fontSizePt: size,
          xPt: x,
          yPt: y,
          widthPt: item.width,
        });
      }
    }
    return runs;
  } finally {
    await pdfDocument.loadingTask.destroy();
  }
}

/**
 * The name the embedded font gives itself, for one of a page's font keys.
 *
 * @param pdfPage - The page whose objects hold the resolved font.
 * @param key - The text layer's font key (`g_d3_f2`).
 * @returns The embedded name, or the key itself when the font did not resolve.
 */
function embeddedFontName(pdfPage: { commonObjs: { get: (key: string) => unknown } }, key: string): string {
  try {
    const font = pdfPage.commonObjs.get(key);
    return isRecord(font) && typeof font.name === 'string' ? font.name : key;
  } catch {
    return key;
  }
}

/**
 * Every run of text with the appearance in force when it was drawn.
 *
 * This is the measurement with no direct API. pdf.js reports the text layer and the operator stream
 * separately, and only the stream carries the graphics state — so the stream is walked in order, the
 * fill colour and the current font are tracked as the state changes them, and each show-text operator
 * is attributed what stood at that moment. That is exactly how the renderer itself reads the file.
 *
 * A colour arrives as a CSS hex string, which is how pdf.js normalises every device colour space it
 * can decode. One it cannot decode never sets the colour, so that run reports the PDF's own initial
 * black rather than a guess — visible as a mismatch, which is the honest outcome.
 *
 * @param bytes - The PDF file's bytes.
 * @returns One entry per show-text operator, in page order and then in drawing order.
 */
export async function drawnRuns(bytes: Uint8Array): Promise<DrawnRun[]> {
  const pdfDocument = await openPdf(bytes);
  try {
    const runs: DrawnRun[] = [];
    for (let page = 1; page <= pdfDocument.numPages; page += 1) {
      const pdfPage = await pdfDocument.getPage(page);
      const operators = await pdfPage.getOperatorList();
      // The PDF's own initial state: black fill, and no font until one is set.
      let colour: Rgb = [0, 0, 0];
      let fontFamily = '';
      let fontSizePt = 0;
      const stack: { colour: Rgb; fontFamily: string; fontSizePt: number }[] = [];

      for (const [index, op] of operators.fnArray.entries()) {
        const operands: unknown = operators.argsArray[index];
        switch (op) {
          case OPS.save: {
            stack.push({ colour, fontFamily, fontSizePt });
            break;
          }
          case OPS.restore: {
            const previous = stack.pop();
            if (previous !== undefined) ({ colour, fontFamily, fontSizePt } = previous);
            break;
          }
          case OPS.setFillRGBColor: {
            colour = fillColourOf(operands) ?? colour;
            break;
          }
          case OPS.setFont: {
            if (Array.isArray(operands) && operands.length >= 2) {
              fontFamily = baseFontName(embeddedFontName(pdfPage, String(operands[0])));
              fontSizePt = Math.abs(Number(operands[1]));
            }
            break;
          }
          case OPS.showText:
          case OPS.showSpacedText: {
            const text = showTextOf(operands);
            if (text !== '') runs.push({ page, text, colour, fontFamily, fontSizePt });
            break;
          }
          default: {
            break;
          }
        }
      }
    }
    return runs;
  } finally {
    await pdfDocument.loadingTask.destroy();
  }
}

/** The path-painting operators that put a fill colour on the page rather than only a stroke. */
const PATH_FILLS: ReadonlySet<number> = new Set([
  OPS.fill,
  OPS.eoFill,
  OPS.fillStroke,
  OPS.eoFillStroke,
  OPS.closeFillStroke,
  OPS.closeEOFillStroke,
]);

// A `filledColours` used to sit here: every fill colour the document uses, in drawing order, with no
// position attached to any of them. It has been REMOVED rather than repaired, and the reason is worth
// recording so nobody reaches for its shape again.
//
// Unlike {@link paintedBoxes} beside it, it tracked neither the transform nor the clipping region — so
// a fill confined to nothing at all still appeared in its list, and a fill inside a scaled context was
// reported as though it were on the page. But the deeper problem is what a caller could do with the
// answer: with no position, the only question it can be asked is "is this colour used ANYWHERE in the
// document", and its one caller asked exactly that of a table stripe. `rich-theme`'s reference fills
// its header rows in `#dde6f0` six times, so "somewhere on the page something is filled with the
// colour the preview projected into the stripe key" was satisfied by a projection that had put the
// HEADER's colour there — the comparison could not distinguish the defect from the correct render.
//
// {@link paintedBoxes} answers the same question with the rectangle attached, which is what makes a
// fill locatable: find the row by its own text, read the box around it, and the colour that comes back
// is the colour of that row rather than of anything on the page that happens to match.

/** A PDF transformation matrix, `[a, b, c, d, e, f]`. */
type Matrix = readonly [number, number, number, number, number, number];

/** The identity, which is the transform in force when a content stream opens. */
const IDENTITY: Matrix = [1, 0, 0, 1, 0, 0];

/**
 * `next` applied on top of `current`, which is what the `cm` operator does.
 *
 * @param current - The transform in force.
 * @param next - The operand of `cm`.
 * @returns The transform after it.
 */
function concatenate(current: Matrix, next: Matrix): Matrix {
  const [a, b, c, d, dx, dy] = next;
  const [A, B, C, D, DX, DY] = current;
  return [
    a * A + b * C,
    a * B + b * D,
    c * A + d * C,
    c * B + d * D,
    dx * A + dy * C + DX,
    dx * B + dy * D + DY,
  ];
}

/** A box in points from the page's bottom-left, as the file's own coordinates run. */
interface Bounds {
  /** Left edge. */
  readonly leftPt: number;
  /** Right edge. */
  readonly rightPt: number;
  /** Top edge, measured up from the page's bottom. */
  readonly topPt: number;
  /** Bottom edge, measured up from the page's bottom. */
  readonly bottomPt: number;
}

/**
 * A path's bounding box, mapped out of the space the path was written in and onto the page.
 *
 * pdf.js reports a path's extent in the coordinates the path's own operators used, NOT in page
 * space: a rectangle written inside `q 0.75 0 0 0.75 12 47 cm … Q` reports the numbers the operator
 * carried, three quarters of the size it lands on the page at and in the wrong place. Every mark
 * asciidoctor-pdf makes itself is written under the identity, so this changes nothing for a table's
 * frame, a block's fill or a rule; what it changes is the artwork inside an embedded SVG, which
 * prawn-svg draws under a scale and a translate. Four of this suite's anchor documents carry one, and
 * before this the boxes and strokes inside it were reported at the SVG's own scale — a set of marks
 * on the page at coordinates nothing on the page is at.
 *
 * @param bounds - The extent pdf.js reported, `[left, bottom, right, top]`.
 * @param matrix - The transform in force where the path was painted.
 * @returns The extent on the page.
 */
function mapBounds(bounds: readonly number[], matrix: Matrix): Bounds {
  const [left, bottom, right, top] = bounds;
  const [a, b, c, d, dx, dy] = matrix;
  const xs: number[] = [];
  const ys: number[] = [];
  for (const [x, y] of [
    [left, bottom],
    [right, bottom],
    [right, top],
    [left, top],
  ]) {
    xs.push(a * x + c * y + dx);
    ys.push(b * x + d * y + dy);
  }
  return {
    leftPt: Math.min(...xs),
    rightPt: Math.max(...xs),
    topPt: Math.max(...ys),
    bottomPt: Math.min(...ys),
  };
}

/**
 * Two boxes' overlap, or undefined when they do not meet.
 *
 * A box that meets another in one dimension only — a zero-height rule inside a clip that contains it
 * — overlaps. It is the whole of what a `stroke_horizontal_rule` or a table's grid line IS: prawn
 * writes one as a rectangle of no height, and pdf.js reports its bounds with `top === bottom`. An
 * emptiness test of `top <= bottom` calls that "no overlap" and deletes the mark, which is why the
 * comparison is strict: empty means the boxes are on opposite sides of each other, not that one of
 * them is thin.
 *
 * @param box - The first box.
 * @param other - The second.
 * @returns The intersection, or undefined when they do not meet.
 */
function intersect(box: Bounds, other: Bounds): Bounds | undefined {
  const clipped = {
    leftPt: Math.max(box.leftPt, other.leftPt),
    rightPt: Math.min(box.rightPt, other.rightPt),
    topPt: Math.min(box.topPt, other.topPt),
    bottomPt: Math.max(box.bottomPt, other.bottomPt),
  };
  return clipped.rightPt < clipped.leftPt || clipped.topPt < clipped.bottomPt ? undefined : clipped;
}

/** The clipping region left by two clip paths that do not meet: nothing after them is visible. */
const EMPTY_CLIP = 'empty clip';

/**
 * The region a mark is confined to: a box, {@link EMPTY_CLIP} when successive clip paths do not meet,
 * or undefined when nothing clips at all.
 *
 * The three cases are distinct and collapsing any two of them invents marks. "Nothing clips" and
 * "the clip is empty" are opposites — one shows the whole box, the other shows none of it — and a
 * single `undefined` standing for both made a pair of disjoint clips RELOCATE the region to the
 * second one, so a probe reported a box where a reader sees nothing.
 */
type Clip = Bounds | typeof EMPTY_CLIP | undefined;

/**
 * The part of `box` a reader can see through `clip`, or undefined when none of it is visible.
 *
 * @param box - The box a path covers, on the page.
 * @param clip - The region in force where it was painted.
 * @returns The visible part.
 */
function visibleThrough(box: Bounds, clip: Clip): Bounds | undefined {
  if (clip === undefined) return box;
  if (clip === EMPTY_CLIP) return undefined;
  return intersect(box, clip);
}

/**
 * `clip` narrowed by a further clipping path, which is what `W`/`W*` does.
 *
 * @param clip - The region in force.
 * @param path - The clipping path's box, on the page.
 * @returns The region after it.
 */
function narrowedBy(clip: Clip, path: Bounds): Clip {
  if (clip === undefined) return path;
  if (clip === EMPTY_CLIP) return EMPTY_CLIP;
  return intersect(path, clip) ?? EMPTY_CLIP;
}

/**
 * Whether the path at `index` is the one a `W`/`W*` names as a clipping path.
 *
 * pdf.js emits the clip OPERATOR as an entry of its own, immediately before the `constructPath` it
 * applies to; the path's own folded operator still says what the path is PAINTED with, which for the
 * usual `W n` is `endPath` and for a `W f` is a fill. So a clip cannot be recognised from the path
 * entry alone, and reading `endPath` as "this sets a clip" makes every discarded path — a bare `n`,
 * which prawn-svg writes — narrow everything drawn after it to itself.
 *
 * @param operations - The page's operators, in order.
 * @param index - Where the `constructPath` sits in them.
 * @returns Whether a clip operator precedes it.
 */
function clipsAt(operations: { readonly [index: number]: number }, index: number): boolean {
  if (index === 0) return false;
  const previous = operations[index - 1];
  return previous === OPS.clip || previous === OPS.eoClip;
}

/** The bounds pdf.js hands with a `constructPath`, in whatever shape it produced them. */
function boundsOf(operands: readonly unknown[]): number[] | undefined {
  const bounds: unknown = operands[2];
  // A typed array rather than a plain one, which `Array.isArray` says no to — and a `break` there
  // reads exactly like a page that paints nothing.
  if (!ArrayBuffer.isView(bounds) && !Array.isArray(bounds)) return undefined;
  const numbers = [...(bounds as Iterable<number>)].map(Number);
  return numbers.length >= 4 && numbers.every((value) => Number.isFinite(value)) ? numbers : undefined;
}

/** One painted path, reduced to the box it occupies. */
export interface PaintedBox {
  /** 1-based page it is drawn on. */
  readonly page: number;
  /** Whether the path was FILLED. A path that was only stroked reports false. */
  readonly filled: boolean;
  /** The fill colour in force when it was painted. */
  readonly colour: Rgb;
  /** Left edge, in points from the page's left. */
  readonly leftPt: number;
  /** Right edge, in points from the page's left. */
  readonly rightPt: number;
  /** Top edge, in points from the page's BOTTOM, which is the coordinate system the file uses. */
  readonly topPt: number;
  /** Bottom edge, in points from the page's bottom. */
  readonly bottomPt: number;
  /** Width in points. */
  readonly widthPt: number;
  /** Height in points. */
  readonly heightPt: number;
}

/**
 * Every box the document paints, in drawing order.
 *
 * This is the instrument for the marks the text formatter draws AROUND a run of text — a codespan's
 * tint, a key cap, a highlight. None of them reaches the text layer, and a raster can say what colour
 * they are but not where their edges are to a fraction of a point: an edge that falls between two
 * pixels is two grey rows either way, and these boxes are grown from their glyphs by offsets of a
 * point or less. The operator stream carries the rectangle the renderer asked for, which is the
 * thing worth comparing an element's box against.
 *
 * The box is pdf.js's own bounding box for the path, so a rounded rectangle reports the rectangle
 * rather than the corners — which is what a box drawn with `border-radius` reports too.
 *
 * @param bytes - The PDF file's bytes.
 * @returns One entry per painted path, in page order and then in drawing order.
 */
export async function paintedBoxes(bytes: Uint8Array): Promise<PaintedBox[]> {
  const pdfDocument = await openPdf(bytes);
  try {
    const boxes: PaintedBox[] = [];
    for (let page = 1; page <= pdfDocument.numPages; page += 1) {
      const pdfPage = await pdfDocument.getPage(page);
      const operators = await pdfPage.getOperatorList();
      let state: { colour: Rgb; matrix: Matrix; clip: Clip } = {
        colour: [0, 0, 0],
        matrix: IDENTITY,
        clip: undefined,
      };
      const stack: (typeof state)[] = [];
      for (const [index, op] of operators.fnArray.entries()) {
        const operands: unknown = operators.argsArray[index];
        switch (op) {
          case OPS.save: {
            stack.push({ ...state });
            break;
          }
          case OPS.restore: {
            state = stack.pop() ?? state;
            break;
          }
          case OPS.transform: {
            if (Array.isArray(operands) && operands.length >= 6) {
              state = {
                ...state,
                matrix: concatenate(state.matrix, operands.map(Number) as unknown as Matrix),
              };
            }
            break;
          }
          case OPS.setFillRGBColor: {
            state = { ...state, colour: fillColourOf(operands) ?? state.colour };
            break;
          }
          case OPS.constructPath: {
            if (!Array.isArray(operands)) break;
            // The folded shape `filledColours` reads too: the paint operator first, the path second,
            // and the box it covers third.
            const bounds = boundsOf(operands);
            if (bounds === undefined) break;
            const kind = Number(operands[0]);
            const mapped = mapBounds(bounds, state.matrix);
            // Whether this path also NAMES a clipping region, which is a separate question from what
            // it is painted with: `W n` sets one and paints nothing, `W f` sets one and is filled,
            // and a bare `n` sets none and paints nothing.
            const clips = clipsAt(operators.fnArray, index);
            // Painted first, and through the region in force BEFORE this path narrowed it: `W`
            // takes effect after the painting operator on the same path (PDF 32000-1, 8.5.4), so a
            // `W f` is filled through the region that was already there.
            //
            // What a reader sees is the paint inside the clip, not the rectangle the operator asked
            // for. An SVG's background is written as a rectangle the size of the whole artwork and
            // then confined to the viewport; unclipped it reported an extent nothing on the page has.
            if (kind !== OPS.endPath) {
              const painted = visibleThrough(mapped, state.clip);
              if (painted !== undefined) {
                boxes.push({
                  page,
                  filled: PATH_FILLS.has(kind),
                  colour: state.colour,
                  leftPt: painted.leftPt,
                  rightPt: painted.rightPt,
                  topPt: painted.topPt,
                  bottomPt: painted.bottomPt,
                  widthPt: painted.rightPt - painted.leftPt,
                  heightPt: painted.topPt - painted.bottomPt,
                });
              }
            }
            if (clips) state = { ...state, clip: narrowedBy(state.clip, mapped) };
            break;
          }
          default: {
            break;
          }
        }
      }
    }
    return boxes;
  } finally {
    await pdfDocument.loadingTask.destroy();
  }
}

/**
 * How much a transform scales a line width by.
 *
 * A line width is a thickness measured PERPENDICULAR to whichever way the path runs, so no single
 * column of the matrix expresses it: `Math.hypot(a, b)` is the x column, and under `4 0 0 1 0 0 cm`
 * it reports a 2pt rule as 8pt — the amount a HORIZONTAL distance is stretched by, which is the one
 * direction a horizontal rule's thickness does not lie in.
 *
 * What a non-uniform transform really does to a stroke is turn a round pen into an elliptical one, so
 * the width becomes a function of direction and no scalar is right for every path. `sqrt(|ad - bc|)`
 * — the square root of the determinant, which is the factor AREA is scaled by — is the standard
 * scalar for it: it is exact for every uniform transform (a scale, a rotation, a reflection, and any
 * composition of them), which is every transform an embedded SVG or a prawn context actually carries,
 * and for a non-uniform one it is the geometric mean of the two extremes rather than one of them.
 *
 * @param matrix - The transform in force.
 * @returns The factor a line width is multiplied by.
 */
function uniformScaleOf(matrix: Matrix): number {
  const [a, b, c, d] = matrix;
  return Math.sqrt(Math.abs(a * d - b * c));
}

/** The path-painting operators that put a STROKE on the page. */
const PATH_STROKES: ReadonlySet<number> = new Set([
  OPS.stroke,
  OPS.closeStroke,
  OPS.fillStroke,
  OPS.eoFillStroke,
  OPS.closeFillStroke,
  OPS.closeEOFillStroke,
]);

/** One stroked path, reduced to the line it draws. */
export interface StrokedPath {
  /** 1-based page it is drawn on. */
  readonly page: number;
  /** The stroke colour in force when it was drawn. */
  readonly colour: Rgb;
  /** The width the stroke was drawn at, in points. */
  readonly lineWidthPt: number;
  /** Left edge of the visible part of the path's box, in points from the page's left. */
  readonly leftPt: number;
  /** Right edge, in points from the page's left. */
  readonly rightPt: number;
  /** Top edge, in points from the page's BOTTOM, which is the coordinate system the file uses. */
  readonly topPt: number;
  /** Bottom edge, in points from the page's bottom. */
  readonly bottomPt: number;
}

/**
 * Every path the document strokes, in drawing order, with the colour and width it was stroked at.
 *
 * The companion to {@link paintedBoxes}, which reports what a path was FILLED with and cannot see a
 * stroke at all: a block's frame and a quotation's rule are strokes over a fill of a different
 * colour, so a fill-only reader attributes the wrong colour to both.
 *
 * A DECLARATION rather than a mark, deliberately, and the difference matters when choosing between
 * this and a raster. What a raster answers is "how heavy does this rule look to a reader", which is
 * the question `print-rules.spec.ts` asks and the reason it rasterises. What this answers is "which
 * theme value did the renderer draw this with" — the colour and the width it asked for, before any
 * rasteriser rounded them — and that is the question a comparison against the preview's own computed
 * style is asking, because a computed style is a declaration too. Comparing one side's declaration
 * against the other's raster is how a measurement comes to describe the instrument.
 *
 * `lineWidthPt` is scaled by the transform in force, and the path's box is MAPPED through it and then
 * CONFINED to the clipping region, so a stroke inside a scaled or clipped context reports the width
 * and the position it lands on the page at rather than the numbers in its own operands. pdf.js
 * reports a path's extent in the space the path was written in, which is the page's only while the
 * transform is the identity — as it is for every mark asciidoctor-pdf makes itself, and is not inside
 * an embedded SVG.
 *
 * The clip is applied to the PATH's box rather than to the ink, which is half a line width wider on
 * every side. That is the same box the unclipped reading reports, so the two stay comparable, and it
 * is what {@link paintedBoxes} confines too — a companion that narrowed one and not the other is how
 * a fill and the stroke around it stop being recognisable as the same rectangle.
 *
 * @param bytes - The PDF file's bytes.
 * @returns One entry per stroked path, in page order and then in drawing order.
 */
export async function strokedPaths(bytes: Uint8Array): Promise<StrokedPath[]> {
  const pdfDocument = await openPdf(bytes);
  try {
    const strokes: StrokedPath[] = [];
    for (let page = 1; page <= pdfDocument.numPages; page += 1) {
      const pdfPage = await pdfDocument.getPage(page);
      const operators = await pdfPage.getOperatorList();
      let state: { colour: Rgb; lineWidth: number; matrix: Matrix; clip: Clip } = {
        colour: [0, 0, 0],
        lineWidth: 1,
        matrix: IDENTITY,
        clip: undefined,
      };
      const stack: (typeof state)[] = [];
      for (const [index, op] of operators.fnArray.entries()) {
        const operands: unknown = operators.argsArray[index];
        switch (op) {
          case OPS.save: {
            stack.push({ ...state });
            break;
          }
          case OPS.restore: {
            state = stack.pop() ?? state;
            break;
          }
          case OPS.transform: {
            if (Array.isArray(operands) && operands.length >= 6) {
              state = {
                ...state,
                matrix: concatenate(state.matrix, operands.map(Number) as unknown as Matrix),
              };
            }
            break;
          }
          case OPS.setStrokeRGBColor: {
            state = { ...state, colour: fillColourOf(operands) ?? state.colour };
            break;
          }
          case OPS.setLineWidth: {
            if (Array.isArray(operands) && typeof operands[0] === 'number') {
              state = { ...state, lineWidth: operands[0] };
            }
            break;
          }
          case OPS.constructPath: {
            if (!Array.isArray(operands)) break;
            const bounds = boundsOf(operands);
            if (bounds === undefined) break;
            const mapped = mapBounds(bounds, state.matrix);
            // Read BEFORE this path narrows the region, for the same reason as in `paintedBoxes`:
            // `W S` strokes through the region already in force and only what follows sees the new
            // one. And a path that sets a clip has to be seen here even when it strokes nothing,
            // which is why the stroke test no longer decides whether this entry is looked at.
            const clips = clipsAt(operators.fnArray, index);
            if (PATH_STROKES.has(Number(operands[0]))) {
              const drawn = visibleThrough(mapped, state.clip);
              if (drawn !== undefined) {
                strokes.push({
                  page,
                  colour: state.colour,
                  lineWidthPt: state.lineWidth * uniformScaleOf(state.matrix),
                  leftPt: drawn.leftPt,
                  rightPt: drawn.rightPt,
                  topPt: drawn.topPt,
                  bottomPt: drawn.bottomPt,
                });
              }
            }
            if (clips) state = { ...state, clip: narrowedBy(state.clip, mapped) };
            break;
          }
          default: {
            break;
          }
        }
      }
    }
    return strokes;
  } finally {
    await pdfDocument.loadingTask.destroy();
  }
}

/**
 * Read a fill-colour operand, in either shape pdf.js produces.
 *
 * @param operands - The operator's arguments.
 * @returns The colour, or undefined when the operand is not one this can decode.
 */
function fillColourOf(operands: unknown): Rgb | undefined {
  if (!Array.isArray(operands) || operands.length === 0) return undefined;
  const first: unknown = operands[0];
  if (typeof first === 'string') {
    const match = /^#([\da-f]{2})([\da-f]{2})([\da-f]{2})$/i.exec(first.trim());
    if (match === null) return undefined;
    return [
      Number.parseInt(match[1], 16),
      Number.parseInt(match[2], 16),
      Number.parseInt(match[3], 16),
    ];
  }
  if (operands.length >= 3 && operands.every((value) => typeof value === 'number')) {
    return [Number(operands[0]), Number(operands[1]), Number(operands[2])];
  }
  return undefined;
}

/** The visible text a show-text operator's argument carries, ignoring its kerning adjustments. */
function showTextOf(operands: unknown): string {
  if (!Array.isArray(operands) || operands.length === 0) return '';
  const glyphs: unknown = operands[0];
  if (!Array.isArray(glyphs)) return '';
  return glyphs
    .map((glyph) => {
      if (typeof glyph === 'string') return glyph;
      // A glyph object carries the character it stands for; a bare number is a kerning adjustment.
      return isRecord(glyph) && typeof glyph.unicode === 'string' ? glyph.unicode : '';
    })
    .join('');
}

/**
 * Each page's size and the box its ink occupies.
 *
 * The insets are measured from the ink rather than declared, because a margin is only a margin if
 * nothing is drawn in it. The measurement rasterizes, so it sees rules, fills and images as well as
 * text — which is the point: a page whose text respects the margin and whose sidebar does not has
 * the wrong geometry, and a text-only measurement would call it right.
 *
 * @param bytes - The PDF file's bytes.
 * @param dpi - Raster resolution for the ink measurement; higher costs time and buys precision.
 * @returns One entry per page.
 */
export async function pageGeometries(bytes: Uint8Array, dpi = 150): Promise<PageGeometry[]> {
  const ink = pageInkMaps(bytes, dpi);
  const pdfDocument = await openPdf(bytes);
  try {
    const geometries: PageGeometry[] = [];
    for (let page = 1; page <= pdfDocument.numPages; page += 1) {
      const pdfPage = await pdfDocument.getPage(page);
      const [x0, y0, x1, y1] = pdfPage.view;
      const widthPt = x1 - x0;
      const heightPt = y1 - y0;
      const box = ink[page - 1]?.bbox ?? null;
      const left = box === null ? 0 : box.x0 * widthPt;
      const right = box === null ? 0 : (1 - box.x1) * widthPt;
      // The ink bbox is measured on the raster, whose origin is the TOP-left; the PDF's is bottom-left.
      const top = box === null ? 0 : box.y0 * heightPt;
      const bottom = box === null ? 0 : (1 - box.y1) * heightPt;
      geometries.push({
        page,
        widthPt,
        heightPt,
        leftInsetPt: left,
        rightInsetPt: right,
        topInsetPt: top,
        bottomInsetPt: bottom,
        contentWidthPt: box === null ? 0 : (box.x1 - box.x0) * widthPt,
      });
    }
    return geometries;
  } finally {
    await pdfDocument.loadingTask.destroy();
  }
}

/**
 * One page of the document, rasterised in colour and addressable pixel by pixel.
 *
 * Every measurement above this one reads the file's own description of itself — its text layer, its
 * operator stream, its annotation table. That is the right instrument for anything the file NAMES,
 * and the wrong one for anything it merely DRAWS. A table's frame, the rule under its header row and
 * the column rule beside an admonition are all strokes on a path: the file records a colour, a width
 * and two points, and what a reader sees is what the rasteriser makes of them. Reading the stroke
 * width out of the stream would compare a declaration against a declaration and prove nothing about
 * the mark; a raster is the only instrument that can say "this rule is three pixels of that colour
 * and the ones under it are one".
 *
 * poppler writes a colour raster as a binary PPM without being asked to, so this costs no dependency
 * — the same reason the grayscale ink maps above are read the way they are.
 */
export interface PageRaster {
  /** 1-based page number. */
  readonly page: number;
  /** Raster width in pixels. */
  readonly widthPx: number;
  /** Raster height in pixels. */
  readonly heightPx: number;
  /** The resolution it was rasterised at, which is what turns a run of pixels back into points. */
  readonly dpi: number;
  /**
   * The colour of one pixel.
   *
   * @param x - Column, in pixels from the raster's left edge.
   * @param y - Row, in pixels from its top edge.
   * @returns The pixel's colour; anything outside the raster reads as the paper's white.
   */
  readonly colourAt: (x: number, y: number) => Rgb;
}

/**
 * Rasterise every page in colour.
 *
 * @param bytes - The PDF file's bytes.
 * @param dpi - Resolution. Higher resolves a thinner rule and costs time; 150 is what the rest of
 *   this module rasterises at, and a 0.5pt hairline is already one pixel there.
 * @returns One raster per page, in page order.
 */
export function pageRasters(bytes: Uint8Array, dpi = 150): PageRaster[] {
  return withTemporaryPdf(bytes, (pdfPath, directory) => {
    const prefix = path.join(directory, 'page');
    execFileSync('pdftoppm', ['-r', String(dpi), pdfPath, prefix]);
    const files = readdirSync(directory)
      .filter((name) => name.startsWith('page') && name.endsWith('.ppm'))
      .toSorted((a, b) => a.localeCompare(b, undefined, { numeric: true }));
    return files.map((name, index) => {
      const { width, height, data } = parseNetpbm(readFileSync(path.join(directory, name)), 6);
      return {
        page: index + 1,
        widthPx: width,
        heightPx: height,
        dpi,
        colourAt: (x: number, y: number): Rgb => {
          if (x < 0 || y < 0 || x >= width || y >= height) return [255, 255, 255];
          const at = (y * width + x) * 3;
          return [data[at], data[at + 1], data[at + 2]];
        },
      };
    });
  });
}

/**
 * Whether two colours are the same mark, allowing for the rasteriser's own rounding.
 *
 * @param a - One colour.
 * @param b - The other.
 * @param tolerance - Per-channel slack out of 255.
 * @returns Whether they agree.
 */
export function sameColour(a: Rgb, b: Rgb, tolerance = PRINT_FIDELITY_TOLERANCE.colourChannel): boolean {
  return a.every((channel, index) => Math.abs(channel - b[index]) <= tolerance);
}
