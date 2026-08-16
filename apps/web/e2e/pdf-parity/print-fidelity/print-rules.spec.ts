/**
 * @file The marks the renderer STROKES, and the insets it pads a block with.
 *
 * The fidelity anchors compare typography, colour and page geometry; the construct checks beside them
 * ask whether a theme's value reached a construct at all. Neither can see the subject of this file. A
 * table's frame, the rule under its header row, the column rule beside an admonition and the space a
 * padded block leaves under its last line are all things the renderer DRAWS rather than sets, and each
 * of them was wrong — some of them badly — while every other comparison in this suite passed.
 *
 * Most of them are measured the only way a drawn mark can be: against a raster of the reference PDF.
 * The file's operator stream would report the width a stroke was asked for, which is a declaration and
 * not a mark; what a reader sees is what the rasteriser made of it, and "this rule is three pixels of
 * that colour and the ones under it are one" is the statement worth holding the preview to.
 *
 * ## …with three exceptions, each named where it applies
 *
 * Two comparisons read the operator stream as WELL as the raster, because a raster cannot be read
 * closer than its own pixel — 0.48pt at the 150 dpi used here — and that is wider than the defect the
 * header rule exists to catch. There the raster establishes that the mark is on the page and heavier
 * than the ones under it, and the `w` operand the file carries is what the preview's own declared
 * width is held to. {@link RULE_WIDTH_TOLERANCE_PT} records why, and by how much.
 *
 * One reads neither. A codespan's chip is a filled path rather than a stroke, and the thing worth
 * knowing about it is which RUN it sits behind — a question a colour in a raster cannot answer, since
 * two cells a page apart are the same pixels. It is read out of the painted paths and the text runs
 * together, on `inline-context-styled`: the only committed reference that draws a codespan an author
 * wrote inside a header column beside a cell a column specifier made monospaced, which is the pair the
 * rule under test has to tell apart.
 *
 * And one opens no reference at all: "the reset a monospaced cell gets names the two declarations the
 * chip's outline is drawn with", which is the only test in this file that is not a fidelity comparison.
 * No fixture theme sets `codespan.border-width`, so no committed reference draws a chip's OUTLINE, and
 * the two declarations `print-preview.css` draws that outline with have nothing on a page to be
 * compared against. What that check does establish is stated in its own comment; it is not evidence
 * about how the preview compares to an export, and must not be counted as any.
 *
 * The preview's side is read from the DOM, and deliberately so: every mark below is drawn by an
 * element with a size of its own rather than by a `border`, because Chromium floors every
 * `border-width` to a whole CSS pixel and the renderer's widths are points. A box's own size is
 * quantised to whole CSS pixels as well — measured at eight device pixels per CSS pixel, 1.6667px is
 * painted as 2px — but it is ROUNDED rather than floored, and it is placed where the renderer strokes
 * it rather than half a pixel off. So the DOM size is what the preview ASKED for, which is the
 * property this file holds; how much of it survives to the screen is Chromium's, and the one
 * primitive that keeps a sub-pixel width at all is a `box-shadow`'s spread.
 */

import { expect, test, type Page } from '@playwright/test';
import {
  PRINT_FIDELITY_TOLERANCE,
  pageRasters,
  paintedBoxes,
  sameColour,
  sameColour as coloursAgree,
  strokedPaths,
  textRuns,
  type PageRaster,
  type PaintedBox,
  type Rgb,
  type TextRun,
} from '../harness/pdftools';
import {
  PIXELS_PER_POINT,
  baselinesOf,
  colourOf,
  preparePrintDocument,
  preparePrintPage,
  readFixture,
  renderSourceWithWorker,
  renderWithWorker,
} from './harness';

/** The fixture this file is about, and the only one that carries every construct it measures. */
const FIXTURE = 'rules-and-insets';

/**
 * The fixture whose reference draws the two cells the codespan chip rule has to tell apart.
 *
 * `rules-and-insets` cannot: it has an `m` column and a codespan an author wrote in a plain one, but
 * no HEADER column, and the whole question the chip rule turns on is `td` against `th`.
 * `inline-context-styled` carries `[cols="1,1m"]` and `[cols="1h,3"]` in one document, under a theme
 * that gives the codespan a chip, so its reference draws the pair and the difference between them.
 */
const HEADER_COLUMN_FIXTURE = 'inline-context-styled';

/** The resolution the reference is rasterised at; one 0.5pt hairline is already a pixel here. */
const DPI = 150;

/**
 * How far a rule's measured thickness may differ from the page's, on top of the shared geometry
 * tolerance.
 *
 * One raster pixel, because that is the quantum the measurement is made in: a 1.25pt rule at 150 dpi
 * covers 2.6 pixels, and where its edges fall between pixels decides whether the rasteriser writes two
 * fully-inked rows or three. It is a property of the instrument, not a claim about the preview.
 */
const RASTER_PIXEL_PT = 72 / DPI;

/**
 * How far the preview's DECLARED width of a rule may sit from the width the reference's operator
 * stream declares, in points.
 *
 * Not the geometry tolerance, and not the raster one either: both sides of a comparison held to this
 * are declarations. The preview's is a length resolved out of a custom property and read back through
 * a computed style; the reference's is the `w` operand prawn wrote. They agree to the arithmetic and
 * to the round trip through Chromium's 1/64-of-a-CSS-pixel layout unit, which is 0.0117pt at worst.
 *
 * This exists because comparing a declaration against a RASTER cannot be held tightly enough to catch
 * the defect it is written for. The header rule the fixture theme produces is 1.25pt, which at 150 dpi
 * covers 2.6 raster pixels and reads as 1.44; the raster's own quantum is 0.48pt, and stacked on the
 * half-point geometry tolerance that made the allowance 0.98pt against a measured quantity of 1.44.
 * A preview that drew the head rule at the ROW rule's 0.5pt — the "band disappears" defect the
 * comparison exists to catch — sat 0.94pt away and passed. Against the stream's own 1.25 the same
 * defect is 0.75pt out, which is seven hundred times this.
 */
const RULE_WIDTH_TOLERANCE_PT = 0.05;

/** The arithmetic mean of a non-empty list. */
function mean(values: readonly number[]): number {
  return values.reduce((total, value) => total + value, 0) / values.length;
}

/** One run of a colour down a column of the raster. */
interface Run {
  /** Where the run starts, in points from the top of the page. */
  readonly atPt: number;
  /** How long it is, in points. */
  readonly lengthPt: number;
  /** The colour it is drawn in. */
  readonly colour: Rgb;
}

/**
 * Every horizontal rule crossing one column of the page, in one of a set of colours.
 *
 * @param raster - The rasterised page.
 * @param xPt - Where to take the section, in points from the left edge.
 * @param colours - The colours that count as a rule; anything else is background.
 * @returns One entry per run, top to bottom.
 */
function rulesDownColumn(raster: PageRaster, xPt: number, colours: readonly Rgb[]): Run[] {
  const x = Math.round((xPt * raster.dpi) / 72);
  const runs: Run[] = [];
  let y = 0;
  while (y < raster.heightPx) {
    const found = colours.find((colour) => sameColour(raster.colourAt(x, y), colour));
    if (found === undefined) {
      y += 1;
      continue;
    }
    const start = y;
    while (y < raster.heightPx && colours.some((colour) => sameColour(raster.colourAt(x, y), colour))) {
      y += 1;
    }
    runs.push({ atPt: (start * 72) / raster.dpi, lengthPt: ((y - start) * 72) / raster.dpi, colour: found });
  }
  return runs;
}

/**
 * How wide a stroke of one colour is where it crosses a scan line, measured by coverage.
 *
 * Counting the pixels that match the colour exactly measures the stroke's fully-inked core and misses
 * the antialiased edge on either side, which for a 2pt rule is most of a third of it. Each pixel's
 * distance from the paper toward the stroke's own colour is the fraction of it the stroke covers, and
 * the sum of those fractions is the stroke's width — which is what the renderer asked for.
 *
 * @param raster - The rasterised page.
 * @param yPt - The scan line, in points from the top.
 * @param colour - The stroke's colour.
 * @param fromPt - Where to start scanning, in points from the left.
 * @param toPt - Where to stop.
 * @returns The width in points, and the coverage-weighted centre in points from the left edge.
 */
function strokeAcross(
  raster: PageRaster,
  yPt: number,
  colour: Rgb,
  fromPt: number,
  toPt: number,
): { widthPt: number; centrePt: number } {
  const y = Math.round((yPt * raster.dpi) / 72);
  const from = Math.round((fromPt * raster.dpi) / 72);
  const to = Math.round((toPt * raster.dpi) / 72);
  // The channel the stroke differs from white in the most; the one that resolves its edge best.
  const channel = [0, 1, 2].toSorted((a, b) => colour[a] - colour[b])[0];
  const contrast = 255 - colour[channel];
  let covered = 0;
  let weighted = 0;
  for (let x = from; x <= to; x += 1) {
    const alpha = contrast === 0 ? 0 : (255 - raster.colourAt(x, y)[channel]) / contrast;
    if (alpha <= 0) continue;
    covered += alpha;
    weighted += (x + 0.5) * alpha;
  }
  return {
    widthPt: (covered * 72) / raster.dpi,
    centrePt: covered === 0 ? 0 : (weighted / covered / raster.dpi) * 72,
  };
}

/** The tightest box, in points, around every pixel of one colour. */
function boxOfColour(
  raster: PageRaster,
  colour: Rgb,
): { leftPt: number; topPt: number; rightPt: number; bottomPt: number } | null {
  let left = raster.widthPx;
  let top = raster.heightPx;
  let right = -1;
  let bottom = -1;
  for (let y = 0; y < raster.heightPx; y += 1) {
    for (let x = 0; x < raster.widthPx; x += 1) {
      // Exactly, not within a tolerance: the fills being located here are flat, and a tolerance wide
      // enough to absorb antialiasing is also wide enough to catch the paper next to them.
      const pixel = raster.colourAt(x, y);
      if (pixel[0] !== colour[0] || pixel[1] !== colour[1] || pixel[2] !== colour[2]) continue;
      if (x < left) left = x;
      if (x > right) right = x;
      if (y < top) top = y;
      if (y > bottom) bottom = y;
    }
  }
  if (right < 0) return null;
  const toPt = (value: number): number => (value * 72) / raster.dpi;
  return { leftPt: toPt(left), topPt: toPt(top), rightPt: toPt(right + 1), bottomPt: toPt(bottom + 1) };
}

/**
 * Where to take a vertical section through the tables, in points from the page's left edge.
 *
 * Through the middle of the first COLUMN, read off the preview's own layout: a section down the
 * middle of the page runs along the column rule between two equal columns, where every horizontal
 * rule is buried inside one continuous vertical one and nothing can be measured at all.
 *
 * @param page - The prepared browser page.
 * @returns The section's x in points, or the page's own quarter width when there is no table.
 */
async function sectionThroughFirstColumn(page: Page): Promise<number> {
  return page.evaluate((perPoint) => {
    const cell = document.querySelector('[data-testid="page"] table.tableblock tbody td');
    const column = document.querySelector('[data-testid="page"]');
    if (cell === null || column === null) return 0;
    const box = cell.getBoundingClientRect();
    return (box.left + box.width / 2 - column.getBoundingClientRect().left) / perPoint;
  }, PIXELS_PER_POINT);
}

/** The runs of one paragraph of the reference, located by what its first line says. */
function runsOfParagraph(runs: readonly TextRun[], opening: string): TextRun[] {
  const start = runs.findIndex((run) => run.text.startsWith(opening.slice(0, 20)));
  if (start === -1) return [];
  const found: TextRun[] = [];
  for (const run of runs.slice(start)) {
    if (run.text.trim() === '') continue;
    // The paragraph ends where the text stops flowing down the same column, which for the admonition
    // this locates is where the next construct's first run sits back at the page's own left margin.
    if (found.length > 0 && run.xPt < found[0].xPt - 1) break;
    found.push(run);
  }
  return found;
}

/**
 * How far a fill may fall short of the run it is painted behind before it stops counting as being
 * behind it, in points.
 *
 * The chip prawn paints is grown from the fragment's own extent, so a chip's edge and its run's edge
 * are the same number arriving through two different decoders — the text layer's transform, and the
 * path's. A quarter point is the slack that round trip is allowed and nothing more; measured on
 * `inline-context-styled`, the chip behind `` `d` `` runs 51.24pt to 56.49pt and the run under it
 * 51.24pt to 56.49pt, so the two agree exactly today and the slack absorbs nothing real.
 */
const FILL_CONTAINMENT_SLACK_PT = 0.25;

/**
 * The one run of the reference whose text is exactly `text`.
 *
 * Exactly one, asserted rather than assumed: `find` on a document that grew a second `` `d` `` would
 * silently pick whichever came first, and every measurement after it would be of the wrong cell.
 *
 * @param runs - Every text run in the reference.
 * @param text - The run's text, in full.
 * @returns The run.
 */
function runReading(runs: readonly TextRun[], text: string): TextRun {
  const found = runs.filter((run) => run.text === text);
  expect(found, `the reference draws exactly one run reading ${JSON.stringify(text)}`).toHaveLength(1);
  return found[0];
}

/**
 * Every fill the reference paints behind one run.
 *
 * "Behind" is containment rather than overlap: the run's baseline passes through the box, and the box
 * spans the run from end to end. That admits the paper, the cell's own background and the chip alike,
 * which is deliberate — {@link fillsOnlyBehind} is what separates them, and it does so by asking which
 * of them the page also paints behind an ordinary cell rather than by guessing at a chip's size.
 *
 * @param boxes - Every painted path in the reference.
 * @param run - The run to look behind.
 * @returns The fills containing it, in drawing order.
 */
function fillsBehind(boxes: readonly PaintedBox[], run: TextRun): PaintedBox[] {
  return boxes.filter(
    (box) =>
      box.filled &&
      box.leftPt <= run.xPt + FILL_CONTAINMENT_SLACK_PT &&
      box.rightPt >= run.xPt + run.widthPt - FILL_CONTAINMENT_SLACK_PT &&
      // The file measures from the page's BOTTOM and a run reports its baseline, so a box behind the
      // run is one whose extent the baseline falls inside.
      box.bottomPt <= run.yPt &&
      box.topPt >= run.yPt,
  );
}

/**
 * The fills behind one run that the page does not, in the same colour, paint behind another.
 *
 * The mark that tells two cells apart, with everything they share subtracted: the paper and a cell's
 * background are painted behind every cell of the table, so neither can be the thing a codespan chip
 * is. What is left is a fill the page draws for one construct and not for the other, which is exactly
 * the claim a chip check has to make.
 *
 * Subtracted by COLOUR rather than by box, because the two runs sit in different cells and therefore
 * over different background rectangles; it is the tint that is shared, not the geometry.
 *
 * @param boxes - Every painted path in the reference.
 * @param run - The run to look behind.
 * @param beside - The run whose fills count as shared.
 * @returns The fills behind `run` alone.
 */
function fillsOnlyBehind(boxes: readonly PaintedBox[], run: TextRun, beside: TextRun): PaintedBox[] {
  const shared = fillsBehind(boxes, beside);
  return fillsBehind(boxes, run).filter(
    (box) => !shared.some((other) => sameColour(box.colour, other.colour)),
  );
}

/**
 * The first table's rules, from its top edge down to its bottom one.
 *
 * The extent is found from where the FRAME colour appears, and what is found is asserted before it
 * is used: this section crosses two tables, each edged top and bottom, so the frame colour appears
 * exactly four times and the first of those marks is the first thing on the section.
 *
 * Written this way because the obvious form is an identity. Slicing to "up to and including the next
 * rule that agrees with the frame colour" and then asserting that the slice ends on one asserts the
 * slice's own construction: it passed on a page whose frame was never drawn — and, when the frame
 * colour could not be read at all, on a slice that was empty.
 *
 * @param rules - Every rule down the section, top to bottom.
 * @param frame - The frame colour.
 * @returns The first table's rules, its own edges included.
 */
function firstTableRules(rules: readonly Run[], frame: Rgb): Run[] {
  const edges = rules.flatMap((rule, index) => (coloursAgree(rule.colour, frame) ? [index] : []));
  expect(edges, 'the section crosses two tables, each edged top and bottom in the frame colour').toHaveLength(4);
  expect(edges[0], "and the first mark on it is the first table's top edge").toBe(0);
  return rules.slice(edges[0], edges[1] + 1);
}

test.describe('the rules the renderer strokes and the insets it pads with', () => {
  test("a table's frame is its own colour, and the grid inside it is the grid's", async ({ page }) => {
    // `convert_table` sets the outer edges on the outermost CELLS from `table.border-*` and every
    // other edge from `table.grid-*`. The two are separate theme groups and the gem's own default
    // theme gives them the same WIDTH, which is what makes this worth measuring: at equal widths a
    // frame declared as the table element's border loses the collapsed-border contest to the cells
    // and silently takes their colour, so the frame disappears while every width still reads right.
    const fixture = readFixture(FIXTURE);
    const prepared = await preparePrintPage(page, fixture);
    const frame = colourOf(prepared.cssProperties['--print-table-border-color'], 'the table frame colour');
    const grid = colourOf(prepared.cssProperties['--print-table-grid-color'], 'the table grid colour');
    expect(coloursAgree(frame, grid), 'the fixture theme frames its tables in a colour the grid does not use').toBe(false);

    const [raster] = pageRasters(fixture.referencePdf, DPI);
    // Down the middle of the page, which crosses both tables away from their column rules.
    const rules = rulesDownColumn(raster, await sectionThroughFirstColumn(page), [frame, grid]);
    // Two tables, each: frame top, header rule, two body rules, frame bottom.
    expect(rules.length, 'the reference draws both tables').toBeGreaterThanOrEqual(10);
    const firstTable = firstTableRules(rules, frame);
    expect(firstTable.length, 'the first table has body rows between its two edges').toBeGreaterThan(3);
    for (const rule of firstTable.slice(1, -1)) {
      expect(coloursAgree(rule.colour, grid), 'the page draws every interior rule in the grid colour').toBe(true);
    }

    // …and the preview says the same thing about the same edges.
    const borders = await page.evaluate(() => {
      const table = document.querySelector('[data-testid="page"] table.tableblock');
      const read = (selector: string, side: string): string => {
        const element = table?.querySelector(selector) ?? null;
        return element === null ? 'missing' : getComputedStyle(element).getPropertyValue(`border-${side}-color`);
      };
      const topLeft = 'thead tr:first-child th:first-child';
      const bottomRight = 'tbody tr:last-child td:last-child';
      return {
        outerTop: read(topLeft, 'top'),
        outerLeft: read(topLeft, 'left'),
        outerBottom: read(bottomRight, 'bottom'),
        outerRight: read(bottomRight, 'right'),
        interiorRight: read(topLeft, 'right'),
        interiorLeft: read(bottomRight, 'left'),
      };
    });
    const asRgb = `rgb(${frame.join(', ')})`;
    const gridRgb = `rgb(${grid.join(', ')})`;
    expect(borders.outerTop).toBe(asRgb);
    expect(borders.outerLeft).toBe(asRgb);
    expect(borders.outerBottom).toBe(asRgb);
    expect(borders.outerRight).toBe(asRgb);
    expect(borders.interiorRight).toBe(gridRgb);
    expect(borders.interiorLeft).toBe(gridRgb);
  });

  test('the rule under a header row is as heavy as the page draws it', async ({ page }) => {
    // `head.border-bottom-width` defaults to two and a half times the row grid, which is what makes a
    // header read as a band rather than as one more row. It is also, at the gem's own defaults,
    // 1.25pt — a width no whole number of CSS pixels can express, so a border here draws it at exactly
    // the weight of the hairlines under it and the band disappears.
    const fixture = readFixture(FIXTURE);
    const prepared = await preparePrintPage(page, fixture);
    const frame = colourOf(prepared.cssProperties['--print-table-border-color'], 'the table frame colour');
    const grid = colourOf(prepared.cssProperties['--print-table-grid-color'], 'the table grid colour');

    const sectionPt = await sectionThroughFirstColumn(page);
    const [raster] = pageRasters(fixture.referencePdf, DPI);
    const rules = rulesDownColumn(raster, sectionPt, [frame, grid]);
    const firstTable = firstTableRules(rules, frame);
    const headRule = firstTable[1];
    const rowRules = firstTable.slice(2, -1);
    expect(rowRules.length, 'the reference table has body rows under its header').toBeGreaterThan(0);
    const rowRulePt = Math.min(...rowRules.map((rule) => rule.lengthPt));
    expect(headRule.lengthPt, 'the page draws the header rule heavier than a row rule').toBeGreaterThan(rowRulePt);

    // …and what the reference DECLARED that rule to be, which is the number the preview's own
    // declaration can be held to tightly. The stroke is located by the rule the raster already found
    // — its centre, in the file's own bottom-up coordinates — rather than by its width, so nothing
    // here picks the answer it is about to assert.
    const strokes = await strokedPaths(fixture.referencePdf);
    const pageHeightPt = (raster.heightPx * 72) / raster.dpi;
    const headCentrePt = pageHeightPt - (headRule.atPt + headRule.lengthPt / 2);
    const headStrokes = strokes.filter(
      (stroke) =>
        Math.abs((stroke.topPt + stroke.bottomPt) / 2 - headCentrePt) <= RASTER_PIXEL_PT &&
        stroke.topPt - stroke.bottomPt < 2 &&
        stroke.leftPt <= sectionPt &&
        stroke.rightPt >= sectionPt,
    );
    expect(headStrokes.length, 'the reference strokes the header rule where the raster found it').toBeGreaterThan(0);
    const headDeclaredPt = headStrokes[0].lineWidthPt;
    // prawn-table writes the boundary onto both of the cells that share it, so the rule arrives as
    // more than one stroke; they have to agree, or "the width the reference declared" is ambiguous.
    for (const stroke of headStrokes) expect(stroke.lineWidthPt).toBeCloseTo(headDeclaredPt, 3);
    // The row rules under it, located the same way, so "heavier than a row rule" is a statement the
    // reference makes about two declarations rather than about two runs of raster pixels.
    const rowCentrePt = pageHeightPt - (firstTable[2].atPt + firstTable[2].lengthPt / 2);
    const rowStroke = strokes.find(
      (stroke) =>
        Math.abs((stroke.topPt + stroke.bottomPt) / 2 - rowCentrePt) <= RASTER_PIXEL_PT &&
        stroke.topPt - stroke.bottomPt < 2 &&
        stroke.leftPt <= sectionPt &&
        stroke.rightPt >= sectionPt,
    );
    expect(rowStroke, 'and strokes the first body-row rule under it').toBeDefined();
    if (rowStroke === undefined) return;
    expect(
      headDeclaredPt,
      `the reference declares its head rule ${headDeclaredPt.toFixed(3)}pt and its row rule ${rowStroke.lineWidthPt.toFixed(3)}pt`,
    ).toBeGreaterThan(rowStroke.lineWidthPt);

    const preview = await page.evaluate((perPoint) => {
      const th = document.querySelector('[data-testid="page"] table.tableblock thead tr:last-child th');
      const td = document.querySelector('[data-testid="page"] table.tableblock tbody tr:first-child td');
      if (th === null || td === null) return null;
      return {
        headRulePt: Number.parseFloat(getComputedStyle(th, '::after').height) / perPoint,
        rowRulePt: Number.parseFloat(getComputedStyle(td).borderBottomWidth) / perPoint,
      };
    }, PIXELS_PER_POINT);

    expect(preview, 'the preview lays the table out').not.toBeNull();
    if (preview === null) return;
    // Declaration against declaration, at the tolerance that comparison deserves. The raster reading
    // above is what says the rule is really on the page and really heavier than the ones under it;
    // this is what says the preview draws it at the width the reference asked for.
    expect(
      Math.abs(preview.headRulePt - headDeclaredPt),
      `preview head rule ${preview.headRulePt.toFixed(3)}pt, reference declares ${headDeclaredPt.toFixed(3)}pt`,
    ).toBeLessThanOrEqual(RULE_WIDTH_TOLERANCE_PT);
    // …and against the mark a reader sees, which a declaration alone cannot establish. Held to the
    // raster's own quantum and nothing more: a run of pixels is measured in whole pixels, and the
    // half-point geometry allowance stacked on top of that is what let a 0.5pt head rule through.
    expect(
      Math.abs(preview.headRulePt - headRule.lengthPt),
      `preview head rule ${preview.headRulePt.toFixed(2)}pt, page raster ${headRule.lengthPt.toFixed(2)}pt`,
    ).toBeLessThanOrEqual(RASTER_PIXEL_PT);
    expect(preview.headRulePt, 'the preview draws it heavier than a row rule too').toBeGreaterThan(preview.rowRulePt);
  });

  test('a body row is as tall as the page makes it', async ({ page }) => {
    // A cell's height in the renderer is its padding plus one line box, and nothing else: prawn-table
    // sets the cell's text directly, so there is no paragraph and no paragraph margin. The HTML puts
    // a `<p class="tableblock">` in every cell, and that paragraph's `prose.margin-bottom` fell inside
    // the cell's padding and added to it — a whole paragraph gap under every row of every table.
    const fixture = readFixture(FIXTURE);
    const prepared = await preparePrintPage(page, fixture);
    const frame = colourOf(prepared.cssProperties['--print-table-border-color'], 'the table frame colour');
    const grid = colourOf(prepared.cssProperties['--print-table-grid-color'], 'the table grid colour');

    const [raster] = pageRasters(fixture.referencePdf, DPI);
    const rules = rulesDownColumn(raster, await sectionThroughFirstColumn(page), [frame, grid]);
    const firstTable = firstTableRules(rules, frame);
    // Rule to rule, from the middle of one to the middle of the next: a pitch, which is the row's own
    // height however the rasteriser rounded the rules bounding it.
    const centres = firstTable.map((rule) => rule.atPt + rule.lengthPt / 2);
    const pagePitches = centres.slice(2).map((centre, index) => centre - centres[index + 1]);
    expect(pagePitches.length, 'the reference table has more than one body row').toBeGreaterThan(1);

    const preview = await page.evaluate((perPoint) => {
      // The FIRST table's rows, because `firstTableRules` reads the first table's rules. This
      // document carries two, and an unscoped query returned all six of their rows against the
      // reference's three — which the `Math.min` below used to absorb without a word.
      const table = document.querySelector('[data-testid="page"] table.tableblock');
      const rows = [...(table?.querySelectorAll('tbody tr') ?? [])];
      const cell = rows[0]?.querySelector('td');
      return {
        pitchesPt: rows.map((row) => row.getBoundingClientRect().height / perPoint),
        gridRulePt:
          cell === null || cell === undefined
            ? 0
            : Number.parseFloat(getComputedStyle(cell).borderBottomWidth) / perPoint,
      };
    }, PIXELS_PER_POINT);

    // Net of one grid rule. A collapsed border occupies space in the CSS table model — half of it in
    // each of the cells that share the edge — while prawn-table strokes its rules ON the boundary and
    // reserves nothing for them, so a row in the preview is a page's row plus exactly one rule. The
    // residue is named here rather than absorbed into a wider tolerance, because it is the one part of
    // a row's height this style cannot express and it is worth being able to see if it ever grows.
    // The preview has as many body rows as the page does, asserted before any of them is compared.
    // `Math.min` used to decide how many to look at, so a preview that dropped a row simply had one
    // fewer comparison made of it — and the mean below truncated both sides equally, so three
    // reference rows against two previewed ones failed nothing at all.
    expect(
      preview.pitchesPt.length,
      `the preview lays out ${String(preview.pitchesPt.length)} body rows, the reference ${String(pagePitches.length)}`,
    ).toBe(pagePitches.length);
    const compared = pagePitches.length;
    for (let index = 0; index < compared; index += 1) {
      const previewPitch = preview.pitchesPt[index] - preview.gridRulePt;
      expect(
        Math.abs(previewPitch - pagePitches[index]),
        `row ${index + 1}: preview ${previewPitch.toFixed(2)}pt, page ${pagePitches[index].toFixed(2)}pt`,
        // Each rule's centre is quantised by the raster, so one row's measured pitch can be a whole
        // pixel out either way while the table as a whole is exact — which is what the mean below
        // holds. The per-row check is here to catch a table whose rows are not all the same height.
      ).toBeLessThanOrEqual(PRINT_FIDELITY_TOLERANCE.geometryPt + RASTER_PIXEL_PT);
    }
    // The rows of this table are identical by construction — one line of text each — so their mean
    // pitch is the height the renderer builds a body row at, with the raster's rounding averaged out.
    const previewMean = mean(preview.pitchesPt.slice(0, compared)) - preview.gridRulePt;
    const pageMean = mean(pagePitches.slice(0, compared));
    expect(
      Math.abs(previewMean - pageMean),
      `preview row ${previewMean.toFixed(2)}pt, page ${pageMean.toFixed(2)}pt`,
    ).toBeLessThanOrEqual(PRINT_FIDELITY_TOLERANCE.geometryPt);
  });

  test('a monospaced column is bare monospace, not a column of codespan chips', async ({ page }) => {
    // `[cols="1m"]` reaches `convert_table`'s `:monospaced` branch, which takes the codespan's family,
    // size and colour for the whole cell — and nothing else. The box behind an inline codespan is
    // painted by the text formatter around a `<code>` FRAGMENT, and a monospaced cell has no such
    // fragment unless the author wrote one inside it.
    //
    // Through the render worker, unlike everything else in this file: Asciidoctor's HTML says the
    // same thing for a monospaced cell and for a codespan that fills one, and the worker is where the
    // whole cell's text is available to tell them apart. Converting here instead would measure a page
    // the application never shows.
    const fixture = readFixture(FIXTURE);
    const prepared = await preparePrintPage(page, fixture, await renderWithWorker(fixture));
    const chip = colourOf(prepared.cssProperties['--print-codespan-background-color'], 'the codespan chip colour');

    const [raster] = pageRasters(fixture.referencePdf, DPI);
    const chipBox = boxOfColour(raster, chip);
    expect(chipBox, 'the reference paints the codespan chip somewhere').not.toBeNull();
    if (chipBox === null) return;

    // The preview's own columns say where the two are. The chip on the page must fall inside the
    // PLAIN column — the fixture writes one codespan there — and nowhere inside the monospaced one.
    const columns = await page.evaluate((perPoint) => {
      const table = document.querySelector('[data-testid="page"] table.tableblock');
      const cells = [...(table?.querySelectorAll('tbody tr:first-child td') ?? [])];
      const pageLeft = document.querySelector('[data-testid="page"]')?.getBoundingClientRect().left ?? 0;
      const monoCells = [...(table?.querySelectorAll('tbody td:last-child > p > code') ?? [])];
      const inlineCode = table?.querySelector('tbody td:first-child > p > code') ?? null;
      return {
        edgesPt: cells.map((cell) => {
          const box = cell.getBoundingClientRect();
          return { leftPt: (box.left - pageLeft) / perPoint, rightPt: (box.right - pageLeft) / perPoint };
        }),
        monoBackgrounds: monoCells.map((code) => getComputedStyle(code).backgroundColor),
        inlineBackground: inlineCode === null ? 'missing' : getComputedStyle(inlineCode).backgroundColor,
      };
    }, PIXELS_PER_POINT);

    expect(columns.edgesPt.length, 'the fixture table has two columns').toBe(2);
    const [plain, monospaced] = columns.edgesPt;
    expect(chipBox.leftPt, 'the page chips the codespan in the plain column').toBeGreaterThanOrEqual(plain.leftPt - 1);
    // The RIGHT edge is the one that can say the monospaced column is bare, and it is the whole of
    // that claim: `chipBox` is the tightest box around EVERY pixel of the chip colour on the page, so
    // a chip painted anywhere in the `m` column would push this past the boundary between the two.
    // The LEFT edge cannot say it — a box spanning the full width of the page still starts left of
    // the second column — and it used to be what carried this message, under a separate assertion
    // that the `plain.rightPt + 1` bound above already implied. Measured on this reference: the chip
    // ends at 107.52pt and the monospaced column starts at 297.63pt.
    expect(chipBox.rightPt, 'and nothing in the monospaced one').toBeLessThanOrEqual(monospaced.leftPt);

    // The preview draws the same two things: no chip on the column, the chip on the codespan.
    expect(columns.monoBackgrounds.length, 'the preview has monospaced cells to look at').toBeGreaterThan(1);
    for (const background of columns.monoBackgrounds) {
      expect(background).toBe('rgba(0, 0, 0, 0)');
    }
    expect(columns.inlineBackground).toBe(`rgb(${chip.join(', ')})`);
  });

  test('a cell the column made monospaced keeps no chip, and one an author wrote in a header column keeps the one the page paints', async ({
    page,
  }) => {
    // Two cells with IDENTICAL markup and opposite answers. `[cols="1m"]` reaches `convert_table`'s
    // `:monospaced` branch, which sets the whole cell in the codespan's family, size and colour and
    // paints nothing behind it. `[cols="1h"]` reaches the HEADER branch instead — the two are
    // alternatives, and a cell the column makes monospaced is a `td` while a header column's cells are
    // `th` — so a `` `d` `` an author writes inside one of those is an ordinary codespan fragment and
    // the text formatter paints its box.
    //
    // Asciidoctor writes `<p class="tableblock"><code>…</code></p>` for both, and the render worker
    // names both, because what it can see is only that the `<code>` fills the paragraph. `td` is what
    // separates them, and without it every codespan in every header column lost its chip.
    //
    // Measured against the reference, and it used to be measured against nothing: this check ran on a
    // document written for the occasion and compared the preview's computed styles to values spelled
    // out beside them, so what it established was that the stylesheet agreed with this file. Every
    // number below is read out of `inline-context-styled`'s reference at run time instead — the fill's
    // colour, the extent it covers, and the fact that the page paints one behind the one cell and not
    // behind the other.
    //
    // Through the render worker, because the mark the stylesheet turns on is the worker's: Asciidoctor
    // says the same thing for both cells and only the worker names the paragraph a `<code>` fills.
    const fixture = readFixture(HEADER_COLUMN_FIXTURE);
    await preparePrintPage(page, fixture, await renderWithWorker(fixture));

    const runs = await textRuns(fixture.referencePdf);
    const boxes = await paintedBoxes(fixture.referencePdf);
    // `d` fills a `th` of the `[cols="1h,3"]` table; `Ctrl+D` fills a `td` of the `[cols="1,1m"]` one;
    // `Delete the line` is the ordinary cell beside it, and it is the control — whatever the page
    // paints behind THAT is a cell background rather than a chip, so subtracting it leaves only marks
    // a construct earned for itself.
    const authored = runReading(runs, 'd');
    const madeMonospaced = runReading(runs, 'Ctrl+D');
    const ordinary = runReading(runs, 'Delete the line');

    const chips = fillsOnlyBehind(boxes, authored, ordinary);
    expect(
      chips.length,
      'the reference paints one fill behind the header column’s codespan that it paints behind no ordinary cell',
    ).toBe(1);
    // The page really does paint behind the monospaced cell — its own background, the same one it
    // paints behind the ordinary cell beside it — so the subtraction below is a reading rather than a
    // miss. Without this, a run lookup that landed nowhere and a page that fills nothing at all would
    // both satisfy "no chip" in silence, which is the shape every negative check in this suite has to
    // be able to rule out.
    expect(
      fillsBehind(boxes, madeMonospaced).length,
      'the reference fills something behind the monospaced cell',
    ).toBeGreaterThan(0);
    expect(
      fillsOnlyBehind(boxes, madeMonospaced, ordinary).length,
      'and nothing of the cell’s own: no fill behind it that it does not share with an ordinary cell',
    ).toBe(0);
    const chip = chips[0];
    // …and that fill really is a box around the RUN rather than a band across something wider, which
    // is the difference between "the page chips this codespan" and "the page fills this cell". Both
    // edges, because a fill that started at the run and ran on to the cell's edge would satisfy one.
    expect(
      Math.abs(chip.leftPt - authored.xPt),
      `the chip starts at ${chip.leftPt.toFixed(2)}pt, the run it is behind at ${authored.xPt.toFixed(2)}pt`,
    ).toBeLessThanOrEqual(PRINT_FIDELITY_TOLERANCE.geometryPt);
    expect(
      Math.abs(chip.rightPt - (authored.xPt + authored.widthPt)),
      `the chip ends at ${chip.rightPt.toFixed(2)}pt, the run at ${(authored.xPt + authored.widthPt).toFixed(2)}pt`,
    ).toBeLessThanOrEqual(PRINT_FIDELITY_TOLERANCE.geometryPt);

    const preview = await page.evaluate((perPoint) => {
      const read = (
        selector: string,
      ): { text: string; background: string; widthPt: number } | null => {
        const element = document.querySelector(`[data-testid="page"] ${selector}`);
        if (element === null) return null;
        return {
          text: element.textContent ?? '',
          background: getComputedStyle(element).backgroundColor,
          widthPt: element.getBoundingClientRect().width / perPoint,
        };
      };
      // The tag is IN the selector, because the tag is the whole rule: a `th` the header column made,
      // and a `td` the `m` column made, both holding a paragraph the worker named `monospaced`.
      return {
        header: read('table:nth-of-type(2) tbody th.tableblock > p.tableblock.monospaced > code'),
        monospaced: read('table:nth-of-type(1) tbody td.tableblock > p.tableblock.monospaced > code'),
      };
    }, PIXELS_PER_POINT);

    expect(preview.header, 'the preview lays out a header column with a codespan in it').not.toBeNull();
    expect(preview.monospaced, 'the preview lays out a monospaced column').not.toBeNull();
    // Unreachable — `expect` throws — and present only so the types narrow past it.
    if (preview.header === null || preview.monospaced === null) return;
    // The elements measured are the cells the runs came out of, so a stylesheet that moved the mark
    // onto some other codespan cannot pass by having chipped the right NUMBER of things.
    expect(preview.header.text, 'the header cell holds the run the reference chips').toBe(authored.text);
    expect(preview.monospaced.text, 'and the monospaced cell holds the run it does not').toBe(
      madeMonospaced.text,
    );

    expect(preview.header.background, 'the preview chips it in the colour the page paints').toBe(
      `rgb(${chip.colour.join(', ')})`,
    );
    // The chip's WIDTH, which is where the reset's `padding-inline` shows: prawn grows the box from the
    // fragment's own extent, so a codespan padded in the preview and not on the page is a chip wider
    // than the reference's. Measured on this reference, both are 5.25pt.
    expect(
      Math.abs(preview.header.widthPt - chip.widthPt),
      `preview chip ${preview.header.widthPt.toFixed(2)}pt, page ${chip.widthPt.toFixed(2)}pt`,
    ).toBeLessThanOrEqual(PRINT_FIDELITY_TOLERANCE.geometryPt);

    // Nothing behind the monospaced cell, and `rgba(0, 0, 0, 0)` is how a computed style spells that.
    expect(preview.monospaced.background, 'and paints nothing behind the monospaced cell').toBe(
      'rgba(0, 0, 0, 0)',
    );
    // …at the advance of the run the page sets there and no wider, which is the same `padding-inline`
    // claim on the side of the pair that has no chip to read it off. Measured: 31.5pt on both.
    expect(
      Math.abs(preview.monospaced.widthPt - madeMonospaced.widthPt),
      `preview cell text ${preview.monospaced.widthPt.toFixed(2)}pt, page run ${madeMonospaced.widthPt.toFixed(2)}pt`,
    ).toBeLessThanOrEqual(PRINT_FIDELITY_TOLERANCE.geometryPt);
  });

  test('the reset a monospaced cell gets names the two declarations the chip’s outline is drawn with', async ({
    page,
  }) => {
    // NOT a fidelity comparison, and the only check in this file that is not. The chip's OUTLINE and
    // its rounded corner need a reference that draws both a codespan outline and a header column, and
    // no committed fixture carries the pair: `inline-context-styled` is the one anchor with a
    // `[cols="1h,3"]` column and its theme gives the codespan a fill and nothing else, so its
    // reference draws no outline behind anything. The check above holds the fill, the extent and the
    // absence against that reference; this holds only what is left, on a document written here.
    //
    // What is left is worth a check because the reset once named neither declaration that draws it.
    // The chip is a `box-shadow` spread and a `border-radius` — never a `border` — and the advance is
    // `padding-inline`, never a margin; the reset spelled `border-width` and `margin-inline`, two
    // declarations that could not have done anything, while the two that draw the outline were left
    // alone (`print-preview.css:2047-2053`). A theme with a non-zero `codespan.border-width` then drew
    // a chip outline around a whole `m` cell's text, which the `:monospaced` branch — family, size and
    // colour, and nothing else — never draws.
    const source = [
      '= Doc',
      '',
      '[cols="1h,3"]',
      '|===',
      '| `d` | The header column, carrying a codespan an author wrote.',
      '|===',
      '',
      '[cols="1m,3"]',
      '|===',
      '| d | The monospaced column, whose whole cell the renderer sets in mono.',
      '|===',
      '',
    ].join('\n');
    await preparePrintDocument(
      page,
      {
        source,
        // A codespan with an OUTLINE as well as a fill, which is the one thing this document has that
        // no anchor fixture does.
        themeText:
          'extends: default\ncodespan:\n  background-color: F4F6F8\n  border-color: C9D0D7\n  border-width: 1\n  border-radius: 2\n',
      },
      // Through the SHIPPING worker, so the `monospaced` mark on the paragraph is the one the
      // application writes. It used to be applied here by a re-statement of the worker's rule, which
      // is a second copy of the thing the stylesheet depends on.
      await renderSourceWithWorker(source),
    );

    const cells = await page.evaluate(() =>
      Object.fromEntries(
        (
          [
            ['header', 'table:nth-of-type(1) th.tableblock > p.tableblock.monospaced > code'],
            ['monospaced', 'table:nth-of-type(2) td.tableblock > p.tableblock.monospaced > code'],
          ] as const
        ).map(([which, selector]) => {
          const element = document.querySelector(`[data-testid="page"] ${selector}`);
          if (element === null) return [which, null];
          const style = getComputedStyle(element);
          return [which, { outline: style.boxShadow, radius: style.borderTopLeftRadius }];
        }),
      ),
    );

    expect(cells.monospaced, 'the preview lays out a monospaced column').not.toBeNull();
    expect(cells.header, 'the preview lays out a header column with a codespan in it').not.toBeNull();
    // The authored codespan really is outlined and rounded under this theme — asserted first, because
    // without it the two below hold on a stylesheet that draws no chip outline at all.
    expect(cells.header?.outline, 'the theme outlines an authored codespan').not.toBe('none');
    expect(cells.header?.radius, 'and rounds it').not.toBe('0px');
    // And the cell the `m` column made monospaced has neither.
    expect(cells.monospaced?.outline).toBe('none');
    expect(cells.monospaced?.radius).toBe('0px');
  });

  // The line box a MONOSPACED cell is set in used to be asserted here, against the projection's own
  // `--print-codespan-line-height`. It has moved to `print-table-cells.spec.ts`, where the reference
  // can answer: this fixture's monospaced cells each hold one line, so nothing on its page witnesses
  // the box at all, and the comparison was a round trip through a value the harness had just set.

  test("an admonition's content is inset on both sides, as the page insets it", async ({ page }) => {
    // `convert_admonition` opens with `pad_box [0, cpad[1], 0, lpad[3]]` — the right inset is taken
    // from the whole block before the label column is even measured — and then insets the content
    // again by the label's width and the paddings around it. A right inset left at zero runs every
    // admonition a full `admonition.padding` wider than the export sets it, which changes where every
    // one of its lines breaks.
    const fixture = readFixture(FIXTURE);
    await preparePrintPage(page, fixture);
    const admonition = runsOfParagraph(await textRuns(fixture.referencePdf), 'An admonition whose content');
    expect(admonition.length, 'the reference sets the admonition over several lines').toBeGreaterThan(2);
    const pageLeftPt = Math.min(...admonition.map((run) => run.xPt));
    const pageRightPt = Math.max(...admonition.map((run) => run.xPt + run.widthPt));

    const preview = await page.evaluate((perPoint) => {
      const cell = document.querySelector('[data-testid="page"] .admonitionblock td.content');
      const column = document.querySelector('[data-testid="page"]');
      if (cell === null || column === null) return null;
      const style = getComputedStyle(cell);
      const box = cell.getBoundingClientRect();
      const origin = column.getBoundingClientRect().left;
      return {
        leftPt: (box.left - origin + Number.parseFloat(style.paddingLeft)) / perPoint,
        rightPt: (box.right - origin - Number.parseFloat(style.paddingRight)) / perPoint,
      };
    }, PIXELS_PER_POINT);

    expect(preview, 'the preview lays the admonition out').not.toBeNull();
    if (preview === null) return;
    expect(
      Math.abs(preview.leftPt - pageLeftPt),
      `preview insets the content to ${preview.leftPt.toFixed(2)}pt, page ${pageLeftPt.toFixed(2)}pt`,
    ).toBeLessThanOrEqual(PRINT_FIDELITY_TOLERANCE.geometryPt);
    // The document's text is justified, so a full line of the admonition ends exactly at the measure's
    // right edge; the widest of them is that edge.
    expect(
      Math.abs(preview.rightPt - pageRightPt),
      `preview ends the measure at ${preview.rightPt.toFixed(2)}pt, page ${pageRightPt.toFixed(2)}pt`,
    ).toBeLessThanOrEqual(PRINT_FIDELITY_TOLERANCE.geometryPt);
  });

  test("an admonition's column rule is the width the theme sets, on the boundary", async ({ page }) => {
    // `stroke_vertical_rule` draws it centred on the boundary between the label column and the
    // content, with square ends and taking no room. Drawn as this cell's left border it was neither:
    // a border sits outside the padding, and a browser floors `border-width` to a whole CSS pixel, so
    // the theme's 2pt rule came out 2px — a quarter thin — and half a pixel off the boundary.
    const fixture = readFixture(FIXTURE);
    const prepared = await preparePrintPage(page, fixture);
    const rule = colourOf(prepared.cssProperties['--print-admonition-column-rule-color'], 'the admonition column rule colour');

    // What the reference DECLARED the rule to be. This used to be
    // `--print-admonition-column-rule-width` off the projection — and `print-preview.css` sets the
    // `::before`'s width to `var(--print-admonition-column-rule-width, …)`, so the comparison under it
    // read one value out of the projection, back out of the computed style, and compared it to itself.
    // It could only have failed if the stylesheet stopped reading the property, which the
    // reference-anchored comparison below already covers; a projection that emitted 1.6pt for a 2pt
    // theme passed it exactly.
    const allStroked = await strokedPaths(fixture.referencePdf);
    const stroked = allStroked.filter((stroke) => sameColour(stroke.colour, rule));
    expect(stroked.length, 'the reference strokes the admonition column rule').toBe(1);
    const declaredPt = stroked[0].lineWidthPt;

    const [raster] = pageRasters(fixture.referencePdf, DPI);
    const box = boxOfColour(raster, rule);
    expect(box, 'the reference strokes the column rule').not.toBeNull();
    if (box === null) return;
    // Across the middle of the rule, so the scan line is clear of its ends.
    const section = strokeAcross(
      raster,
      (box.topPt + box.bottomPt) / 2,
      rule,
      box.leftPt - 4,
      box.rightPt + 4,
    );

    const preview = await page.evaluate((perPoint) => {
      const cell = document.querySelector('[data-testid="page"] .admonitionblock td.content');
      const column = document.querySelector('[data-testid="page"]');
      if (cell === null || column === null) return null;
      const style = getComputedStyle(cell, '::before');
      const origin = column.getBoundingClientRect().left;
      const width = Number.parseFloat(style.width);
      return {
        widthPt: width / perPoint,
        // The rule is centred on the cell's own left edge, which is the boundary the renderer strokes.
        centrePt: (cell.getBoundingClientRect().left - origin) / perPoint,
        colour: style.backgroundColor,
      };
    }, PIXELS_PER_POINT);

    expect(preview, 'the preview draws the rule').not.toBeNull();
    if (preview === null) return;
    expect(preview.colour).toBe(`rgb(${rule.join(', ')})`);
    expect(
      Math.abs(preview.widthPt - section.widthPt),
      `preview rule ${preview.widthPt.toFixed(2)}pt, page ${section.widthPt.toFixed(2)}pt`,
    ).toBeLessThanOrEqual(PRINT_FIDELITY_TOLERANCE.geometryPt);
    // …and it is the width the reference asked for rather than a rounding of it, held to what two
    // declarations owe each other. The raster comparison above is half a point wide because a raster
    // cannot be read closer than that; this one has no such excuse.
    expect(
      Math.abs(preview.widthPt - declaredPt),
      `preview rule ${preview.widthPt.toFixed(3)}pt, reference declares ${declaredPt.toFixed(3)}pt`,
    ).toBeLessThanOrEqual(RULE_WIDTH_TOLERANCE_PT);
    expect(
      Math.abs(preview.centrePt - section.centrePt),
      `preview centres it at ${preview.centrePt.toFixed(2)}pt, page ${section.centrePt.toFixed(2)}pt`,
    ).toBeLessThanOrEqual(PRINT_FIDELITY_TOLERANCE.geometryPt);
  });

  test('a padded block ends one padding under its last line, with nothing between', async ({ page }) => {
    // `next_enclosed_block` returns nil for the last child of an enclosing block, and `theme_margin`
    // then moves the cursor by nothing at all — so a sidebar's box closes one padding under its last
    // line. In CSS the paragraph's own bottom margin falls INSIDE the padding box and simply adds to
    // the padding, which made every padded block a full paragraph gap too tall.
    const fixture = readFixture(FIXTURE);
    const prepared = await preparePrintPage(page, fixture);
    const fill = colourOf(prepared.cssProperties['--print-sidebar-background-color'], 'the sidebar fill');

    const [raster] = pageRasters(fixture.referencePdf, DPI);
    const box = boxOfColour(raster, fill);
    expect(box, 'the reference fills the sidebar').not.toBeNull();
    if (box === null) return;

    const preview = await page.evaluate((perPoint) => {
      const sidebar = document.querySelector('[data-testid="page"] .sidebarblock');
      if (sidebar === null) return null;
      const style = getComputedStyle(sidebar);
      const box_ = sidebar.getBoundingClientRect();
      // The PADDING box: everything inside the rule, which is the part of the block the renderer's own
      // box is. A border occupies room in CSS and is floored to a whole pixel with it, so a border box
      // would put the browser's rounding of a hairline into a measurement about paragraph spacing.
      return {
        heightPt:
          (box_.height -
            Number.parseFloat(style.borderTopWidth) -
            Number.parseFloat(style.borderBottomWidth)) /
          perPoint,
      };
    }, PIXELS_PER_POINT);

    expect(preview, 'the preview lays the sidebar out').not.toBeNull();
    if (preview === null) return;
    // The fill measured above is what is left of the block after its own rule is stroked over it: the
    // renderer centres that stroke on the box's edge, so half of it covers the fill at the top and half
    // at the bottom. Adding one width back gives the box the renderer laid out.
    const borderPt =
      Number.parseFloat(prepared.cssProperties['--print-sidebar-border-width'] ?? '0') / PIXELS_PER_POINT;
    const pageHeightPt = box.bottomPt - box.topPt + borderPt;
    expect(
      Math.abs(preview.heightPt - pageHeightPt),
      `preview sidebar ${preview.heightPt.toFixed(2)}pt tall inside its rule, page ${pageHeightPt.toFixed(2)}pt`,
    ).toBeLessThanOrEqual(PRINT_FIDELITY_TOLERANCE.geometryPt + RASTER_PIXEL_PT);
  });

  test('a thematic break has the air under it that the page gives it', async ({ page }) => {
    // `convert_thematic_break` pads down, strokes, pads down again — and THEN takes a block margin
    // outside the padded box. The block margin was missing here, leaving a rule with barely half the
    // air under it that the export gives it. The space above is the block before it plus the padding,
    // added rather than collapsed, which is the other half of the same correction.
    //
    // The rule's own weight is not compared. It is drawn as a border so that a theme's
    // `thematic_break.border-style` — dashed, dotted, double — still means something, and a browser
    // floors a border to a whole CSS pixel; the other rules in this file are drawn boxes precisely
    // because they carry no style for that rounding to cost.
    const fixture = readFixture(FIXTURE);
    const prepared = await preparePrintPage(page, fixture);
    const colour = colourOf(prepared.cssProperties['--print-thematic-break-border-color'], 'the thematic break colour');

    const [raster] = pageRasters(fixture.referencePdf, DPI);
    const box = boxOfColour(raster, colour);
    expect(box, 'the reference strokes the thematic break').not.toBeNull();
    if (box === null) return;
    const rulePt = (box.topPt + box.bottomPt) / 2;

    // What is above the break is measured to the previous BLOCK's edge rather than to its last
    // baseline, and what is below to the next line's baseline. The break sits between a padded block
    // and a paragraph, and the distance from a last line's baseline to the bottom of the box holding
    // it is decided by the line model rather than by anything the break does — prawn's final gap on
    // one side, the browser's half-leading and descent on the other, a point and a bit apart. Measuring
    // from the block's own edge asks only about the space the break itself opens, which is the whole
    // subject here.
    const sidebar = boxOfColour(raster, colourOf(prepared.cssProperties['--print-sidebar-background-color'], 'the sidebar fill'));
    expect(sidebar, 'the reference fills the block above the break').not.toBeNull();
    if (sidebar === null) return;

    const runs = await textRuns(fixture.referencePdf);
    const closing = runsOfParagraph(runs, 'The closing paragraph');
    expect(closing.length, 'the reference sets the paragraph under the break').toBeGreaterThan(0);
    // The text layer measures from the bottom of the page; the raster from the top.
    const pageHeightPt = (raster.heightPx * 72) / raster.dpi;
    const below = pageHeightPt - Math.max(...closing.map((run) => run.yPt));

    const preview = await page.evaluate((perPoint) => {
      const hr = document.querySelector('[data-testid="page"] hr');
      const above_ = document.querySelector('[data-testid="page"] .sidebarblock');
      const column = document.querySelector('[data-testid="page"]');
      if (hr === null || above_ === null || column === null) return null;
      const origin = column.getBoundingClientRect().top;
      const width = Number.parseFloat(getComputedStyle(hr).borderBottomWidth);
      return {
        rulePt: (hr.getBoundingClientRect().bottom - origin - width / 2) / perPoint,
        abovePt: (above_.getBoundingClientRect().bottom - origin) / perPoint,
      };
    }, PIXELS_PER_POINT);

    expect(preview, 'the preview draws the thematic break').not.toBeNull();
    if (preview === null) return;

    const firstBelow = await baselinesOf(page, 'hr + .paragraph p');

    // The fill is measured inside the block's stroked border, which the renderer draws centred on the
    // box's own edge; the preview's border box holds a whole border.
    const borderPt =
      Number.parseFloat(prepared.cssProperties['--print-sidebar-border-width'] ?? '0') / PIXELS_PER_POINT;
    const pageAbovePt = rulePt - (sidebar.bottomPt + borderPt / 2);
    expect(
      Math.abs(preview.rulePt - preview.abovePt - pageAbovePt),
      `preview leaves ${(preview.rulePt - preview.abovePt).toFixed(2)}pt above the rule, page ${pageAbovePt.toFixed(2)}pt`,
    ).toBeLessThanOrEqual(PRINT_FIDELITY_TOLERANCE.geometryPt + RASTER_PIXEL_PT);
    expect(
      Math.abs(firstBelow[0] - preview.rulePt - (below - rulePt)),
      `preview leaves ${(firstBelow[0] - preview.rulePt).toFixed(2)}pt under the rule, page ${(below - rulePt).toFixed(2)}pt`,
    ).toBeLessThanOrEqual(PRINT_FIDELITY_TOLERANCE.geometryPt + RASTER_PIXEL_PT);
  });
});
