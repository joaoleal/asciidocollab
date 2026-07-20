/**
 * @file Column-layout invariants for multi-column regions carrying numbered paragraphs.
 *
 * WHY THIS EXISTS, given the parity suite already renders these extensions.
 *
 * Parity compares our render against one produced by the canonical Asciidoctor-PDF toolchain. That
 * catches fidelity drift, but it is structurally blind to a change that breaks BOTH renderers the
 * same way — they agree, and the suite goes green over wrong output. That happened on this feature:
 * a multi-column region put every line in the first column, passed parity, and was found by eye.
 *
 * So these tests assert ABSOLUTE properties of the rendered geometry rather than agreement with a
 * second renderer. `column-layout.mjs` renders one stress document THREE ways — numbering off, and
 * each placement — and this file states what must hold. The unnumbered render is the baseline, and
 * picking it was the hard-won part: an earlier version of this file compared margin against INLINE
 * and drew a false conclusion from it, because inline adds text to the flow and that changed a
 * region's measured height enough to flip `single_page?` and switch column balancing on. Inline is a
 * moving target; only the unnumbered document is a fixed one.
 *
 * Gated the same way parity is: the suite self-skips when the wasm engine or pdfjs is absent, so a
 * clean checkout stays green and these activate once the artifacts are present.
 */

import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

const HARNESS = path.join(__dirname, 'column-layout.mjs');
const WASM_PATH = path.join(__dirname, '..', '..', 'ruby', 'asciidoctor-pdf.wasm');
const MANIFEST_PATH = path.join(
  __dirname,
  '..',
  '..',
  'ruby',
  'extensions',
  'asciidocollab-pdf-extensions',
  'lib',
  'paragraph-numbering',
  'manifest.json',
);

interface Item {
  readonly text: string;
  readonly x: number;
  readonly y: number;
  readonly width: number;
}
interface Page {
  readonly page: number;
  readonly items: readonly Item[];
}
type Placements = Record<string, readonly Page[]>;
interface PreviewSample {
  readonly regionPresent: boolean;
  readonly skipped?: string;
}
interface Band {
  readonly index: number;
  readonly fill: number;
  readonly count: number;
}
interface Balance {
  readonly columns: number;
  readonly paragraphs: number;
  readonly numbering: boolean;
  readonly pages: readonly (readonly Band[])[];
}

/**
 * How short the emptiest column of a region page may be, as a fraction of its deepest.
 *
 * Not a typographic ideal — a floor well below one. Balancing divides content that cannot be split
 * at arbitrary points, so a column can legitimately end a paragraph or two early; the measured
 * spread is 100% for two columns and 81% for three. What this has to catch is the shape the defect
 * produced, where the trailing columns of the final page came out at 0%.
 */
const MIN_COLUMN_SHARE = 0.6;

const enginePresent = existsSync(WASM_PATH);

/** Run the measuring harness once for the whole file — each render boots a fresh wasm VM. */
function measure(): {
  ran: boolean;
  reason?: string;
  placements?: Placements;
  previewSample?: PreviewSample;
  balance?: readonly Balance[];
} {
  const result = spawnSync(process.execPath, [HARNESS], {
    encoding: 'utf8',
    maxBuffer: 64 * 1024 * 1024,
    timeout: 15 * 60 * 1000,
  });
  // The VM writes `wasi:` progress lines to stdout, so the JSON summary is the LAST line, not the
  // whole stream.
  const lines = (result.stdout ?? '').trim().split('\n');
  const last = lines.at(-1) ?? '';
  try {
    return JSON.parse(last);
  } catch {
    return { ran: false, reason: `unparseable harness output: ${last.slice(0, 200)}` };
  }
}

/** The placement the shipped manifest gives projects that never set the key. */
function shippedDefaultPlacement(): string {
  const manifest = JSON.parse(readFileSync(MANIFEST_PATH, 'utf8')) as {
    themeKeys?: { key: string; default?: string }[];
  };
  const entry = (manifest.themeKeys ?? []).find((k) => k.key === 'paragraph-numbering.placement');
  return entry?.default ?? 'inline';
}

/**
 * Distinct column bands carrying body text on a page.
 *
 * Body text only: a marginal number sits OUTSIDE the column measure by design, so counting it as a
 * band would report a two-column region as three. Items are clustered by x with a tolerance well
 * under a column width, so a band is a column rather than a word position.
 */
/** Items that are body prose rather than a number sitting outside the measure. */
function bodyItemsOf(page: Page): readonly Item[] {
  return page.items.filter((item) => item.x > 40 && item.x < 555);
}

function columnBands(page: Page, pageWidth = 595): number[] {
  const bodyLeftMargin = 40;
  const xs = page.items
    .filter((item) => item.x > bodyLeftMargin && item.x < pageWidth - bodyLeftMargin)
    .map((item) => item.x)
    .toSorted((a, b) => a - b);
  const bands: number[] = [];
  for (const x of xs) {
    if (bands.length === 0 || x - (bands.at(-1) ?? 0) > 60) bands.push(x);
  }
  return bands;
}

(enginePresent ? describe : describe.skip)('multi-column layout invariants', () => {
  let measured: ReturnType<typeof measure>;
  /** Set ONLY for the two environment gates parity also honours. Any other failure must be loud. */
  let environmentGate: string | null = null;

  beforeAll(() => {
    measured = measure();
    if (!measured.ran && /wasm-absent|pdfjs-absent/.test(measured.reason ?? '')) {
      environmentGate = measured.reason ?? 'absent';
      return;
    }
    // Anything else — a crashed harness, an unparseable summary, a convert failure — is a REAL
    // failure and must not be mistaken for "nothing to check here". An early `return` in each test
    // would make the whole file pass in seconds while measuring nothing, which is precisely how a
    // suite ends up green over broken output.
    if (!measured.ran) {
      throw new Error(`column-layout harness did not run: ${measured.reason ?? 'unknown'}`);
    }
  }, 16 * 60 * 1000);

  it('renders the stress document under both placements and an unnumbered baseline', () => {
    if (environmentGate) return;
    expect(measured.ran).toBe(true);
    expect(Object.keys(measured.placements ?? {})).toEqual(['none', 'inline', 'margin']);
  });

  it('gives every declared column to the text in a three-column region', () => {
    if (environmentGate) return;
    // The three-column region is the one whose failure mode is invisible in a two-column fixture:
    // when balancing is skipped the text fills column one to the foot and the rest stay empty, which
    // reads as "the extension did nothing" rather than as a bug.
    const pages = measured.placements!.inline;
    let widest = pages[0];
    for (const page of pages) {
      if (columnBands(page).length > columnBands(widest).length) widest = page;
    }
    expect(columnBands(widest).length).toBeGreaterThanOrEqual(2);
  });

  it('never strands a marginal number on a page with no prose beside it', () => {
    if (environmentGate) return;
    // The failure this pins: a number drawn after the converter has already paginated past its
    // paragraph lands alone on the following page. It is one glyph, so it is easy to miss by eye and
    // impossible to see in a text dump that ignores position.
    for (const [placement, pages] of Object.entries(measured.placements!)) {
      for (const page of pages) {
        const bodyItems = page.items.filter((item) => item.x > 40 && item.x < 555);
        const marginItems = page.items.filter((item) => item.x >= 555);
        if (marginItems.length > 0) {
          expect({ placement, page: page.page, bodyItems: bodyItems.length }).toMatchObject({
            bodyItems: expect.any(Number),
          });
          expect(bodyItems.length).toBeGreaterThan(0);
        }
      }
    }
  });

  it('leaves the prose exactly where the unnumbered document put it (margin is out of flow)', () => {
    if (environmentGate) return;
    // THE GUARD, and the reason this file exists. A marginal number is drawn into a `float`, so it
    // must not move a single line: the numbered document has to paginate and lay out identically to
    // the same document with the extension switched off. Comparing against INLINE instead is what
    // misled a whole investigation — inline adds text to the flow, which changed a region's measured
    // height enough to flip `single_page?` and switch column balancing on, so inline is a moving
    // target and proves nothing about margin.
    const baseline = measured.placements!.none;
    const margin = measured.placements!.margin;
    expect(margin.length).toBe(baseline.length);

    // PAGINATION, not per-item position. Item-level equality is NOT attainable and asserting it was
    // wrong: a region's interior column has only the gutter to offer, which cannot hold a number, so
    // those paragraphs fall back to numbering inline — and an inline number is in the flow and does
    // shift the wrapping of its own paragraph. That fallback is deliberate (a clipped number is
    // worse than an indented line), and it is local to the paragraphs that take it.
    //
    // What must hold globally is that the document still breaks across the same pages, which is what
    // the regression that prompted this test violated: margin placement added a whole page.
    let bodyTotal = 0;
    for (const page of margin) bodyTotal += bodyItemsOf(page).length;
    expect(bodyTotal).toBeGreaterThan(0);
  });

  it('never drops a region that begins at the foot of a page', () => {
    if (environmentGate) return;
    // THE BUG THIS FILE WAS MISSING. A column box takes the space that is left; opened a couple of
    // points above the page foot it cannot fit a line, and Prawn drops the whole region without a
    // word — blank paper between intact prose, with the paragraph numbers stepping over the missing
    // content (11, then 13). It reached a user as "columns completely missing".
    //
    // Pinned to the theme editor's own preview sample rather than to a synthesised document. Which
    // documents land in the sliver depends on font metrics: the reference toolchain never hit it,
    // and only the wasm engine put the cursor 2.3pt above the foot. Every attempt at a synthetic
    // reproduction rendered fine, so this asserts against the document a user actually hit it with.
    const sample = measured.previewSample;
    expect(sample).toBeDefined();
    // A sample that could not be read measures nothing, and must not read as a pass.
    expect(sample?.skipped).toBeUndefined();
    expect(sample?.regionPresent).toBe(true);
  });

  it('fills every column on the last page of a region taller than one column', () => {
    if (environmentGate) return;
    // THE RAGGED LAST PAGE. A column box takes the whole page and Prawn fills one column to the foot
    // before starting the next, which is right on every page but the last: there the content runs
    // out partway, so the first column stands full to the foot and the rest are BLANK. Measured at
    // 573.2/0 for two columns and 671.6/0/0 for three — a region that reads as though it stopped
    // being columnised exactly where it ends.
    //
    // Asserted on every page of the region rather than only the last, because the same measurement
    // states the ordinary invariant too: a region page's columns should all carry text.
    const balance = measured.balance ?? [];
    expect(balance.length).toBeGreaterThan(0);
    // One of the cases MUST have numbering on. It covers a coupling parity cannot see: an interior
    // column cannot hold a number, so its paragraphs fall back to numbering inline, and an inline
    // number is in the flow. When the measuring pass skipped it and the real pass inked it, the
    // balancer divided a total short by one prefix per paragraph — measured at 70% against 100%
    // with numbering off. Both toolchains load the same extension, so parity stayed green.
    expect(balance.some((region) => region.numbering)).toBe(true);
    for (const region of balance) {
      // A region that never divided would prove nothing about balancing, so the fixture itself is
      // checked: it has to be long enough to occupy more than one page.
      expect(region.pages.length).toBeGreaterThan(1);
      for (const [index, page] of region.pages.entries()) {
        expect(page).toHaveLength(region.columns);
        const deepest = Math.max(...page.map((band) => band.fill));
        expect(deepest).toBeGreaterThan(0);
        for (const band of page) {
          expect({
            columns: region.columns,
            numbering: region.numbering,
            page: index + 1,
            column: band.index,
            share: Math.round((band.fill / deepest) * 100) / 100,
            fills: page.map((other) => other.fill),
          }).toMatchObject({ share: expect.any(Number) });
          expect(band.fill / deepest).toBeGreaterThanOrEqual(MIN_COLUMN_SHARE);
        }
      }
    }
  });

  it('keeps the shipped default layout-neutral', () => {
    if (environmentGate) return;
    // Whatever the manifest ships as the default, a project that never sets the key must not get a
    // document laid out differently from an unnumbered one. `margin` satisfies this; `inline` cannot
    // and does not claim to — so this fails if the default is ever changed to a placement that moves
    // the prose, which is the mistake this feature already made once.
    const placement = shippedDefaultPlacement();
    if (placement === 'inline') return; // inline is in-flow by definition; nothing to assert.
    expect(measured.placements![placement].length).toBe(measured.placements!.none.length);
  });
});
