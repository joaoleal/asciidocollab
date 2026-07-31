/**
 * @file Reduces the two preview formats to the three things BOTH of them can express, so they can be
 * compared at all.
 *
 * The formats are different media. One is a DOM the browser lays out; the other is a paginated
 * document with a text layer, an outline and link annotations. There is no byte- or DOM-level
 * comparison between them, so agreement is judged on three dimensions and nothing else:
 *
 *   1. the rendered text, in document order;
 *   2. the heading hierarchy, including any section numbers;
 *   3. the cross-reference targets, and whether each one resolves.
 *
 * Fonts, spacing, colour, page breaks and layout are NOT compared — they are page-format concerns
 * with no web-format counterpart, and they belong to the page-format reference-parity suite, which is
 * the right oracle for them. That exclusion is what makes the text dimension a comparison of
 * WHITESPACE-FREE text: line breaking is layout, and the two media break lines in completely
 * different places for the same content.
 *
 * Everything the two media draw differently is a NAMED reconciliation below, never a comparison
 * loosened until the corpus passes. Each rule states which side it rewrites and to what, and the
 * spec pins every one of them against markup small enough to read — because a corpus that passes
 * looks exactly the same whether the reconciliation is precise or whether it has been widened until
 * nothing can fail.
 */

import { existsSync } from 'node:fs';
import path from 'node:path';
// The legacy build is the one meant to run outside a browser, and it is already this app's PDF
// reader. The page format's heading hierarchy (its outline) and its cross-reference targets (its link
// annotations) are both structures poppler cannot report jointly, so one reader serves all three
// dimensions and this gate keeps the page-format suite's poppler prerequisite off its own back.
import { getDocument, type PDFDocumentProxy } from 'pdfjs-dist/legacy/build/pdf.mjs';
import type { ProjectSnapshot } from '@asciidocollab/asciidoc-pdf';
import { SOFT_DEFAULT_SUFFIX } from '@asciidocollab/shared';
import { internalLinkTargets } from '../../pdf-parity/harness/pdftools';
import { APP_RENDER_DEFAULT_ATTRIBUTES } from '../../../src/lib/asciidoc/render-app-defaults';
import { corpusFiles, type CorpusDocument } from './capture';

/** The built page-format engine, which this gate cannot run without. */
export const WASM_ENGINE_PATH = path.join(
  process.cwd(),
  '..',
  '..',
  'packages',
  'asciidoc-pdf',
  'ruby',
  'asciidoctor-pdf.wasm',
);

/** Whether the page-format engine has been built, so the gate can skip cleanly instead of failing. */
export function pageFormatEngineAvailable(): boolean {
  return existsSync(WASM_ENGINE_PATH);
}

/**
 * The deepest heading level AsciiDoc renders, and so the depth the page format's outline is asked
 * for.
 *
 * The outline is where the page format states its heading hierarchy, and it is truncated by default
 * (`outlinelevels` falls back to `toclevels`, which is 2). Left at the default, a document with
 * level-3 headings would express only part of its own structure and the comparison would silently
 * stop covering the rest. Raising it changes no rendered content — bookmarks are not drawn on a page.
 */
const DEEPEST_HEADING_LEVEL = 5;

/**
 * Corpus documents deliberately left out of this comparison, each with the reason it is out.
 *
 * Kept as data, and checked by the spec against the corpus, so a document dropped from the shared set
 * is a visible decision rather than an omission nobody notices.
 */
export const EXCLUDED_FROM_CROSS_FORMAT: ReadonlyMap<string, string> = new Map([
  [
    'images',
    'The document exists for the web format\'s image-source rewrite — a web-only pass that maps a ' +
      'project-relative target onto the authenticated image endpoint. Its targets are fictional, so ' +
      'the web format emits <img> elements (no text at all) while the page format draws a ' +
      'missing-image placeholder naming the alt text and the target. Neither side\'s output is the ' +
      'other\'s content in a different medium.',
  ],
  [
    'diagrams-stem',
    'Diagram and equation blocks are drawn AFTER conversion, by different machinery on each side: ' +
      'the web format emits an inert placeholder carrying the source for the main thread to draw, ' +
      'the page format hands the block to a rendering shim and embeds the drawn asset. Comparing ' +
      'them would compare the two shim stacks, not the two previews.',
  ],
]);

/** A rendered document reduced to the three dimensions the two formats can both express. */
export interface CrossFormatDocument {
  /**
   * The rendered text in document order, with every whitespace character removed.
   *
   * Whitespace is gone rather than normalised because spacing and line breaking are layout, which
   * this gate does not compare: the same paragraph wraps at a column width on one side and at
   * whatever width the reader's pane happens to be on the other.
   */
  readonly text: string;
  /** Every heading in document order, as `<level> <text>` — the number, when there is one, is in the text. */
  readonly headings: readonly string[];
  /** Every cross-reference target, sorted, and whether it resolves. */
  readonly references: readonly string[];
}

/**
 * Reduce the web format's rendered HTML to the three comparable dimensions.
 *
 * Runs inside a real browser page (it is handed to `page.evaluate`), so it must stay free of
 * references to module scope: a real HTML parser is the only honest way to decide what the markup
 * means, and hand-rolling one would make the verdict a property of the parser rather than the render.
 *
 * Four of the reconciliations live here, because each is something the web format renders in a shape
 * the page format does not — or, in the first case, does not put in the markup as text at all:
 *
 *   - **ordered-list markers.** The page format writes `1.` / `a.` into its text layer; the web
 *     format has the browser draw them from CSS counters, so there is no text to compare. The marker
 *     the browser draws is reconstructed from the list's numbering style and the item's position —
 *     list COUNTING is content, and dropping the page format's markers instead would stop comparing
 *     it.
 *   - **callout numbers.** Written `(1)` beside the code and `1` in the callout list by the web
 *     format, and as a circled digit by the page format. Both become `(1)`; the `<i class="conum">`
 *     element carries the value, so the `<b>` that follows it is the same number written again.
 *   - **footnote definition labels.** The web format labels a definition `1.` and the page format
 *     `[1]`. Both become `[1]`: the shape goes, the number stays and is compared.
 *   - **quote attribution.** The page format writes an attribution as one line, `— author, citation`;
 *     the web format breaks the line instead. Line breaking is layout, so the web side's attribution
 *     is emitted in the page format's single-line form.
 *
 * @param html - The rendered preview HTML.
 * @returns The document reduced to its text, headings and cross-reference targets.
 */
export function extractWebFormatDocument(html: string): CrossFormatDocument {
  const parsed = new DOMParser().parseFromString(html, 'text/html');

  const pieces: string[] = [];
  const headings: string[] = [];

  /** Roman numerals, largest first, as an ordered list's `lowerroman`/`upperroman` styles draw them. */
  const romanDigits: ReadonlyArray<readonly [number, string]> = [
    [1000, 'm'], [900, 'cm'], [500, 'd'], [400, 'cd'], [100, 'c'], [90, 'xc'],
    [50, 'l'], [40, 'xl'], [10, 'x'], [9, 'ix'], [5, 'v'], [4, 'iv'], [1, 'i'],
  ];

  /** The marker the browser draws for one item of an ordered list, in the page format's `N.` shape. */
  const orderedMarker = (list: Element, position: number): string => {
    const declaredStart = Number(list.getAttribute('start') ?? '1');
    let ordinal = (Number.isInteger(declaredStart) ? declaredStart : 1) + position;
    const style = list.getAttribute('type') ?? '';
    const named = (name: string): boolean => style === name || list.classList.contains(name);

    if (named('a') || named('loweralpha') || named('A') || named('upperalpha')) {
      // a, b, … z, aa, ab, … — the same sequence a browser's `list-style-type` produces.
      let letters = '';
      while (ordinal > 0) {
        letters = String.fromCodePoint(97 + ((ordinal - 1) % 26)) + letters;
        ordinal = Math.floor((ordinal - 1) / 26);
      }
      return `${named('A') || named('upperalpha') ? letters.toUpperCase() : letters}.`;
    }
    if (named('i') || named('lowerroman') || named('I') || named('upperroman')) {
      let numeral = '';
      for (const [value, glyph] of romanDigits) {
        while (ordinal >= value) {
          numeral += glyph;
          ordinal -= value;
        }
      }
      return `${named('I') || named('upperroman') ? numeral.toUpperCase() : numeral}.`;
    }
    return `${String(ordinal)}.`;
  };

  // Nodes the walk passes over because something else already accounted for them, and text nodes
  // whose leading `.` is part of a marker rather than part of the sentence.
  const alreadyAccountedFor = new Set<Node>();
  const markerPunctuation = new Set<Node>();

  for (const conum of parsed.querySelectorAll('i.conum[data-value]')) {
    const written = conum.nextElementSibling;
    // `<b>(1)</b>` beside the code, `<b>1</b>` in the callout list: the same number the `<i>` carries.
    if (written !== null && written.tagName.toLowerCase() === 'b') alreadyAccountedFor.add(written);
  }
  for (const definition of parsed.querySelectorAll('div.footnote[id]')) {
    const backLink = definition.querySelector('a');
    if (backLink === null) continue;
    alreadyAccountedFor.add(backLink);
    const trailing = backLink.nextSibling;
    if (trailing instanceof Text) markerPunctuation.add(trailing);
  }

  const walk = (node: Node): void => {
    if (alreadyAccountedFor.has(node)) return;

    if (node instanceof Text) {
      // The `.` that follows a footnote definition's back-link is the other half of its marker, which
      // the page format writes as `[1]`; the marker is emitted whole below, so the stray `.` goes.
      pieces.push(markerPunctuation.has(node) ? node.data.replace(/^\s*\.\s*/u, ' ') : node.data);
      return;
    }
    if (!(node instanceof Element)) return;

    const tag = node.tagName.toLowerCase();

    if (tag === 'br') {
      // Inside an attribution the page format writes a comma where the web format breaks the line.
      pieces.push(node.closest('.attribution') === null ? ' ' : ', ');
      return;
    }
    if (tag === 'i' && node instanceof HTMLElement && node.classList.contains('conum')) {
      pieces.push(` (${node.dataset.value ?? ''}) `);
      return;
    }
    if (/^h[1-6]$/u.test(tag)) {
      headings.push(`${tag.slice(1)} ${(node.textContent ?? '').replaceAll(/\s+/gu, ' ').trim()}`);
    }
    const list = node.parentElement;
    if (tag === 'li' && list !== null && list.tagName.toLowerCase() === 'ol') {
      pieces.push(` ${orderedMarker(list, [...list.children].indexOf(node))} `);
    }
    if (tag === 'div' && node.classList.contains('footnote')) {
      const backLink = node.querySelector('a');
      if (backLink !== null) pieces.push(` [${backLink.textContent ?? ''}] `);
    }

    for (const child of node.childNodes) walk(child);
  };

  for (const child of parsed.body.childNodes) walk(child);

  const identifiers = new Set([...parsed.querySelectorAll('[id]')].map((element) => element.id));
  const references: string[] = [];
  for (const anchor of parsed.querySelectorAll('a[href^="#"]')) {
    const target = (anchor.getAttribute('href') ?? '#').slice(1);
    references.push(identifiers.has(target) ? target : `${target} (unresolved)`);
  }

  return {
    text: pieces.join('').replaceAll(/\s+/gu, ''),
    headings,
    references: references.toSorted(),
  };
}

/**
 * The project snapshot the page format renders a corpus document from.
 *
 * The same files and the same attribute seed the web format's request carries, so the two formats are
 * converting the same document: `include::` bodies are expanded by both (the web format's assembler
 * before conversion, the engine's own resolver during it), and the app's render defaults reach both.
 * `showtitle` is left out because it is a web-format control — it asks the HTML backend to keep the
 * document title in embedded output, which a page format always renders.
 *
 * @param document - The corpus document to render.
 * @returns The snapshot to hand to the page-format engine.
 */
export function pageFormatSnapshot(document: CorpusDocument): ProjectSnapshot {
  return {
    files: corpusFiles(),
    binaryAssets: {},
    rootPath: document.relativePath,
    openPath: document.relativePath,
    fontPaths: [],
    attributes: {
      ...APP_RENDER_DEFAULT_ATTRIBUTES,
      stem: SOFT_DEFAULT_SUFFIX,
      outlinelevels: String(DEEPEST_HEADING_LEVEL),
    },
  };
}

/** The bullet and checkbox glyphs the page format draws in a list item's marker position. */
const PAGE_FORMAT_LIST_MARKERS = /[•◦▪‣⁃☐☑☒✓❏]/gu;

/** The circled digits ① … ⑳, which is how the page format writes a callout number. */
const PAGE_FORMAT_CALLOUT_NUMBERS = /[①-⑳]/gu;

/**
 * The Unicode private-use areas: code points with no meaning outside the font that defines them.
 *
 * The page format draws an admonition's icon from an icon font, and the glyph lands in the text layer
 * at its private-use slot (a note comes out as U+F05A, Font Awesome's own numbering). It is not text
 * in any sense a reader would recognise, and by definition nothing outside that font can say what it
 * stands for.
 */
const PRIVATE_USE_GLYPHS = /[\u{E000}-\u{F8FF}\u{F0000}-\u{FFFFD}\u{100000}-\u{10FFFD}]/gu;

/**
 * Reconcile the page format's text layer with what the web format puts in its markup.
 *
 * Three named rules, all of which rewrite the PAGE side:
 *
 *   - **list marker glyphs.** A bullet (`•`, `◦`, `▪`) or a checkbox (`☐`, `☑`) is drawn in the
 *     marker position; the web format has no text there at all, because the browser draws its
 *     markers from CSS. Only the glyphs go — an ordered list's `1.` stays, and the web side
 *     reconstructs it, because the numbering counts something.
 *   - **callout numbers.** A circled digit becomes `(1)`, the form the web format writes beside the
 *     code, so a changed or misnumbered callout still fails on either side.
 *   - **icon-font glyphs.** A private-use code point is an icon the page format drew, which the web
 *     format draws from CSS on an empty element. Only the private-use areas go, so an admonition's
 *     LABEL — text, on either side, whenever `icons` is unset — is still compared.
 *
 * @param text - The page format's extracted text.
 * @returns The text with all three rules applied.
 */
export function reconcilePageFormatText(text: string): string {
  return text
    .replaceAll(PAGE_FORMAT_LIST_MARKERS, ' ')
    .replaceAll(PRIVATE_USE_GLYPHS, ' ')
    .replaceAll(PAGE_FORMAT_CALLOUT_NUMBERS, (glyph) => {
      // ① is U+2460, so the glyph's offset from the one before it is the number it stands for.
      const value = (glyph.codePointAt(0) ?? 0x24_5F) - 0x24_5F;
      return ` (${String(value)}) `;
    });
}

/** True for any non-null object, so its properties can be read as `unknown` without an assertion. */
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

/** Flatten the page format's outline into `<depth> <title>` entries in document order. */
function flattenOutline(nodes: readonly unknown[], depth: number, into: Array<{ depth: number; title: string }>): void {
  for (const node of nodes) {
    if (!isRecord(node) || typeof node.title !== 'string') continue;
    into.push({ depth, title: node.title.replaceAll(/\s+/gu, ' ').trim() });
    flattenOutline(Array.isArray(node.items) ? node.items : [], depth + 1, into);
  }
}

/**
 * The page format's text layer, page by page, with its running furniture removed.
 *
 * Read in content-stream order rather than in visual columns. The page-format parity suite reads the
 * layout-preserving form, which is right for its own job (a PDF against another PDF, where padded
 * columns line up), and wrong for this one: a paragraph flowed beside a second table cell, or a
 * footnote marker raised above its line, comes back interleaved, and the reading order a cross-medium
 * comparison rests on is gone. Lines are then normalised exactly as that suite normalises them —
 * trimmed, internal whitespace collapsed, empties dropped.
 */
async function pageFormatText(pdf: PDFDocumentProxy): Promise<string> {
  const lines: string[] = [];
  for (let pageNumber = 1; pageNumber <= pdf.numPages; pageNumber += 1) {
    const page = await pdf.getPage(pageNumber);
    const content = await page.getTextContent();
    const pageLines: string[] = [];
    let line = '';
    for (const item of content.items) {
      if (!('str' in item)) continue;
      line += item.str;
      if (item.hasEOL) {
        pageLines.push(line);
        line = '';
      }
    }
    if (line !== '') pageLines.push(line);

    const normalised = pageLines
      .map((entry) => entry.trim().replaceAll(/\s+/gu, ' '))
      .filter((entry) => entry !== '');
    // Page furniture: the running footer's page number. Page breaks are not compared, and the number
    // in the footer is a statement about where the break fell.
    if (normalised.at(-1) === String(pageNumber)) normalised.pop();
    lines.push(...normalised);
  }
  return lines.join('\n');
}

/**
 * Reduce a rendered PDF to the same three dimensions.
 *
 * The heading hierarchy comes from the document outline rather than from the text layer, because the
 * text layer records what each heading SAYS and not what level it sits at — the level is drawn as a
 * font size, which is exactly the kind of presentation this gate does not compare. The outline is the
 * page format's own statement of its section tree.
 *
 * @param bytes - The rendered PDF.
 * @returns The document reduced to its text, headings and cross-reference targets.
 */
export async function extractPageFormatDocument(bytes: Uint8Array): Promise<CrossFormatDocument> {
  const links = await internalLinkTargets(bytes);
  const pdf = await getDocument({
    data: new Uint8Array(bytes),
    isEvalSupported: false,
    useSystemFonts: false,
    verbosity: 0, // Errors only: font/standard-data notices would drown the run's output.
  }).promise;
  try {
    const text = reconcilePageFormatText(await pageFormatText(pdf)).replaceAll(/\s+/gu, '');

    const outlineRaw: unknown = await pdf.getOutline();
    const entries: Array<{ depth: number; title: string }> = [];
    flattenOutline(Array.isArray(outlineRaw) ? outlineRaw : [], 0, entries);
    // The outline lists the document title FIRST and as a sibling of the level-1 sections rather than
    // as their parent, so depth alone does not give the heading level: the title is the level-1
    // heading (`<h1>`) and a section at depth d is the heading `d + 2` levels down.
    const headings = entries.map((entry, index) =>
      index === 0 ? `1 ${entry.title}` : `${entry.depth + 2} ${entry.title}`,
    );

    const references = links
      .map((link) => {
        const name = link.targetName ?? '(destination with no name)';
        return link.targetPage === null ? `${name} (unresolved)` : name;
      })
      .toSorted();

    return { text, headings, references };
  } finally {
    // Releases the (fake, in-process) worker; without it the Node process keeps a live task per PDF.
    await pdf.destroy();
  }
}

/** How much of the agreed text is shown before a divergence, to place it in the document. */
const AGREED_CONTEXT = 90;

/** How much of each side is shown from the point they diverge. */
const DIVERGENT_CONTEXT = 130;

/**
 * Describe where the two formats' rendered text stops agreeing, or `null` when it never does.
 *
 * Anchored at the first differing character: one dropped word shifts everything after it, and a
 * report that showed the whole of both sides would say "everything differs" about a one-word loss.
 *
 * @param web - The web format's whitespace-free rendered text.
 * @param page - The page format's whitespace-free rendered text.
 * @returns A human-readable report, or `null` when the two texts are identical.
 */
export function describeTextDifference(web: string, page: string): string | null {
  let agreed = 0;
  while (agreed < web.length && agreed < page.length && web[agreed] === page[agreed]) {
    agreed += 1;
  }
  if (agreed === web.length && agreed === page.length) return null;
  return [
    `rendered text: the two formats agree for ${agreed} character(s) and then diverge ` +
      `(web format has ${web.length}, page format ${page.length}). Whitespace is already removed ` +
      'from both sides — spacing and line breaking are layout, which this gate does not compare.',
    `    in both … ${web.slice(Math.max(0, agreed - AGREED_CONTEXT), agreed)}`,
    `  - web  … ${web.slice(agreed, agreed + DIVERGENT_CONTEXT)}`,
    `  + page … ${page.slice(agreed, agreed + DIVERGENT_CONTEXT)}`,
  ].join('\n');
}
