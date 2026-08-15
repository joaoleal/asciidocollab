/**
 * @file The rule a block is framed with, and the category a verse takes its own from.
 *
 * TWO defects that look unrelated and are the same shape: a value read out of the wrong place, and a
 * mark drawn in the wrong model.
 *
 * THE FRAME. `theme_fill_and_stroke_block` fills a block's bounds and then strokes them
 * (`extensions.rb:741-776`), and every edge is a `stroke_horizontal_rule`/`stroke_vertical_rule`
 * centred ON the boundary — half of it outside the block, none of it inside. `pad_box
 * <category>_padding` (`extensions.rb:585-608`) then measures the padding from that same boundary. So
 * the rule costs the block no height, no measure, and none of the inset to its text. A CSS border
 * costs it all three, and every framed block in the preview was one rule-width taller with its text
 * one rule-width further in: on this fixture's theme, a listing 37.73pt tall against the page's
 * 34.74, a sidebar 46.36 against 43.36, an example 38.86 against 37.36.
 *
 * THE VERSE. `convert_quote_or_verse` reads its category off the node — `node.context == :quote ?
 * :quote : :verse` (`converter.rb:1310`) — and the gem's own default theme gives `verse` defaults
 * spelled `$quote_font_size`, `$quote_border_color`, `$quote_padding` and so on
 * (`data/themes/default-theme.yml:153-161`). A `$reference` is expanded WHEN THE ENTRY IS READ, so
 * those resolve against the DEFAULT theme's quote as that file loads and are literals by the time a
 * project's theme is layered on top: restyling `quote` restyles quotations and leaves verses exactly
 * where the renderer's own defaults put them. The preview read a verse out of the quote group, so a
 * project that themed its quotations restyled a block the export does not restyle.
 *
 * WHY THIS THEME LOOKS LIKE IT DOES, AND WHAT IT CANNOT SEPARATE. The renderer themes a frame by
 * CATEGORY rather than by block, and this fixture's four framed blocks are three categories: `code`
 * — which is the listing AND the literal — plus `sidebar` and `example`. Read out of the reference's
 * operator stream, the widths and colours it strokes are:
 *
 *   listing  1.5pt = 2.0000 CSS px  #884400   ┐ one `code` category, drawn twice
 *   literal  1.5pt = 2.0000 CSS px  #884400   ┘
 *   sidebar  2.0pt = 2.6667 CSS px  #008844
 *   example  0.5pt = 0.6667 CSS px  #AA0088
 *   quote    3.0pt = 4.0000 CSS px  #1A4E8A   (the left rule, not a frame)
 *   verse    4.0pt = 5.3333 CSS px  #EEEEEE   (ditto, and from the DEFAULT theme)
 *
 * So the claim that used to stand here — that every rule is a width no whole CSS pixel expresses and
 * that no two are the same — is false twice over: 1.5pt and 3pt are exactly 2 and exactly 4 CSS
 * pixels, and the listing and the literal share one width, one colour and one category. What the
 * theme really buys is narrower and still enough. Three distinct frame widths over four blocks, two
 * of them (2.6667 and 0.6667) widths no whole CSS pixel expresses — a frame drawn as a border is
 * floored to a whole pixel and never below one, so it would draw the sidebar's at 2 and the example's
 * at 1, and neither could then agree with the page. And one colour per category, all five different,
 * so a block drawn from a category it does not belong to is a block in visibly the wrong ink.
 *
 * What this file therefore CANNOT separate is the listing from the literal. They are indistinguishable
 * here because they are indistinguishable in the renderer — one category read twice — so a preview
 * that drew a listing out of `literal.*` would pass everything below, and correctly. Every other pair
 * differs in width, in colour, or in both.
 *
 * And every `quote` value is set as far from the renderer's own default as it will go, so that a verse
 * showing any of them is a verse read from the wrong category.
 *
 * WHAT THE REFERENCE SUPPLIES. Every number compared against is read out of the committed reference
 * PDF at run time: the box each block is filled over, the colour and width each edge is stroked at,
 * and the size, colour and position of every run. Nothing here restates a theme value or an engine
 * constant, and each claim asserts what the REFERENCE says before asking whether the preview agrees.
 */

import { readFileSync } from 'node:fs';
import path from 'node:path';
import { chromium, expect, test, type Page } from '@playwright/test';
import {
  PRINT_FIDELITY_TOLERANCE,
  drawnRuns,
  paintedBoxes,
  sameColour,
  strokedPaths,
  textRuns,
  type PaintedBox,
  type Rgb,
  type StrokedPath,
} from '../harness/pdftools';
import { PIXELS_PER_POINT, preparePrintPage, readFixture } from './harness';

/** The fixture this file is about. */
const FIXTURE = 'block-frames';

const fixture = readFixture(FIXTURE);

/** The quotation's first line, which is how its block is found on both sides. */
const QUOTE_LINE = 'a quotation long enough that it has to break somewhere too, which is the same';

/** One shadow of a computed `box-shadow`, in points. */
interface Shadow {
  /** The colour it is painted in. */
  readonly colour: Rgb;
  /** Horizontal offset in points. */
  readonly offsetXPt: number;
  /** Spread in points. */
  readonly spreadPt: number;
  /** Whether it is painted inside the box. */
  readonly inset: boolean;
}

/**
 * The shadows one element is drawn with.
 *
 * The preview draws every block rule as a shadow rather than as a border, because a border is floored
 * to a whole CSS pixel and occupies room in the box; the note in the stylesheet says why. So the
 * shadow list is where the preview's answer to "how wide is this rule, and what colour" lives, and
 * this reads it back the way the browser resolved it — a declaration, compared against the
 * declaration the PDF's operator stream carries, which is the same measurement on both sides.
 *
 * @param page - The browser page.
 * @param selector - A selector inside the page column; the first match is read.
 * @returns One entry per shadow, in the order they are painted.
 */
async function shadowsOf(page: Page, selector: string): Promise<Shadow[]> {
  return page.evaluate(
    ({ css, perPoint }) => {
      const element = document.querySelector(`[data-testid="page"] ${css}`);
      if (element === null) throw new Error(`the preview has no ${css}`);
      const value = getComputedStyle(element).boxShadow;
      if (value === 'none') return [];
      const shadows: Shadow[] = [];
      // One shadow is a colour, two to four lengths, and optionally `inset`. Matched as a whole
      // rather than split on commas, because the colour carries commas of its own.
      for (const match of value.matchAll(
        /(rgba?\([^)]*\))((?:\s+-?[\d.]+px){2,4})(\s+inset)?/g,
      )) {
        const channels = /rgba?\(\s*([\d.]+)[,\s]+([\d.]+)[,\s]+([\d.]+)(?:[,/\s]+([\d.]+))?/.exec(match[1]);
        if (channels === null) continue;
        // A shadow painted in a fully transparent colour is a rule the preview does not draw. Read
        // with the alpha discarded it came back as a rule drawn in BLACK, which is the same misreading
        // `colourOf` made of `rgba(0, 0, 0, 0)` in the harness: an absent mark reported as a present
        // one, and a pass wherever the reference's own rule happens to be black. Skipped instead, so
        // the count below says "the preview draws no left rule" — which is what happened.
        if (channels[4] !== undefined && Number(channels[4]) === 0) continue;
        const lengths = match[2].trim().split(/\s+/).map((length) => Number.parseFloat(length) / perPoint);
        shadows.push({
          colour: [Number(channels[1]), Number(channels[2]), Number(channels[3])],
          offsetXPt: lengths[0] ?? 0,
          spreadPt: lengths[3] ?? 0,
          inset: match[3] !== undefined,
        });
      }
      return shadows;
    },
    { css: selector, perPoint: PIXELS_PER_POINT },
  );
}

/** One element's box, in points from the top left of the page column. */
interface PreviewBox {
  /** Left edge. */
  readonly leftPt: number;
  /** Width of the border box. */
  readonly widthPt: number;
  /** Height of the border box. */
  readonly heightPt: number;
}

/** The border box of the first element matching `selector`. */
async function previewBox(page: Page, selector: string): Promise<PreviewBox> {
  return page.evaluate(
    ({ css, perPoint }) => {
      const root = document.querySelector('[data-testid="page"]');
      const element = document.querySelector(`[data-testid="page"] ${css}`);
      if (!(root instanceof HTMLElement) || element === null) throw new Error(`the preview has no ${css}`);
      const origin = root.getBoundingClientRect();
      const box = element.getBoundingClientRect();
      return {
        leftPt: (box.left - origin.left) / perPoint,
        widthPt: box.width / perPoint,
        heightPt: box.height / perPoint,
      };
    },
    { css: selector, perPoint: PIXELS_PER_POINT },
  );
}

/** The laid-out lines of the first element matching `selector`, as left and right edges in points. */
async function previewLines(page: Page, selector: string): Promise<{ leftPt: number; rightPt: number }[]> {
  return page.evaluate(
    ({ css, perPoint }) => {
      const root = document.querySelector('[data-testid="page"]');
      const element = document.querySelector(`[data-testid="page"] ${css}`);
      if (!(root instanceof HTMLElement) || element === null) throw new Error(`the preview has no ${css}`);
      const origin = root.getBoundingClientRect();
      const range = document.createRange();
      range.selectNodeContents(element);
      const rectangles = [...range.getClientRects()]
        .filter((rect) => rect.height > 0 && rect.width > 0)
        .map((rect) => ({
          leftPt: (rect.left - origin.left) / perPoint,
          rightPt: (rect.right - origin.left) / perPoint,
          top: rect.top,
        }))
        .toSorted((a, b) => a.top - b.top || a.leftPt - b.leftPt);
      const lines: { leftPt: number; rightPt: number; top: number }[] = [];
      for (const rectangle of rectangles) {
        const current = lines.at(-1);
        if (current === undefined || rectangle.top - current.top > 1) lines.push({ ...rectangle });
        else {
          current.leftPt = Math.min(current.leftPt, rectangle.leftPt);
          current.rightPt = Math.max(current.rightPt, rectangle.rightPt);
        }
      }
      return lines.map(({ leftPt, rightPt }) => ({ leftPt, rightPt }));
    },
    { css: selector, perPoint: PIXELS_PER_POINT },
  );
}

/**
 * The laid-out lines of `selector`, measured to the last INKED character of each.
 *
 * The rectangle a range reports is not where the ink ends. A verse is set in `white-space: pre-wrap`,
 * which preserves the space a soft wrap breaks at and lets it hang past the last glyph; prawn drops
 * that space, so its run stops at the glyph. Comparing the two directly makes every wrapped line of
 * every verse read three and a half points too wide — a difference in what was measured rather than
 * in how the block was set, and one that would have to be explained away as a tolerance.
 *
 * So each character is measured on its own and the line's far edge is taken from the last one that is
 * not whitespace, which is the same edge the reference reports.
 *
 * @param page - The browser page.
 * @param selector - A selector inside the page column; the first match is measured.
 * @returns One entry per laid-out line, top to bottom.
 */
async function previewInkedLines(page: Page, selector: string): Promise<{ leftPt: number; rightPt: number }[]> {
  return page.evaluate(
    ({ css, perPoint }) => {
      const root = document.querySelector('[data-testid="page"]');
      const element = document.querySelector(`[data-testid="page"] ${css}`);
      if (!(root instanceof HTMLElement) || element === null) throw new Error(`the preview has no ${css}`);
      const origin = root.getBoundingClientRect();
      const walker = document.createTreeWalker(element, NodeFilter.SHOW_TEXT);
      const lines: { leftPt: number; rightPt: number; top: number }[] = [];
      for (let node = walker.nextNode(); node !== null; node = walker.nextNode()) {
        const text = node.textContent ?? '';
        // Indices rather than characters, because a `Range` offset is a UTF-16 offset: iterating the
        // string itself would step by code point and put every offset after an astral character on
        // the wrong side of it.
        for (const index of Array.from({ length: text.length }, (_, at) => at)) {
          if (text[index].trim() === '') continue;
          const range = document.createRange();
          range.setStart(node, index);
          range.setEnd(node, index + 1);
          const rect = range.getBoundingClientRect();
          if (rect.height === 0) continue;
          const current = lines.at(-1);
          const leftPt = (rect.left - origin.left) / perPoint;
          const rightPt = (rect.right - origin.left) / perPoint;
          if (current === undefined || Math.abs(rect.top - current.top) > 1) {
            lines.push({ leftPt, rightPt, top: rect.top });
          } else {
            current.leftPt = Math.min(current.leftPt, leftPt);
            current.rightPt = Math.max(current.rightPt, rightPt);
          }
        }
      }
      return lines
        .toSorted((a, b) => a.top - b.top)
        .map(({ leftPt, rightPt }) => ({ leftPt, rightPt }));
    },
    { css: selector, perPoint: PIXELS_PER_POINT },
  );
}

/**
 * Assert that the preview and the reference report one quantity as the same number.
 *
 * @param what - What is being compared, for the failure message.
 * @param preview - The preview's measurement, in points.
 * @param reference - The reference's, in points.
 * @param tolerancePt - How far apart they may be; the suite's shared geometry tolerance by default,
 *   which is sized for a comparison against a rasterised page and is far too wide for one between two
 *   declarations.
 */
function agree(
  what: string,
  preview: number,
  reference: number,
  tolerancePt = PRINT_FIDELITY_TOLERANCE.geometryPt,
): void {
  expect(
    Math.abs(preview - reference),
    `${what}: preview ${preview.toFixed(3)}pt, reference ${reference.toFixed(3)}pt`,
  ).toBeLessThanOrEqual(tolerancePt);
}

/**
 * How far the preview's declared rule width may sit from the reference's, in points.
 *
 * NOT the suite's geometry tolerance. That one is half a point and is sized for a comparison against
 * a page a rasteriser made; both sides of this comparison are DECLARATIONS — the theme's width
 * projected into a custom property and resolved as a `box-shadow` spread, against the `w` operand in
 * the reference's operator stream — so they agree to the arithmetic and to nothing else.
 *
 * At half a point this comparison could not fail for the thinnest frame the fixture's theme draws:
 * `example.border-width` is 0.5, so a `box-shadow` with NO SPREAD AT ALL — a block the preview leaves
 * unruled — sat exactly on the tolerance and passed. Measured, the four frames agree to 2.5e-5pt (the
 * residue of the point→pixel→point round trip through the computed style), so a thousandth of a point
 * leaves three orders of magnitude of headroom over the instrument and is still an order of magnitude
 * under the thinnest rule anything here draws.
 *
 * EVERY comparison of this shape takes it, and the LEFT rule beside a verse and a quotation is one:
 * the inset shadow's own offset against the `w` operand the reference strokes with, two declarations
 * again. It took the half-point default instead, and the reference draws those two rules at 4pt and
 * 3pt — so a preview that set the verse's rule to 3.5pt, half a point from the QUOTATION'S width and
 * a 12.5 per cent error, passed there while failing by five hundred times over here. Measured, those
 * two agree to under 3e-5pt, the same round-trip residue as the four frames.
 */
const RULE_WIDTH_TOLERANCE_PT = 0.001;

/**
 * How far the preview's BOX may sit from the rectangle the reference painted, in points.
 *
 * The same argument as {@link RULE_WIDTH_TOLERANCE_PT}, carried to the comparisons it was not
 * carried to when it was written. A block's height, its width, its left edge and the inset to its
 * first line are all measured on both sides as positions rather than as marks: the reference's come
 * out of the operator stream, the preview's out of `getBoundingClientRect`, and the only thing
 * between them is Chromium's layout unit — a sixty-fourth of a CSS pixel, or 0.0117pt. Measured
 * across the fixture's five framed blocks, a verse and a quotation, the widest of these twenty-one
 * comparisons is 0.0134pt and most are under 0.009.
 *
 * At the suite's half-point geometry default they could not fail for the defect they exist to catch.
 * `frames-theme.yml` sets `example.border-width: 0.5`, and the renderer strokes that rule ON the
 * block's own edge while a CSS border sits outside the padding — so a block drawn with a border
 * instead of a shadow is exactly one rule width too wide, too tall and too far inset, which lands
 * exactly on `toBeLessThanOrEqual(0.5)` and passes. Five hundredths of a point is four times the
 * instrument's own spread and a tenth of the thinnest defect it has to see.
 *
 * NOT for the line-ending comparisons beside them. Where a justified line ends is decided by glyph
 * advances and by how each engine spends its word spacing; those agree to 0.31pt on this fixture and
 * keep the geometry default, which is what it is sized for.
 */
const BOX_TOLERANCE_PT = 0.05;

/** How far apart the widest and the narrowest of a set of measurements are. */
function spread(values: readonly number[]): number {
  return Math.max(...values) - Math.min(...values);
}

/** The right edges of every line but the last, which no alignment stretches. */
function fullLineRights(lines: readonly { rightPt: number }[]): number[] {
  return lines.slice(0, -1).map((line) => line.rightPt);
}

/** The one element of `items`, failing loudly when the reference does not hold exactly one. */
function only<T>(items: readonly T[], what: string): T {
  expect(items, what).toHaveLength(1);
  return items[0];
}

/** Where the run whose text is exactly `text` sits, from the reference's text layer. */
async function referenceRun(text: string): Promise<{ page: number; leftPt: number; baselinePt: number }> {
  const all = await textRuns(fixture.referencePdf);
  const run = only(
    all.filter((candidate) => candidate.text.trim() === text),
    `the reference has exactly one run reading "${text}"`,
  );
  return { page: run.page, leftPt: run.xPt, baselinePt: run.yPt };
}

/** The first laid-out line of the first element matching `selector`. */
async function previewFirstLine(page: Page, selector: string): Promise<{ leftPt: number; rightPt: number }> {
  const lines = await previewLines(page, selector);
  expect(lines.length, `the preview lays out ${selector}`).toBeGreaterThan(0);
  return lines[0];
}

/**
 * The vertical rule the reference strokes beside the block that holds one run of text.
 *
 * A `stroke_vertical_rule` is a degenerate box — a path whose two x coordinates are the same — and
 * the one that spans a given baseline is the rule beside that baseline's block.
 *
 * @param text - The exact text of a run inside the block.
 * @returns The stroke, with the width and colour the export drew it at.
 */
async function referenceRuleBeside(text: string): Promise<StrokedPath> {
  const at = await referenceRun(text);
  const strokes = await strokedPaths(fixture.referencePdf);
  const found = strokes.filter(
    (stroke) =>
      stroke.page === at.page &&
      Math.abs(stroke.rightPt - stroke.leftPt) < 0.01 &&
      stroke.bottomPt < at.baselinePt &&
      stroke.topPt > at.baselinePt,
  );
  expect(found, 'the reference strokes exactly one rule beside this block').toHaveLength(1);
  return found[0];
}

test.describe('a verse is set from the verse category, not the quotation’s', () => {
  test('its size is the one the export draws it at, which the project’s quote does not change', async ({
    page,
  }) => {
    const drawn = await drawnRuns(fixture.referencePdf);
    const verse = drawn.find((run) => run.text.trim() === 'verse-first-line');
    const quote = drawn.find((run) => run.text.trim().startsWith('a quotation long enough'));
    expect(verse, 'the reference draws the verse').toBeDefined();
    expect(quote, 'the reference draws the quotation').toBeDefined();
    if (verse === undefined || quote === undefined) return;
    // The reference's own statement of the case: this theme sets `quote.font-size` and the two blocks
    // come out at DIFFERENT sizes, because only one of them reads that key.
    expect(verse.fontSizePt).not.toBe(quote.fontSizePt);

    await preparePrintPage(page, fixture);
    const sizes = await page.evaluate(() =>
      ['.verseblock', '.quoteblock'].map((selector) => {
        const element = document.querySelector(`[data-testid="page"] ${selector}`);
        if (element === null) throw new Error(`the preview has no ${selector}`);
        return Number.parseFloat(getComputedStyle(element).fontSize) / (96 / 72);
      }),
    );
    agree('the verse’s size', sizes[0], verse.fontSizePt);
    agree('the quotation’s size', sizes[1], quote.fontSizePt);
  });

  test('its rule is the verse category’s rule, at that width and in that colour', async ({ page }) => {
    const verseRule = await referenceRuleBeside('verse-first-line');
    const quoteRule = await referenceRuleBeside(QUOTE_LINE);
    // The reference's own statement: the two rules are different widths in different colours, so a
    // verse drawn from the quote group cannot pass by drawing the right thing for the wrong reason.
    expect(verseRule.lineWidthPt).not.toBe(quoteRule.lineWidthPt);
    expect(sameColour(verseRule.colour, quoteRule.colour)).toBe(false);

    await preparePrintPage(page, fixture);
    for (const [what, selector, rule] of [
      ['verse', '.verseblock', verseRule],
      ['quotation', '.quoteblock', quoteRule],
    ] as const) {
      const shadows = await shadowsOf(page, selector);
      // The left rule is the inset shadow offset sideways: the strip it paints runs from the block's
      // own left edge to the left edge of the hole the shadow cuts, because the renderer draws the
      // rule from that edge inwards. That hole's left edge is the OFFSET reduced by the spread — the
      // stylesheet asks for the hole a whole overhang wider on every side, so that its top and bottom
      // edges fall outside the block instead of on it, and carries the same overhang in the offset;
      // the note there says what the coincident edges left behind.
      const bar = shadows.filter((shadow) => shadow.inset && shadow.offsetXPt > 0);
      expect(bar, `the preview draws one left rule on the ${what}`).toHaveLength(1);
      agree(
        `the ${what}’s rule width`,
        bar[0].offsetXPt + bar[0].spreadPt,
        rule.lineWidthPt,
        RULE_WIDTH_TOLERANCE_PT,
      );
      expect(
        sameColour(bar[0].colour, rule.colour),
        `the ${what}’s rule is rgb(${rule.colour.join(', ')}), preview rgb(${bar[0].colour.join(', ')})`,
      ).toBe(true);
      // And it starts at the block's own left edge: the reference's degenerate box is the line's
      // centre, so its left edge is half a width to the left of it.
      const box = await previewBox(page, selector);
      agree(`the ${what}’s rule left edge`, box.leftPt, rule.leftPt - rule.lineWidthPt / 2, BOX_TOLERANCE_PT);
    }
  });

  test('its text is inset by the verse padding and its block is as tall as the page’s', async ({ page }) => {
    const verseLine = await referenceRun('verse-first-line');
    const quoteLine = await referenceRun(QUOTE_LINE);
    // The two paddings differ under this theme, which is what makes the inset a statement about which
    // category was read rather than about arithmetic both would agree on.
    expect(verseLine.leftPt).not.toBe(quoteLine.leftPt);
    const strokes = await strokedPaths(fixture.referencePdf);
    const verseRule = only(
      strokes.filter(
        (stroke) =>
          stroke.page === verseLine.page &&
          Math.abs(stroke.rightPt - stroke.leftPt) < 0.01 &&
          stroke.bottomPt < verseLine.baselinePt &&
          stroke.topPt > verseLine.baselinePt,
      ),
      'the reference strokes one rule beside the verse',
    );

    await preparePrintPage(page, fixture);
    const versePre = await previewFirstLine(page, '.verseblock > pre');
    const quoteParagraph = await previewFirstLine(page, '.quoteblock p');
    agree('the verse’s text inset', versePre.leftPt, verseLine.leftPt, BOX_TOLERANCE_PT);
    agree('the quotation’s text inset', quoteParagraph.leftPt, quoteLine.leftPt, BOX_TOLERANCE_PT);
    // The rule runs the whole height of the block — `bounding_box … height: b_height` — so the height
    // it was stroked over IS the block's own extent.
    const verseBox = await previewBox(page, '.verseblock');
    agree('the verse block’s height', verseBox.heightPt, verseRule.topPt - verseRule.bottomPt, BOX_TOLERANCE_PT);
  });

  test('it is set flush left where the quotation beside it is set at the page’s alignment', async ({
    page,
  }) => {
    const allRuns = await textRuns(fixture.referencePdf);
    const runs = allRuns.filter((run) => run.text.trim() !== '');
    const linesFrom = (firstLine: string, leftPt: number): { rightPt: number }[] => {
      const first = runs.find((run) => run.text.trim().startsWith(firstLine));
      expect(first, `the reference draws "${firstLine}"`).toBeDefined();
      if (first === undefined) return [];
      return runs
        .filter(
          (run) =>
            run.page === first.page &&
            Math.abs(run.xPt - leftPt) < 0.1 &&
            run.yPt <= first.yPt &&
            // Deep enough to reach the quotation's THIRD full line: two of them are what a common
            // right edge is measured over, and sixty points reached only two lines in all.
            run.yPt > first.yPt - 90 &&
            // The attribution sits in the same column and would otherwise read as one more line of
            // the block above it — a line set at a different size, in a different alignment, and
            // never stretched. `ink_prose %(#{EmDash} …)` is what puts the dash at the front of it.
            !run.text.trim().startsWith('—'),
        )
        .toSorted((a, b) => b.yPt - a.yPt)
        .map((run) => ({ rightPt: run.xPt + run.widthPt }));
    };
    const verseFirst = await referenceRun('verse-first-line');
    const quoteFirst = await referenceRun(
      'a quotation long enough that it has to break somewhere too, which is the same',
    );
    const verseLines = linesFrom('verse-first-line', verseFirst.leftPt);
    const quoteLines = linesFrom('a quotation long enough', quoteFirst.leftPt);
    expect(verseLines.length, 'the reference sets the verse on several lines').toBeGreaterThan(2);
    expect(quoteLines.length, 'the reference sets the quotation on several lines').toBeGreaterThan(1);
    // `spread` over ONE number is zero, so "justified" would be true of any block the reference set
    // over two lines — which is what the quotation used to be, and what made the second half of this
    // premise a guaranteed pass. Two full lines is the least that can witness a common right edge,
    // and the fixture's quotation is written to run to three.
    expect(
      fullLineRights(quoteLines).length,
      'the reference sets the quotation over enough FULL lines that a common right edge means something',
    ).toBeGreaterThan(1);
    expect(
      fullLineRights(verseLines).length,
      'and the verse over enough that a ragged one does',
    ).toBeGreaterThan(1);
    // `ink_prose … align: (resolve_text_align_from_role node.roles) || :left` for a verse against
    // `convert_paragraph` at `@base_text_align` for a quotation: the reference says so plainly, with
    // the verse's full lines ending short of the measure and the quotation's stretched to it.
    expect(spread(fullLineRights(verseLines)), 'the reference leaves the verse ragged').toBeGreaterThan(1);
    expect(
      spread(fullLineRights(quoteLines)),
      'and justifies the quotation',
    ).toBeLessThan(PRINT_FIDELITY_TOLERANCE.geometryPt);

    await preparePrintPage(page, fixture);
    // Where each line ENDS, against where the reference ends it, rather than the raggedness alone: a
    // block set at the wrong alignment is still ragged on the lines a hard break ends, so a shape
    // comparison passes on a verse the browser justified. The far edge of each line is the number
    // the alignment actually decides.
    const previewVerse = await previewInkedLines(page, '.verseblock > pre');
    const previewQuote = await previewInkedLines(page, '.quoteblock p');
    expect(previewVerse, 'the preview breaks the verse where the reference breaks it').toHaveLength(
      verseLines.length,
    );
    expect(previewQuote, 'and the quotation where it breaks that').toHaveLength(quoteLines.length);
    for (const [index, reference] of verseLines.entries()) {
      agree(`where line ${String(index + 1)} of the verse ends`, previewVerse[index].rightPt, reference.rightPt);
    }
    for (const [index, reference] of quoteLines.entries()) {
      agree(`where line ${String(index + 1)} of the quotation ends`, previewQuote[index].rightPt, reference.rightPt);
    }
  });

  test('its attribution takes the verse cite’s size and colour', async ({ page }) => {
    const drawn = await drawnRuns(fixture.referencePdf);
    const verseCite = drawn.find((run) => run.text.trim().startsWith('— Carl Sandburg'));
    const quoteCite = drawn.find((run) => run.text.trim().startsWith('— Ada Lovelace'));
    expect(verseCite, 'the reference draws the verse’s attribution').toBeDefined();
    expect(quoteCite, 'the reference draws the quotation’s').toBeDefined();
    if (verseCite === undefined || quoteCite === undefined) return;
    // Again the reference's own statement: this theme sets `quote.cite`, and the two attributions come
    // out at different sizes in different colours.
    expect(verseCite.fontSizePt).not.toBe(quoteCite.fontSizePt);
    expect(sameColour(verseCite.colour, quoteCite.colour)).toBe(false);

    await preparePrintPage(page, fixture);
    for (const [what, selector, reference] of [
      ['verse', '.verseblock .attribution', verseCite],
      ['quotation', '.quoteblock .attribution', quoteCite],
    ] as const) {
      const measured = await page.evaluate((css) => {
        const element = document.querySelector(`[data-testid="page"] ${css}`);
        if (element === null) throw new Error(`the preview has no ${css}`);
        const style = getComputedStyle(element);
        const channels = /rgba?\(\s*([\d.]+)[,\s]+([\d.]+)[,\s]+([\d.]+)(?:[,/\s]+([\d.]+))?/.exec(style.color);
        if (channels === null) throw new Error(`unreadable colour ${style.color}`);
        // Text set in a fully transparent colour is text the reader cannot see, and reading it with
        // the alpha discarded reports it as BLACK — which passes wherever the reference's own run is
        // black, and one of this fixture's two attributions could be. The harness's `colourOf` throws
        // on the same value for the same reason; this one cannot call it, being run in the page.
        if (channels[4] !== undefined && Number(channels[4]) === 0) {
          throw new Error(`${css} is set in ${style.color}, which paints nothing`);
        }
        return {
          sizePt: Number.parseFloat(style.fontSize) / (96 / 72),
          colour: [Number(channels[1]), Number(channels[2]), Number(channels[3])] as Rgb,
        };
      }, selector);
      agree(`the ${what}’s attribution size`, measured.sizePt, reference.fontSizePt);
      expect(
        sameColour(measured.colour, reference.colour),
        `the ${what}’s attribution is rgb(${reference.colour.join(', ')}), preview rgb(${measured.colour.join(', ')})`,
      ).toBe(true);
    }
  });
});

/** The framed blocks this fixture carries: what the preview draws each with, and its one line of text. */
const FRAMED = [
  { what: 'listing', selector: '.listingblock > .content > pre', text: 'listing-only-line' },
  { what: 'literal', selector: '.literalblock > .content > pre', text: 'literal-only-line' },
  { what: 'sidebar', selector: '.sidebarblock', text: 'sidebar-only-line' },
  { what: 'example', selector: '.exampleblock > .content', text: 'example-only-line' },
] as const;

test.describe('a framed block’s rule costs it neither height nor measure nor inset', () => {
  test('every one of them is the box the renderer laid out, with its text where the padding puts it', async ({
    page,
  }) => {
    const painted = await paintedBoxes(fixture.referencePdf);
    const boxes = painted.filter((box) => box.filled);
    const strokes = await strokedPaths(fixture.referencePdf);
    /** The block the renderer filled around one baseline. */
    const fillAround = (at: { page: number; baselinePt: number }): PaintedBox =>
      only(
        boxes.filter((box) => box.page === at.page && box.bottomPt < at.baselinePt && box.topPt > at.baselinePt),
        'the reference fills exactly one block around this line',
      );

    await preparePrintPage(page, fixture);
    for (const block of FRAMED) {
      const run = await referenceRun(block.text);
      const fill = fillAround(run);
      const stroke = only(
        strokes.filter(
          (candidate) =>
            candidate.page === fill.page &&
            Math.abs(candidate.leftPt - fill.leftPt) < 0.01 &&
            Math.abs(candidate.topPt - fill.topPt) < 0.01,
        ),
        `the reference strokes the ${block.what}’s frame once`,
      );
      // The reference's own statement of the mechanism: the stroked rectangle and the filled one are
      // the SAME rectangle. The rule is centred on the fill's edge rather than laid inside or outside
      // it, which is exactly why it costs the block nothing.
      expect(stroke.rightPt - stroke.leftPt).toBeCloseTo(fill.widthPt, 2);
      expect(stroke.topPt - stroke.bottomPt).toBeCloseTo(fill.heightPt, 2);

      const box = await previewBox(page, block.selector);
      const firstLine = await previewFirstLine(page, block.selector);
      agree(`the ${block.what}’s height`, box.heightPt, fill.heightPt, BOX_TOLERANCE_PT);
      agree(`the ${block.what}’s width`, box.widthPt, fill.widthPt, BOX_TOLERANCE_PT);
      agree(`the ${block.what}’s left edge`, box.leftPt, fill.leftPt, BOX_TOLERANCE_PT);
      agree(
        `the inset to the ${block.what}’s text`,
        firstLine.leftPt - box.leftPt,
        run.leftPt - fill.leftPt,
        BOX_TOLERANCE_PT,
      );
    }
  });

  test('every one of them draws its rule at the width and in the colour the export strokes', async ({
    page,
  }) => {
    const painted = await paintedBoxes(fixture.referencePdf);
    const boxes = painted.filter((box) => box.filled);
    const strokes = await strokedPaths(fixture.referencePdf);
    const widths: number[] = [];

    await preparePrintPage(page, fixture);
    for (const block of FRAMED) {
      const run = await referenceRun(block.text);
      const fill = only(
        boxes.filter((box) => box.page === run.page && box.bottomPt < run.baselinePt && box.topPt > run.baselinePt),
        `the reference fills the ${block.what}`,
      );
      const stroke = only(
        strokes.filter(
          (candidate) =>
            candidate.page === fill.page &&
            Math.abs(candidate.leftPt - fill.leftPt) < 0.01 &&
            Math.abs(candidate.topPt - fill.topPt) < 0.01,
        ),
        `the reference strokes the ${block.what}’s frame once`,
      );
      widths.push(stroke.lineWidthPt);

      const shadows = await shadowsOf(page, block.selector);
      // The ring: one shadow outside the box and one inside, each spreading half the rule, which is
      // where a stroke centred on the boundary lands. Its width is therefore twice the spread.
      const ring = shadows.filter((shadow) => shadow.offsetXPt === 0);
      expect(ring, `the preview draws the ${block.what}’s frame as a ring of two`).toHaveLength(2);
      expect(ring.filter((shadow) => shadow.inset), `one of them inside the ${block.what}`).toHaveLength(1);
      for (const half of ring) {
        agree(
          `the ${block.what}’s rule width`,
          half.spreadPt * 2,
          stroke.lineWidthPt,
          RULE_WIDTH_TOLERANCE_PT,
        );
        expect(
          sameColour(half.colour, stroke.colour),
          `the ${block.what}’s rule is rgb(${stroke.colour.join(', ')}), preview rgb(${half.colour.join(', ')})`,
        ).toBe(true);
      }
    }

    // Not a claim about the preview, but about whether the four above could agree by coincidence.
    // THREE distinct widths over four blocks, not four: the listing and the literal are one `code`
    // category and the reference strokes both at 1.5pt, so no fixture and no theme can make those two
    // differ — see the file header. Measured: 2.0000, 2.0000, 2.6667 and 0.6667 CSS px.
    expect(
      new Set(widths).size,
      'the reference strokes the three categories behind these four frames at three different widths',
    ).toBe(3);
    expect(
      widths.some((width) => Math.abs((width * 96) / 72 - Math.round((width * 96) / 72)) > 0.1),
      'and at least one of them is a width no whole CSS pixel expresses, which is what a border could ' +
        'not have drawn: the sidebar asks for 2.6667px and the example for 0.6667px',
    ).toBe(true);
  });
});

/**
 * The zoom control's own source, which is where the range this sweep has to cover is declared.
 *
 * READ rather than IMPORTED, and the constants are exported so importing them is what this should do.
 * Playwright rewrites tsconfig `@/*` aliases in the `.ts` files it transforms and does NOT rewrite
 * them in the `.tsx` ones, so `import { MIN_ZOOM } from '@/components/preview-zoom-control'` resolves
 * the control itself and then dies inside it. Measured: `Error: Cannot find module
 * '@/components/ui/button'` with `src/components/preview-zoom-control.tsx` as the require stack, and
 * one level further in, `Cannot find module '@/lib/utilities'` from `src/components/ui/button.tsx`.
 * (`@/lib/print-preview/font-faces.ts`, a `.ts`, imports `@/lib/asciidoc/sandbox-path` and resolves
 * fine in this same suite, which is how the extension was identified as the difference.) Closing that
 * needs a change to a Playwright or tsconfig file, and this spec owns neither.
 *
 * Reading the declaration is the same bargain the harness makes with `print-preview.css`, which it
 * loads as committed rather than restating: the numbers below are the control's, a change to the
 * control changes what this sweeps, and a declaration this cannot find fails loudly rather than
 * falling back to a number of its own.
 */
const ZOOM_CONTROL = path.join(__dirname, '../../../src/components/preview-zoom-control.tsx');

/** That source, read once. */
const zoomControlSource = readFileSync(ZOOM_CONTROL, 'utf8');

/**
 * One `export const <name> = <number>;` out of the zoom control.
 *
 * @param name - The exported constant's name.
 * @returns Its declared value.
 * @throws {Error} When the control declares no such constant, which is the case a restated number
 *   would have hidden.
 */
function declaredZoom(name: string): number {
  const match = new RegExp(String.raw`export const ${name} = ([\d.]+);`).exec(zoomControlSource);
  if (match === null) {
    throw new Error(`${ZOOM_CONTROL} no longer declares ${name}; this sweep cannot state its own range`);
  }
  return Number(match[1]);
}

/** Smallest zoom the control allows. */
const MIN_ZOOM = declaredZoom('MIN_ZOOM');

/** Largest zoom the control allows. */
const MAX_ZOOM = declaredZoom('MAX_ZOOM');

/** The scales the control's preset selector offers, in the order it offers them. */
const ZOOM_PRESETS: readonly number[] = (() => {
  const block = /export const ZOOM_PRESETS[^=]*=\s*\[([\S\s]*?)];/.exec(zoomControlSource);
  if (block === null) throw new Error(`${ZOOM_CONTROL} no longer declares ZOOM_PRESETS`);
  const scales = [...block[1].matchAll(/scale:\s*([\d.]+)/g)].map((match) => Number(match[1]));
  if (scales.length === 0) throw new Error(`${ZOOM_CONTROL} declares ZOOM_PRESETS with no scales in it`);
  return scales;
})();

/**
 * How far apart two sampled zooms may be.
 *
 * What the sweep is looking for is where a block's edges land on the device-pixel grid, which is a
 * different fraction at every scale, so the sampling is uniform rather than aimed: a twentieth is fine
 * enough that no run of scales longer than that goes unlooked-at, and coarse enough that the whole
 * declared range costs seconds rather than minutes. Measured, one pass over the 76 scales it produces
 * takes about ten seconds; this test makes two of them.
 */
const ZOOM_SWEEP_STEP = 0.05;

/**
 * Every zoom this sweeps: the control's whole declared range at {@link ZOOM_SWEEP_STEP}, with the
 * preset scales folded in wherever the step misses one.
 *
 * The sweep this replaces ran `0.3 + step * 0.05` to a hard-coded fourteen steps — 0.30 to 1.00,
 * under a quarter of the range the control offers, with 1.25, 1.5 and 2 all outside it and the
 * quarter-scale end that the shipped overhang is SIZED for (4px is one device pixel at 0.25, and the
 * stylesheet's note says so) never reached. A test titled "at any zoom" is entitled to the numbers the
 * control actually clamps to.
 */
const ZOOM_SWEEP: readonly number[] = (() => {
  const scales = new Set<number>();
  for (let step = 0; ; step += 1) {
    // Rounded to the hundredth so the presets, which are written as exact decimals, land ON the grid
    // instead of a float's width away from it.
    const scale = Math.round((MIN_ZOOM + step * ZOOM_SWEEP_STEP) * 100) / 100;
    if (scale > MAX_ZOOM) break;
    scales.add(scale);
  }
  scales.add(MAX_ZOOM);
  for (const preset of ZOOM_PRESETS) scales.add(preset);
  return [...scales].toSorted((a, b) => a - b);
})();

/**
 * Chromium's own GPU rasterizer, which is why the check below runs a browser of its own.
 *
 * The mark it looks for is made by the rasterizer rather than by the layout, and only by that one:
 * the software raster this suite's default browser uses cuts the hole in an inset shadow exactly and
 * shows nothing, which is why every screenshot ever taken of this page — this suite's own included —
 * came back clean while the application drew a hairline across every quotation on screen.
 */
const GPU_RASTER_ARGS = [
  '--enable-gpu-rasterization',
  '--ignore-gpu-blocklist',
  // SwiftShader rasterizes on the CPU but through the GPU pipeline, so it takes the same antialiasing
  // path a real GPU does. Named explicitly because a headless Linux runner has no GPU to fall back to.
  '--enable-unsafe-swiftshader',
  '--use-gl=angle',
  '--use-angle=swiftshader',
];

/** A row of the raster that is inked across a block's whole width, and the colour it is inked in. */
interface FullWidthRow {
  /** Row, in device pixels from the top of the screenshot. */
  readonly y: number;
  /** The mean colour of the inked pixels in it. */
  readonly colour: Rgb;
}

/** A band of the raster to look in, in device pixels. */
interface Band {
  readonly top: number;
  readonly bottom: number;
  readonly left: number;
  readonly right: number;
}

/**
 * The rows of one screenshot that are inked across a block's whole width.
 *
 * Decoded and scanned inside a browser page rather than in Node: a screenshot is a PNG, this
 * repository carries no decoder for one, and shipping three million channel values back over the
 * protocol to scan them here would cost more than the whole sweep. Only the rows found come back.
 *
 * @param scanner - A page to decode in; anything blank will do.
 * @param screenshot - The PNG bytes.
 * @param band - Where to look.
 * @returns One entry per row where nearly every pixel in the band is inked.
 */
async function fullWidthRows(scanner: Page, screenshot: Buffer, band: Band): Promise<FullWidthRow[]> {
  return scanner.evaluate(
    async ({ png, at }) => {
      const image = new Image();
      image.src = `data:image/png;base64,${png}`;
      await image.decode();
      const canvas = new OffscreenCanvas(image.naturalWidth, image.naturalHeight);
      const context = canvas.getContext('2d');
      if (context === null) throw new Error('the scanner page has no 2d context');
      context.drawImage(image, 0, 0);
      const left = Math.max(0, Math.ceil(at.left));
      const right = Math.min(image.naturalWidth - 1, Math.floor(at.right));
      const top = Math.max(0, Math.floor(at.top));
      const bottom = Math.min(image.naturalHeight - 1, Math.ceil(at.bottom));
      const width = right - left + 1;
      const { data } = context.getImageData(left, top, width, bottom - top + 1);
      const rows: { y: number; colour: [number, number, number] }[] = [];
      for (let row = 0; row <= bottom - top; row += 1) {
        let inked = 0;
        const sum = [0, 0, 0];
        for (let column = 0; column < width; column += 1) {
          const at = (row * width + column) * 4;
          const pixel = [data[at], data[at + 1], data[at + 2]];
          if (pixel[0] === 255 && pixel[1] === 255 && pixel[2] === 255) continue;
          inked += 1;
          for (let channel = 0; channel < 3; channel += 1) sum[channel] += pixel[channel];
        }
        // "Across the whole width": a line of text never reaches this, because the spaces between its
        // words are paper. A mark left along the block's edge does, because it is one unbroken row.
        if (inked > width * 0.95) {
          rows.push({
            y: top + row,
            colour: [sum[0] / inked, sum[1] / inked, sum[2] / inked],
          });
        }
      }
      return rows;
    },
    { png: screenshot.toString('base64'), at: band },
  );
}

/**
 * How far a row's measured channel may sit from the wash it is claimed to be, in channel units.
 *
 * The residual is expressed in CHANNELS rather than in coverage because the two blocks this file
 * scans are ruled in inks three quarters of the range apart, and a tolerance on the coverage means
 * something different for each. Measured over the positive control's whole sweep — 72 marked rows on
 * the quotation, 67 on the verse — the worst residual against the block's own rule is 0.459 channel
 * units on the quotation and 0.000 on the verse, so one channel unit is twice the instrument's own
 * spread on the noisier of the two.
 *
 * It is also STRICTER than the coverage spread that used to stand here. That asked for `spread(a) <
 * 0.02` over the channels; on the quotation's `#1A4E8A` the weakest channel has 117 units of contrast
 * with paper, so 0.02 of coverage was 2.3 channel units of disagreement — and the widest spread any
 * of those 72 rows actually showed was 0.0053, a quarter of what it allowed.
 */
const WASH_RESIDUAL = 1;

/**
 * Whether an inked row is that colour laid over paper — the same colour at some coverage, rather than
 * a different mark that happens to be pale.
 *
 * `255 - a * (255 - channel)` has to hold on all three channels for ONE `a`, which is what identified
 * the reported hairline as the quotation's rule rather than its frame: the two are different colours
 * and only one of them solves.
 *
 * ## Why the coverage is fitted rather than divided out
 *
 * The version this replaces divided each channel through on its own and compared the answers, and
 * dropped any channel the ink leaves above 200 as carrying no information. That rule is inapplicable
 * to half of what this file asserts: the verse's rule is `#EEEEEE`, all three channels are above 200,
 * and the function THREW on it — "this ink is too pale to identify a wash of it" — so the verse arm
 * had no colour discrimination at all and no positive control could have been written for it.
 *
 * A pale ink is not an unreadable one, it is a low-contrast one. `#EEEEEE` has 17 units of contrast
 * with paper, and the seam it leaves is perfectly measurable: over the control sweep below those rows
 * came out at 251 to 254 against the paper's 255 — most of them 251 or 252 — which is a coverage of
 * 0.059 to 0.235. What it is NOT is precise per channel: one integer step of a 17-unit ink is 0.059
 * of coverage, so a per-channel division and a 0.02 spread would reject a perfectly good reading of
 * it. Fitting one coverage by least squares and then measuring the residual in channels asks the same
 * question in the unit the measurement is actually quantised in, and asks it of every channel,
 * including the ones the old filter discarded.
 *
 * For a neutral ink the fit degenerates to "is this row neutral", which is exactly the discrimination
 * that matters here: the other block's rule is `#1A4E8A`, and measured, the closest any of the
 * quotation's 72 marked rows comes to passing as a wash of `#EEEEEE` is a residual of 3.000 — three
 * times the tolerance.
 *
 * The coverage is bounded to `(0, 1]` because a fit alone does not say the row lies between the ink
 * and the paper: `rgb(100, 100, 100)` is neutral, so it fits `#EEEEEE` with a residual of zero, at
 * nine times full coverage. Measured, every row either control marks sits at 0.046 to 0.254.
 *
 * @param row - The measured colour.
 * @param ink - The colour it is claimed to be.
 * @returns Whether one coverage of `ink` over paper explains all three channels.
 * @throws {Error} When `ink` is paper itself, which nothing can be a wash of.
 */
function isWashOf(row: Rgb, ink: Rgb): boolean {
  const contrast = ink.map((channel) => 255 - channel);
  const measured = row.map((channel) => 255 - channel);
  const denominator = contrast.reduce((sum, channel) => sum + channel * channel, 0);
  if (denominator === 0) throw new Error('paper is not an ink: nothing can be a wash of it');
  const coverage = contrast.reduce((sum, channel, index) => sum + channel * measured[index], 0) / denominator;
  if (coverage <= 0 || coverage > 1) return false;
  return contrast.every((channel, index) => Math.abs(measured[index] - coverage * channel) <= WASH_RESIDUAL);
}

/** A block whose left rule this sweep looks for a seam under, and the rule the export draws it with. */
interface RuledBlock {
  /** How the block is found on the page. */
  readonly selector: string;
  /** The custom property the stylesheet reads the rule's width from. */
  readonly widthProperty: string;
  /** The custom property it reads the rule's colour from. */
  readonly colourProperty: string;
  /** What the reference strokes beside it. */
  readonly rule: StrokedPath;
}

/** One full-width row, with the zoom it was found at. */
interface MarkedRow extends FullWidthRow {
  /** The scale the page column was drawn under. */
  readonly zoom: number;
}

/** A marked row rendered for a failure message. */
function describeRow(row: MarkedRow): string {
  return `zoom ${row.zoom.toFixed(2)} y=${String(row.y)} rgb(${row.colour.map((channel) => channel.toFixed(1)).join(', ')})`;
}

test.describe('the left rule leaves no mark across the block it runs beside', () => {
  test('neither the quotation nor the verse is ruled top and bottom at any zoom', async () => {
    // Read before the browser starts, so a fixture that cannot answer fails here rather than after a
    // minute of screenshots. Both are what the EXPORT strokes: the width the strip has to be measured
    // beside, and the colour a mark has to be in to be that strip's.
    const blocks: readonly RuledBlock[] = [
      {
        selector: '.quoteblock',
        widthProperty: '--print-quote-border-left-width',
        colourProperty: '--print-quote-border-color',
        rule: await referenceRuleBeside(QUOTE_LINE),
      },
      {
        selector: '.verseblock',
        widthProperty: '--print-verse-border-left-width',
        colourProperty: '--print-verse-border-color',
        rule: await referenceRuleBeside('verse-first-line'),
      },
    ];
    // What "at any zoom" is worth is decided here rather than by the loop below, so a control that
    // gained a preset outside the swept range, or that widened its clamps, fails as a gap in this
    // sweep instead of quietly going unswept. See {@link ZOOM_SWEEP}.
    expect(ZOOM_SWEEP[0], 'the sweep starts at the smallest zoom the control allows').toBe(MIN_ZOOM);
    // These two together are what says the presets are INSIDE the swept range rather than merely
    // reachable: {@link ZOOM_SWEEP} folds every preset in, so a preset the control offers outside its
    // own clamps would land past the end of the sweep and fail here rather than silently widening it.
    expect(ZOOM_SWEEP.at(-1), 'and ends at the largest').toBe(MAX_ZOOM);
    expect(ZOOM_PRESETS.length, 'the control offers the presets this reads off it').toBeGreaterThan(2);
    for (const preset of ZOOM_PRESETS) {
      expect(ZOOM_SWEEP, `and visits the ${String(preset * 100)}% preset the control offers`).toContain(preset);
    }
    expect(
      Math.max(...ZOOM_SWEEP.slice(1).map((scale, index) => scale - ZOOM_SWEEP[index])),
      'and leaves no gap in it wider than one step',
    ).toBeLessThanOrEqual(ZOOM_SWEEP_STEP + 1e-9);

    const browser = await chromium.launch({ args: GPU_RASTER_ARGS });
    try {
      const context = await browser.newContext({
        // One device pixel per CSS pixel: the coarsest raster there is, and the one where a block's
        // edge is most often a fraction of a pixel.
        deviceScaleFactor: 1,
        viewport: { width: 1400, height: 1200 },
      });
      const page = await context.newPage();
      await preparePrintPage(page, fixture);

      // The surface has to hold both blocks whole at the LARGEST zoom swept, and 1400 by 1200 does
      // not: at 4.0 the quotation runs to x = 2918 and y = 1989. A band that ran off the edge would
      // be scanned across only the part that fitted — `fullWidthRows` clamps to the image — so a seam
      // over the rest of the block would read as a clean block, which is the answer this test is
      // looking for and the one it must not be able to get by accident. Sized from the page's own
      // boxes rather than from a number written here, and the guard inside the sweep re-checks it
      // every step. Measured, the page column lays out identically at both sizes: the two blocks
      // report left 64.3125 and right 729.390625 either way, because the column's width comes from
      // the theme's page size and not from the viewport.
      const extent = await page.evaluate((selectors) => {
        const column = document.querySelector('[data-testid="page"]');
        if (!(column instanceof HTMLElement)) throw new Error('the page has no column');
        const boxes = selectors.map((selector) => {
          const block = column.querySelector(selector);
          if (!(block instanceof HTMLElement)) throw new Error(`the page has no ${selector}`);
          return block.getBoundingClientRect();
        });
        return {
          right: Math.max(...boxes.map((box) => box.right)),
          bottom: Math.max(...boxes.map((box) => box.bottom)),
        };
      }, blocks.map((block) => block.selector));
      const viewport = {
        width: Math.ceil(extent.right * MAX_ZOOM) + 8,
        height: Math.ceil(extent.bottom * MAX_ZOOM) + 8,
      };
      await page.setViewportSize(viewport);
      const scanner = await context.newPage();

      /**
       * Sweep every zoom the control offers, and report every full-width row over the two blocks.
       *
       * @param patched - The blocks whose left rule is replaced for the duration, and what with.
       *   Empty sweeps the stylesheet as it ships.
       * @returns The marked rows found on each block, keyed by selector.
       */
      const sweep = async (
        patched: readonly { selector: string; shadow: string }[],
      ): Promise<Record<string, MarkedRow[]>> => {
        const found: Record<string, MarkedRow[]> = Object.fromEntries(
          blocks.map((block) => [block.selector, []]),
        );
        for (const scale of ZOOM_SWEEP) {
          const bands = await page.evaluate(
            ({ zoom, selectors, overrides }) => {
              const column = document.querySelector('[data-testid="page"]');
              if (!(column instanceof HTMLElement)) throw new Error('the page has no column');
              // The application draws the page column under exactly this transform, about exactly this
              // origin — see `asciidoc-preview.tsx` — which is what puts a block's edges on fractions
              // of a device pixel in the first place.
              column.style.transformOrigin = 'top left';
              column.style.transform = `scale(${zoom})`;
              return selectors.map((selector) => {
                const block = column.querySelector(selector);
                if (!(block instanceof HTMLElement)) throw new Error(`the page has no ${selector}`);
                // Set on EVERY swept block each step, not only on the patched ones: a sweep that only
                // wrote the override would leave the previous sweep's on the block it is no longer
                // patching, and the shipped stylesheet would then be measured through a substitute.
                block.style.boxShadow = overrides[selector] ?? '';
                const box = block.getBoundingClientRect();
                return {
                  selector,
                  // Clear of the rule itself: what is being looked for is a mark on the OPEN part of
                  // the block, which is where a hole cut out of a fill leaves one.
                  left: box.left + box.width * 0.25,
                  right: box.right - 2,
                  top: box.top - 2,
                  bottom: box.bottom + 2,
                };
              });
            },
            {
              zoom: scale,
              selectors: blocks.map((block) => block.selector),
              overrides: Object.fromEntries(patched.map((one) => [one.selector, one.shadow])),
            },
          );
          for (const band of bands) {
            expect(
              band.right <= viewport.width && band.bottom <= viewport.height,
              `at zoom ${scale.toFixed(2)} the ${band.selector} runs past the surface ` +
                `(${band.right.toFixed(1)} × ${band.bottom.toFixed(1)} against ${String(viewport.width)} × ` +
                `${String(viewport.height)}), so only part of it would be scanned`,
            ).toBe(true);
          }
          // Clipped to the bands rather than to the whole surface: at the top of the range that is a
          // two-megapixel capture instead of a six-megapixel one, and the compositor rasterizes the
          // page in page coordinates either way, so what lands in the returned pixels is the same
          // paint. The rows come back in the clip's coordinates and are put back into the page's.
          const clip = {
            x: Math.floor(Math.min(...bands.map((band) => band.left))),
            y: Math.floor(Math.min(...bands.map((band) => band.top))),
            width: 0,
            height: 0,
          };
          clip.width = Math.ceil(Math.max(...bands.map((band) => band.right))) - clip.x + 1;
          clip.height = Math.ceil(Math.max(...bands.map((band) => band.bottom))) - clip.y + 1;
          const screenshot = await page.screenshot({ clip });
          for (const band of bands) {
            const rows = await fullWidthRows(scanner, screenshot, {
              left: band.left - clip.x,
              right: band.right - clip.x,
              top: band.top - clip.y,
              bottom: band.bottom - clip.y,
            });
            found[band.selector].push(...rows.map((row) => ({ ...row, y: row.y + clip.y, zoom: scale })));
          }
        }
        return found;
      };

      // ── the control ──────────────────────────────────────────────────────────
      // The strip asked for the way it was asked for before, with the hole's top and bottom edges
      // sitting exactly on the block's, on BOTH blocks. Everything below is only worth reading if this
      // leaves the mark — a runner whose Chromium fell back to software raster would find nothing here
      // and would then find nothing on the shipped rule either, and would have proved nothing at all.
      //
      // Both, because the assertion below is made about both and a control that covered one of them
      // proved the instrument works on the ink it happened to use. The verse's is `#EEEEEE` against
      // the quotation's `#1A4E8A`, and a seam that pale is a different measurement problem: measured
      // over this sweep it marks 67 rows at 251 to 254 against the paper's 255, where the quotation's
      // marks 72 at 197 to 250. Neither the count nor the depth is asserted — the raster decides both
      // — but that each is non-empty and each row is its own rule's ink is exactly the claim the
      // shipped sweep's emptiness is worth something against.
      const control = await sweep(
        blocks.map((block) => ({
          selector: block.selector,
          // Read out of the page's own custom properties, so the control draws the rule the theme
          // asked for rather than a width and a colour restated here.
          shadow: `inset var(${block.widthProperty}) 0 0 0 var(${block.colourProperty})`,
        })),
      );
      for (const block of blocks) {
        expect(
          control[block.selector].length,
          `the hole cut with no overhang marks the ${block.selector}, which is what makes this measurable`,
        ).toBeGreaterThan(0);
        for (const row of control[block.selector]) {
          expect(
            isWashOf(row.colour, block.rule.colour),
            `the mark is the rule's own colour rgb(${block.rule.colour.join(', ')}) over paper, measured ${describeRow(row)}`,
          ).toBe(true);
        }
      }

      // ── the stylesheet as it ships ───────────────────────────────────────────
      const shipped = await sweep([]);
      for (const block of blocks) {
        expect(
          shipped[block.selector].map((row) => describeRow(row)),
          `the ${block.selector} rule, drawn in rgb(${block.rule.colour.join(', ')}), marks no row across the block`,
        ).toEqual([]);
      }
    } finally {
      await browser.close();
    }
  });
});
