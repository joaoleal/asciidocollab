/**
 * @file What happens INSIDE a table: where a cell's text sits, the face a literal cell is set in,
 * the band painted across a footer row, and how wide each column is allowed to be.
 *
 * The anchor beside this one measures a table's FRAME — its outer border, its grid, the rule under a
 * header row — and it passed throughout while every property measured here was wrong. That is not a
 * coincidence: a frame is one statement about a whole table, while each of these is decided per cell
 * or per column, and nothing that looks at a table as a whole can see any of them. Measured before
 * the rules that fix them existed, on this fixture: every cell's text sat at its left padding edge
 * with `text-align: justify` and `vertical-align: top`, whatever its column specifier said; a literal
 * cell fell back to the reader's system `monospace` at the body's size; a footer row's fill was
 * `rgba(0, 0, 0, 0)`; and eight columns of equal weight came out as seven at 59.4pt and the literal
 * one at 82.4pt, against eight of 62.35pt on the page.
 *
 * HOW A POSITION IS COMPARED, and why never as an absolute. The two media do not spend a collapsed
 * border alike: Chromium quantises the theme's 0.5pt grid up to a whole CSS pixel and takes it out of
 * the columns, while prawn strokes it centred on an edge that costs the cell nothing. Every cell in a
 * bordered table is therefore about three quarters of a point right of where the page puts it, and a
 * comparison of absolute positions would be measuring that rather than the alignment under test. So
 * each measurement below is an offset WITHIN one column, taken the same way on both sides: the
 * fixture's first two rows are left-aligned and right-aligned throughout, which makes each column's
 * two content edges readable in either medium as the position of a run of text, and everything else
 * is stated against those. The two comparisons that cannot avoid crossing a border say so and carry
 * the preview's own computed border width as their allowance.
 *
 * WHAT THE REFERENCE SUPPLIES. Every number compared against is read out of the committed reference
 * PDF at run time — the face it names, the colour it fills with, the rectangle it paints, the position
 * of every run. Nothing here restates a theme value or an engine constant as a literal, so a change
 * to either shows up as a changed reference rather than as a spec that still passes against a number
 * nobody re-derived.
 */

import { expect, test, type Page } from '@playwright/test';
import {
  PRINT_FIDELITY_TOLERANCE,
  drawnRuns,
  paintedBoxes,
  sameColour,
  textRuns,
  type Rgb,
} from '../harness/pdftools';
import {
  PIXELS_PER_POINT,
  colourOf,
  normaliseFamily,
  preparePrintPage,
  readFixture,
  renderWithWorker,
} from './harness';

/** The fixture this file is about, and the only one that carries every construct it measures. */
const FIXTURE = 'table-cells';

/** The tall cell's whole text, which is how it is found on either side. */
const TALL_CELL =
  'cinder marble ripple candle timber pebble willow socket ribbon garden hollow minnow';

/** The AsciiDoc cell's whole text, with the typographic quotes Asciidoctor substitutes. */
const ASCIIDOC_CELL =
  'An AsciiDoc cell holds a whole document of its own, and a left-aligned one is inked at the page’s own alignment rather than flush left, which this theme justifies.';

/** The plain cell beside it. */
const PLAIN_CELL =
  'A plain cell holds a run of text, and a left-aligned one is inked flush left however the page is set, so its lines end wherever the words do.';

/**
 * One laid-out line, as either medium reports it.
 *
 * Two edges and nothing else, because that is all both media can report the same way: the preview's
 * side comes from the line boxes the browser produced, which carry no text of their own.
 */
interface Line {
  /** Left edge in points, from the page's own left edge. */
  readonly leftPt: number;
  /** Right edge in points. */
  readonly rightPt: number;
}

/** A reference line, with the text, page and baseline that place it. */
interface ReferenceLine extends Line {
  /** The line's text, trimmed. */
  readonly text: string;
  /** 1-based page. */
  readonly page: number;
  /** Baseline in points from the page's BOTTOM, which is the coordinate system the file uses. */
  readonly baselinePt: number;
}

/**
 * The reference's laid-out lines.
 *
 * One entry per run, not per baseline: a table row's cells share a baseline, so grouping by baseline
 * would fold a whole row into one line and every column measurement with it. pdf.js already reports
 * one item per cell-line for this document, and the one place it merges two neighbouring cells — the
 * autowidth table's first row, whose cells are six points apart — is a row this file does not use.
 *
 * @param bytes - The reference PDF's bytes.
 * @returns One entry per laid-out line, in page order.
 */
async function referenceLines(bytes: Uint8Array): Promise<ReferenceLine[]> {
  const runs = await textRuns(bytes);
  return runs
    .filter((run) => run.text.trim() !== '')
    .map((run) => ({
      page: run.page,
      baselinePt: run.yPt,
      text: run.text.trim(),
      leftPt: run.xPt,
      rightPt: run.xPt + run.widthPt,
    }));
}

/** The one reference line reading exactly `text`, failing loudly when it is not unique. */
function referenceLine(lines: readonly ReferenceLine[], text: string): ReferenceLine {
  const found = lines.filter((line) => line.text === text);
  expect(found, `the reference has exactly one line reading "${text}"`).toHaveLength(1);
  return found[0];
}

/**
 * The preview's laid-out lines for the cell whose whole text is `text`.
 *
 * Read from the line boxes the browser produced rather than from the cell's own box: a cell's box
 * says how wide the COLUMN is, and every measurement here is about where within that column the ink
 * landed. Rectangles sharing a top belong to one line however many text nodes made it.
 *
 * @param page - The browser page.
 * @param text - The cell's text, whitespace collapsed.
 * @returns One entry per laid-out line, top to bottom.
 */
async function previewLines(page: Page, text: string): Promise<Line[]> {
  return page.evaluate(
    ({ needle, perPoint }) => {
      const root = document.querySelector('[data-testid="page"]');
      if (!(root instanceof HTMLElement)) throw new Error('the page has no column');
      const origin = root.getBoundingClientRect();
      const cell = [...root.querySelectorAll('td.tableblock, th.tableblock')].find(
        (candidate) => (candidate.textContent ?? '').replaceAll(/\s+/g, ' ').trim() === needle,
      );
      if (cell === undefined) throw new Error(`the preview has no cell reading "${needle}"`);

      const walker = document.createTreeWalker(cell, NodeFilter.SHOW_TEXT);
      const rectangles: { leftPt: number; rightPt: number; top: number }[] = [];
      for (let node = walker.nextNode(); node !== null; node = walker.nextNode()) {
        if ((node.textContent ?? '').trim() === '') continue;
        const range = document.createRange();
        range.selectNodeContents(node);
        for (const rect of range.getClientRects()) {
          if (rect.height > 0 && rect.width > 0) {
            rectangles.push({
              leftPt: (rect.left - origin.left) / perPoint,
              rightPt: (rect.right - origin.left) / perPoint,
              top: rect.top,
            });
          }
        }
      }

      const lines: { leftPt: number; rightPt: number; top: number }[] = [];
      for (const rect of rectangles.toSorted((a, b) => a.top - b.top || a.leftPt - b.leftPt)) {
        const current = lines.at(-1);
        if (current === undefined || rect.top - current.top > 1) {
          lines.push({ leftPt: rect.leftPt, rightPt: rect.rightPt, top: rect.top });
        } else {
          current.rightPt = Math.max(current.rightPt, rect.rightPt);
          current.leftPt = Math.min(current.leftPt, rect.leftPt);
        }
      }
      return lines.map(({ leftPt, rightPt }) => ({ leftPt, rightPt }));
    },
    { needle: text, perPoint: PIXELS_PER_POINT },
  );
}

/**
 * The FIRST laid-out line of the cell whose whole text is `text`.
 *
 * The one every horizontal comparison wants: a reference cell holds one line, and a cell that holds
 * several is asked for its first.
 *
 * @param page - The browser page.
 * @param text - The cell's text, whitespace collapsed.
 * @returns The first line.
 */
async function previewFirstLine(page: Page, text: string): Promise<Line> {
  const lines = await previewLines(page, text);
  return lines[0];
}

/** The right edges of every line but the last, which no alignment stretches. */
function fullLineRights(all: readonly Line[]): number[] {
  return all.slice(0, -1).map((line) => line.rightPt);
}

/** How far apart the widest and the narrowest of a set of measurements are. */
function spread(values: readonly number[]): number {
  return Math.max(...values) - Math.min(...values);
}

/** How far a run's own centre sits from the centre of the two edges around it. */
function centreOffset(text: Line, edges: readonly number[]): number {
  return (text.leftPt + text.rightPt) / 2 - (edges[0] + edges[1]) / 2;
}

/** The pitch from each column's content edge to the next, in reading order. */
function pitches(starts: readonly number[]): number[] {
  return starts.slice(1).map((start, index) => start - starts[index]);
}

/**
 * Where the FIRST line of the cell reading `text` sits, in points from the top of the page column.
 *
 * A baseline, measured rather than derived: a zero-sized inline-block placed at the very start of the
 * cell's block takes its baseline from its own bottom margin edge, so it reports that line's baseline
 * exactly, whatever the face, the size or the browser's rounding did to the line box. Comparing an
 * ink-box top against the PDF's baseline would bias every cross-size comparison by an ascent — and it
 * is inside the block, so a paint offset applied to the block moves it too, which is the point.
 *
 * @param page - The browser page.
 * @param text - The cell's text, whitespace collapsed.
 * @returns The first line's baseline in points.
 */
async function previewBaseline(page: Page, text: string): Promise<number> {
  return page.evaluate(
    ({ needle, perPoint }) => {
      const root = document.querySelector('[data-testid="page"]');
      if (!(root instanceof HTMLElement)) throw new Error('the page has no column');
      const cell = [...root.querySelectorAll('td.tableblock, th.tableblock')].find(
        (candidate) => (candidate.textContent ?? '').replaceAll(/\s+/g, ' ').trim() === needle,
      );
      if (cell === undefined) throw new Error(`the preview has no cell reading "${needle}"`);
      const block = cell.firstElementChild;
      if (!(block instanceof HTMLElement)) throw new Error(`the cell reading "${needle}" holds no block`);
      const probe = document.createElement('span');
      probe.style.cssText = 'display:inline-block;width:0;height:0;overflow:hidden';
      block.insertBefore(probe, block.firstChild);
      const baseline = probe.getBoundingClientRect().bottom - root.getBoundingClientRect().top;
      probe.remove();
      return baseline / perPoint;
    },
    { needle: text, perPoint: PIXELS_PER_POINT },
  );
}

/**
 * How wide one collapsed cell border is in the preview, in points.
 *
 * Read from the page rather than written down, because it is a QUANTISATION of the theme's value
 * rather than the value: Chromium rounds a border width to a whole CSS pixel, so the theme's 0.5pt
 * grid is drawn 0.75pt wide, and it takes that out of the columns where prawn's stroke costs them
 * nothing. It is the allowance for the two comparisons below that cannot avoid crossing one.
 *
 * @param page - The browser page.
 * @returns The used border width in points.
 */
async function collapsedBorderPt(page: Page): Promise<number> {
  return page.evaluate((perPoint) => {
    const cell = document.querySelector('[data-testid="page"] table.tableblock tbody td.tableblock');
    if (cell === null) throw new Error('the preview has no body cell');
    const style = getComputedStyle(cell);
    return (
      Math.max(
        ...[style.borderTopWidth, style.borderRightWidth, style.borderBottomWidth, style.borderLeftWidth].map(
          (value) => Number.parseFloat(value),
        ),
      ) / perPoint
    );
  }, PIXELS_PER_POINT);
}


/**
 * Assert that the preview and the reference report one quantity as the same number.
 *
 * @param what - What is being compared, for the failure message.
 * @param preview - The preview's measurement, in points.
 * @param reference - The reference's, in points.
 * @param tolerancePt - How far apart they may be; the suite's shared geometry tolerance by default.
 */
function agree(what: string, preview: number, reference: number, tolerancePt = PRINT_FIDELITY_TOLERANCE.geometryPt): void {
  expect(
    Math.abs(preview - reference),
    `${what}: preview ${preview.toFixed(3)}pt, reference ${reference.toFixed(3)}pt`,
  ).toBeLessThanOrEqual(tolerancePt);
}

/**
 * How far apart two measurements of one distance may be, when the distance itself is small.
 *
 * The suite's geometry tolerance is a statement about the instruments — half a point is below what
 * any display resolves — and it is the right bound for a comparison whose subject is many times it.
 * It is the wrong bound for one whose subject is half a point: `|preview - 0.50| <= 0.5` is
 * satisfied by a preview that measured ZERO, so the comparison passes for the case it exists to
 * catch. A bound is only a bound if the signal has to survive it.
 *
 * Half the signal is the rule: a preview that reported nothing at all is then two tolerances out and
 * fails, while a preview that reported the signal has as much room as the smaller of the two numbers
 * allows. It never LOOSENS anything — the shared tolerance is still the ceiling.
 *
 * @param signalPt - The quantity the reference says is there, in points.
 * @returns The bound to hold the comparison to.
 */
function boundFor(signalPt: number): number {
  return Math.min(PRINT_FIDELITY_TOLERANCE.geometryPt, Math.abs(signalPt) / 2);
}

const fixture = readFixture(FIXTURE);

test.describe('a cell is aligned the way its specifier says', () => {
  test('a left-aligned cell is set flush left, not at the page’s justified measure', async ({ page }) => {
    const lines = await referenceLines(fixture.referencePdf);
    const columnLeft = referenceLine(lines, 'leftA').leftPt;
    // The tall cell's own lines: everything in column one between the right-aligned reference row and
    // the flat row. Found by position rather than by text, so the reference decides where it breaks.
    const referenceTall = lines
      .filter(
        (line) =>
          line.page === referenceLine(lines, 'leftA').page &&
          Math.abs(line.leftPt - columnLeft) < 0.1 &&
          line.baselinePt < referenceLine(lines, 'rightA').baselinePt &&
          line.baselinePt > referenceLine(lines, 'flatA').baselinePt,
      )
      .toSorted((a, b) => b.baselinePt - a.baselinePt);
    expect(referenceTall.length, 'the reference sets the tall cell on several lines').toBeGreaterThan(3);
    // The claim itself: a left-aligned cell is NOT justified, so its full lines end at different
    // places. `convert_table` hands prawn-table `align: :left` and prawn puts a left line at the box's
    // left edge with nothing stretched, however the page's own `base.text-align` is set.
    const referenceFullRights = referenceTall.slice(0, -1).map((line) => line.rightPt);
    expect(
      Math.max(...referenceFullRights) - Math.min(...referenceFullRights),
      'the reference leaves the tall cell ragged rather than justifying it',
    ).toBeGreaterThan(1);

    await preparePrintPage(page, fixture);
    const previewColumn = await previewFirstLine(page, 'leftA');
    const previewColumnLeft = previewColumn.leftPt;
    const previewTall = await previewLines(page, TALL_CELL);
    expect(previewTall, 'the preview breaks the tall cell where the reference breaks it').toHaveLength(
      referenceTall.length,
    );
    for (const [index, line] of referenceTall.entries()) {
      agree(
        `line ${String(index + 1)} of the tall cell ends`,
        previewTall[index].rightPt - previewColumnLeft,
        line.rightPt - columnLeft,
      );
    }
  });

  test('a centred cell is centred in its column', async ({ page }) => {
    const lines = await referenceLines(fixture.referencePdf);
    const referenceEdges = [referenceLine(lines, 'leftB').leftPt, referenceLine(lines, 'rightB').rightPt];
    const referenceText = referenceLine(lines, 'centred');

    await preparePrintPage(page, fixture);
    const previewLeft = await previewFirstLine(page, 'leftB');
    const previewRight = await previewFirstLine(page, 'rightB');
    const previewEdges = [previewLeft.leftPt, previewRight.rightPt];
    const previewText = await previewFirstLine(page, 'centred');

    agree(
      'the centred cell’s centre',
      centreOffset(previewText, previewEdges),
      centreOffset(referenceText, referenceEdges),
    );
  });

  test('a right-aligned cell ends where its column ends', async ({ page }) => {
    const lines = await referenceLines(fixture.referencePdf);
    // The reference row is right-aligned by its own cell specifier and the cell under test by a
    // different one, so this asks whether the two spellings put a line in the same place — which is
    // the whole of right alignment once the column's far edge is what the reference row reports.
    const reference = referenceLine(lines, 'rightC').rightPt - referenceLine(lines, 'righted').rightPt;
    expect(reference, 'the reference ends both right-aligned cells together').toBeCloseTo(0, 1);

    await preparePrintPage(page, fixture);
    const previewEdge = await previewFirstLine(page, 'rightC');
    const previewText = await previewFirstLine(page, 'righted');
    const preview = previewEdge.rightPt - previewText.rightPt;
    agree('the right-aligned cell’s far edge', preview, reference);
  });

  test('a middle- and a bottom-aligned cell are offset down their row, tall and flat', async ({ page }) => {
    // WHAT EACH OF THE TWO ROWS CAN WITNESS, because they are not the same claim and this used to
    // read as though they were.
    //
    // The TALL row is the one that says vertical alignment happens at all. Its first cell wraps onto
    // several lines while its neighbours hold one, so `vertical-align` has a real distance to move
    // them down: measured on this reference, a middle-aligned cell sits 39.95pt below the row's top
    // line and a bottom-aligned one 79.90pt. A preview applying no vertical alignment puts all three
    // level and misses by the whole of that.
    //
    // The FLAT row cannot say that, and cannot be made to. Every cell in it holds one line, so the
    // row is exactly one line tall and there is nothing for `vertical-align` to move — what the
    // reference offsets those two cells by is prawn-table's FPTolerance and nothing else: `Cell#draw`
    // opens the text box a whole point taller than the content box (`prawn-table/cell.rb:428-429`,
    // `FPTolerance = 1` at `:200`), and a middle cell is dropped by half of it and a bottom cell by
    // all of it. Measured: 0.50pt and 1.00pt exactly, which is what the stylesheet reproduces as
    // paint (`print-preview.css:2049-2059`).
    //
    // So the flat row's middle arm is a 0.50pt signal, and the suite's shared 0.5pt geometry
    // tolerance is the whole of it: held at that, `|0 - 0.50| <= 0.5` passes. Demonstrated by
    // forcing the flat row's two cells back to `vertical-align: top` with their paint offset zeroed
    // — the offset a preview that reproduced none of this would produce — the middle arm went green
    // on `preview 0.000pt, reference 0.500pt` and only the bottom arm noticed, because its signal is
    // a whole point. A defect confined to the middle case would have passed here in silence.
    //
    // A comparison may not be given more slack than half of what it measures, or it cannot tell the
    // measurement from nothing. That is what `boundFor` enforces, and it is why the flat row's two
    // arms are held to 0.25pt and 0.50pt while the tall row's stay at the shared tolerance. There is
    // room for it: the preview reproduces the reference to 0.0008pt in the tall row and 0.0078pt in
    // the flat one, and under the mutation above the middle arm now fails on 0.5 against 0.25.
    const lines = await referenceLines(fixture.referencePdf);
    const tallFirstLine = lines
      .filter(
        (line) =>
          Math.abs(line.leftPt - referenceLine(lines, 'leftA').leftPt) < 0.1 &&
          line.baselinePt < referenceLine(lines, 'rightA').baselinePt &&
          line.baselinePt > referenceLine(lines, 'flatA').baselinePt,
      )
      .toSorted((a, b) => b.baselinePt - a.baselinePt)[0];

    await preparePrintPage(page, fixture);
    for (const [row, top, previewTop, middle, bottom] of [
      ['tall', tallFirstLine, TALL_CELL, 'middled', 'bottomed'],
      ['flat', referenceLine(lines, 'flatA'), 'flatA', 'flatB', 'flatC'],
    ] as const) {
      // The PDF's y grows upward, so a cell drawn lower has the SMALLER baseline.
      const referenceMiddle = top.baselinePt - referenceLine(lines, middle).baselinePt;
      const referenceBottom = top.baselinePt - referenceLine(lines, bottom).baselinePt;
      expect(referenceBottom, 'the reference offsets a bottom cell twice as far as a middle one').toBeCloseTo(
        referenceMiddle * 2,
        1,
      );

      const previewTopBaseline = await previewBaseline(page, previewTop);
      agree(
        `a middle-aligned cell in the ${row} row`,
        (await previewBaseline(page, middle)) - previewTopBaseline,
        referenceMiddle,
        boundFor(referenceMiddle),
      );
      agree(
        `a bottom-aligned cell in the ${row} row`,
        (await previewBaseline(page, bottom)) - previewTopBaseline,
        referenceBottom,
        boundFor(referenceBottom),
      );
    }
  });

  test('an AsciiDoc cell keeps the page’s alignment where a plain cell does not', async ({ page }) => {
    const lines = await referenceLines(fixture.referencePdf);

    // `Cell::AsciiDoc#apply_font_properties` overrides `@base_text_align` only for a centred or a
    // right-aligned cell, so a LEFT one is inked at whatever the page is set to — justified, under
    // this theme. The reference says so plainly: the cell's full lines all end at one place.
    const asciidocSection = lines.filter(
      (line) =>
        line.page === referenceLine(lines, 'A footer row').page &&
        line.baselinePt < referenceLine(lines, 'An AsciiDoc cell keeps the page’s alignment').baselinePt &&
        line.baselinePt > referenceLine(lines, 'A footer row').baselinePt,
    );
    const leftmost = Math.min(...asciidocSection.map((line) => line.leftPt));
    const referenceAsciidoc = asciidocSection
      .filter((line) => Math.abs(line.leftPt - leftmost) < 0.1)
      .toSorted((a, b) => b.baselinePt - a.baselinePt);
    expect(referenceAsciidoc.length, 'the reference sets the AsciiDoc cell on several lines').toBeGreaterThan(2);
    expect(
      spread(fullLineRights(referenceAsciidoc)),
      'the reference justifies the AsciiDoc cell',
    ).toBeLessThan(PRINT_FIDELITY_TOLERANCE.geometryPt);

    await preparePrintPage(page, fixture);
    const previewAsciidoc = await previewLines(page, ASCIIDOC_CELL);
    expect(previewAsciidoc).toHaveLength(referenceAsciidoc.length);
    expect(spread(fullLineRights(previewAsciidoc)), 'the preview justifies it too').toBeLessThan(
      PRINT_FIDELITY_TOLERANCE.geometryPt,
    );
    expect(
      spread(fullLineRights(await previewLines(page, PLAIN_CELL))),
      'while the plain cell beside it stays ragged, as the page leaves it',
    ).toBeGreaterThan(1);
  });
});

test.describe('a literal cell is set in the code block’s face', () => {
  test('it takes the face, the size and the colour the reference draws it in', async ({ page }) => {
    const drawn = await drawnRuns(fixture.referencePdf);
    const reference = drawn.find((run) => run.text.trim() === 'literal');
    expect(reference, 'the reference draws the literal cell').toBeDefined();
    if (reference === undefined) return;

    await preparePrintPage(page, fixture);
    const measured = await page.evaluate(() => {
      const element = document.querySelector('[data-testid="page"] td.tableblock > .literal > pre');
      if (element === null) throw new Error('the preview has no literal cell');
      const style = getComputedStyle(element);
      return {
        family: style.fontFamily.split(',')[0].trim().replaceAll(/^["']|["']$/g, ''),
        sizePt: Number.parseFloat(style.fontSize) / (96 / 72),
        colour: style.color,
      };
    });

    expect(normaliseFamily(measured.family)).toBe(normaliseFamily(reference.fontFamily));
    agree('the literal cell’s size', measured.sizePt, reference.fontSizePt, PRINT_FIDELITY_TOLERANCE.fontSizePt);
    expect(sameColour(colourOf(measured.colour), reference.colour)).toBe(true);
  });

  test('its lines are pitched as the reference pitches them, and it wraps rather than widening', async ({
    page,
  }) => {
    const lines = await referenceLines(fixture.referencePdf);
    const first = referenceLine(lines, 'literal');
    // The cell's own second line: the next line down in the same column, which the reference wrapped
    // there rather than widening the column to fit.
    const second = lines
      .filter((line) => Math.abs(line.leftPt - first.leftPt) < 0.1 && line.baselinePt < first.baselinePt)
      .toSorted((a, b) => b.baselinePt - a.baselinePt)[0];
    expect(second, 'the reference wraps the literal cell onto a second line').toBeDefined();
    // …and onto no more than two. The count the preview is held to below used to be the literal `2`,
    // in a file whose every other number comes off the reference — so a reference that wrapped the
    // cell onto three lines would have left the preview asserted against a number nothing re-derived.
    // The cell's lines are the ones at its own left edge stepping down by its own pitch; the row
    // under it starts a pitch and a cell padding further down, so a third line at that spacing would
    // be this cell's.
    const pitchPt = first.baselinePt - second.baselinePt;
    const third = lines.find(
      (line) =>
        Math.abs(line.leftPt - first.leftPt) < 0.1 &&
        Math.abs(line.baselinePt - (second.baselinePt - pitchPt)) < pitchPt / 2,
    );
    expect(third, 'the reference wraps the literal cell onto exactly two lines').toBeUndefined();
    const referenceLineCount = 2;

    await preparePrintPage(page, fixture);
    const measured = await page.evaluate((perPoint) => {
      const element = document.querySelector('[data-testid="page"] td.tableblock > .literal > pre');
      if (element === null) throw new Error('the preview has no literal cell');
      const range = document.createRange();
      range.selectNodeContents(element);
      const tops = [...range.getClientRects()]
        .filter((rect) => rect.height > 0)
        .map((rect) => rect.top)
        .toSorted((a, b) => a - b);
      const distinct = tops.filter((top, index) => index === 0 || top - tops[index - 1] > 1);
      return { lines: distinct.length, pitchPt: distinct.length > 1 ? (distinct[1] - distinct[0]) / perPoint : 0 };
    }, PIXELS_PER_POINT);

    expect(measured.lines, 'the preview wraps it onto as many lines as the reference').toBe(
      referenceLineCount,
    );
    agree('the literal cell’s line pitch', measured.pitchPt, pitchPt);
  });
});

test.describe('a cell whose whole text is monospace is set in the mono face’s line box', () => {
  // prawn's line advance is `max_line_height + leading`, and `max_line_height` is the tallest
  // `font.height` among the line's fragments — each measured at its own size in its own face. A cell
  // whose entire text is monospace therefore has a SHORTER line than one set in the body face: M+
  // 1mn's built-in height is 1.09 where Noto Serif's is 1.36. On the bundled demo that is a row 54px
  // tall against its 60px neighbours, and the preview drew all of them at 61.
  //
  // WHAT THE REFERENCE CAN WITNESS, which is what this had to be rewritten around. No fixture in the
  // suite has a monospaced cell that wraps, so no page pitches two lines of one and no reference
  // states its line box directly. Two things it does state, and between them they pin it:
  //
  //   - a PLAIN cell's box, pitched between the lines of a cell that does wrap;
  //   - how far the monospaced cell's first baseline is RAISED above the plain cell's beside it. Both
  //     cells are top-aligned in one row and drawn at one size, so that difference is the two line
  //     boxes and the two faces' ascents and nothing else — and a preview that kept the body's box
  //     for the monospaced cell (the defect this exists for) puts the two baselines level.
  //
  // It used to be measured against `--print-codespan-line-height`, a property the harness had just
  // set on the page, and the rule under test reads that same property: the comparison could not fail.
  test('the reference’s own line pitch and first baselines say where both cells’ lines sit', async ({
    page,
  }) => {
    const runs = await textRuns(fixture.referencePdf);
    const one = (text: string) => {
      const found = runs.filter((run) => run.text.trim() === text);
      expect(found, `the reference draws exactly one "${text}"`).toHaveLength(1);
      return found[0];
    };
    const mono = one('mono cell');
    const plain = one('default cell');

    // The reference states the case before the preview is asked anything. Two cells of one row, at
    // one size, in two different faces — so what separates their baselines is the line box each was
    // built in rather than a size or an alignment.
    expect(mono.fontSizePt, 'the reference draws both cells at one size').toBeCloseTo(
      plain.fontSizePt,
      2,
    );
    expect(
      normaliseFamily(mono.fontFamily),
      'and the monospaced cell in a different face from the plain one',
    ).not.toBe(normaliseFamily(plain.fontFamily));
    // The PDF's y grows upward, so a raised baseline has the LARGER y.
    const referenceRaisePt = mono.yPt - plain.yPt;
    expect(
      referenceRaisePt,
      'the reference raises the monospaced cell’s first line above the plain cell’s',
    ).toBeGreaterThan(PRINT_FIDELITY_TOLERANCE.geometryPt);

    // The plain body cell's own line box: the tall cell is one cell of body text over several lines,
    // so the distance between its baselines IS the box prawn built it in. Taken as the whole set and
    // required to be uniform, because one cell has one line box — a spread would mean these are not
    // the lines of one cell.
    const lines = await referenceLines(fixture.referencePdf);
    const column = referenceLine(lines, 'leftA');
    const tall = lines
      .filter(
        (line) =>
          line.page === column.page &&
          Math.abs(line.leftPt - column.leftPt) < 0.1 &&
          line.baselinePt < referenceLine(lines, 'rightA').baselinePt &&
          line.baselinePt > referenceLine(lines, 'flatA').baselinePt,
      )
      .toSorted((a, b) => b.baselinePt - a.baselinePt);
    expect(tall.length, 'the reference sets the tall cell on several lines').toBeGreaterThan(3);
    const pitches_ = tall.slice(1).map((line, index) => tall[index].baselinePt - line.baselinePt);
    expect(spread(pitches_), 'and pitches every one of them alike').toBeLessThan(0.05);
    const referenceBodyBoxPt = pitches_[0];

    // Through the render worker, which is what names a cell whose whole text is monospace: Asciidoctor
    // writes `<p class="tableblock"><code>…</code></p>` for a `1m` column and for a codespan that
    // fills an ordinary cell alike, and the worker is where the difference is visible. Converting here
    // would measure a page carrying no such class at all.
    await preparePrintPage(page, fixture, await renderWithWorker(fixture));

    const boxes = await page.evaluate(
      ({ perPoint }) => {
        const root = document.querySelector('[data-testid="page"]');
        if (!(root instanceof HTMLElement)) throw new Error('the page has no column');
        const blockOf = (needle: string): HTMLElement => {
          const cell = [...root.querySelectorAll('td.tableblock, th.tableblock')].find(
            (candidate) => (candidate.textContent ?? '').replaceAll(/\s+/g, ' ').trim() === needle,
          );
          if (cell === undefined) throw new Error(`the preview has no cell reading "${needle}"`);
          const block = cell.firstElementChild;
          if (!(block instanceof HTMLElement)) throw new Error(`the cell "${needle}" holds no block`);
          return block;
        };
        const monoBlock = blockOf('mono cell');
        const code = monoBlock.querySelector('code');
        return {
          named: monoBlock.classList.contains('monospaced'),
          codeFamily:
            code === null
              ? ''
              : getComputedStyle(code).fontFamily.split(',')[0].trim().replaceAll(/^["']|["']$/g, ''),
          monoPt: Number.parseFloat(getComputedStyle(monoBlock).lineHeight) / perPoint,
          plainPt: Number.parseFloat(getComputedStyle(blockOf('default cell')).lineHeight) / perPoint,
        };
      },
      { perPoint: PIXELS_PER_POINT },
    );

    expect(boxes.named, 'the worker names the monospaced cell').toBe(true);
    // …and it really is set in the face the reference embedded, so the box below belongs to that face.
    // A codespan asks for the METRIC-bearing registration first (`M+ 1mn·print-metrics`), which is
    // the same file under a second name carrying the renderer's own ascent and descent — so the
    // reference's name is a prefix of it rather than equal to it.
    expect(
      normaliseFamily(boxes.codeFamily).startsWith(normaliseFamily(mono.fontFamily)),
      `${boxes.codeFamily} is ${mono.fontFamily}`,
    ).toBe(true);

    // The plain cell's box, against the pitch the reference measured on its own tall cell.
    agree('a plain body cell’s line box', boxes.plainPt, referenceBodyBoxPt);
    // The monospaced one is shorter, which is the renderer's rule and the whole difference: it is not
    // asserted as a number here because no page states one, it is asserted through the baseline the
    // page DOES state, below.
    expect(
      boxes.monoPt,
      `the monospaced cell’s line box (${boxes.monoPt.toFixed(2)}pt) is shorter than the body's (${boxes.plainPt.toFixed(2)}pt)`,
    ).toBeLessThan(boxes.plainPt);

    // The consequence a reader sees, and the one the reference records: half of the difference
    // between the two boxes shows up as the monospaced cell's first line sitting higher in its row.
    agree(
      'how far the monospaced cell’s first baseline is raised above the plain cell’s',
      (await previewBaseline(page, 'default cell')) - (await previewBaseline(page, 'mono cell')),
      referenceRaisePt,
    );
  });
});

test.describe('a footer row is banded and restyled', () => {
  test('the band is the colour and the width the reference paints', async ({ page }) => {
    const paper: Rgb = [255, 255, 255];
    const painted = await paintedBoxes(fixture.referencePdf);
    const band = painted.filter((box) => box.filled && !sameColour(box.colour, paper) && box.heightPt > 5);
    expect(band.length, 'the reference paints one rectangle per footer cell').toBeGreaterThan(0);

    await preparePrintPage(page, fixture);
    const measured = await page.evaluate((perPoint) => {
      const cells = [
        ...document.querySelectorAll('[data-testid="page"] table.tableblock > tfoot > tr > td.tableblock'),
      ];
      if (cells.length === 0) throw new Error('the preview has no footer row');
      return cells.map((cell) => ({
        background: getComputedStyle(cell).backgroundColor,
        widthPt: cell.getBoundingClientRect().width / perPoint,
      }));
    }, PIXELS_PER_POINT);

    expect(measured).toHaveLength(band.length);
    for (const cell of measured) {
      expect(sameColour(colourOf(cell.background), band[0].colour), `${cell.background} is the band's colour`).toBe(
        true,
      );
    }
    agree(
      'the band’s width across the table',
      measured.reduce((total, cell) => total + cell.widthPt, 0),
      Math.max(...band.map((box) => box.rightPt)) - Math.min(...band.map((box) => box.leftPt)),
      PRINT_FIDELITY_TOLERANCE.geometryPt + (await collapsedBorderPt(page)),
    );
  });

  test('its text takes the theme’s footer face, size, slant and colour', async ({ page }) => {
    const drawn = await drawnRuns(fixture.referencePdf);
    const reference = drawn.find((run) => run.text.trim() === 'Foot one');
    const body = drawn.find((run) => run.text.trim() === 'Body one');
    expect(reference, 'the reference draws the footer row').toBeDefined();
    // Asserted rather than merely guarded on: `body` is what makes the two comparisons below
    // meaningful, so a reference that stopped drawing "Body one" as one run — a change of one
    // character is enough to split it across two show-text operators — has to fail here rather than
    // return green having compared the footer's face, size, colour and slant against nothing.
    expect(body, 'and draws the body row it is contrasted with').toBeDefined();
    if (reference === undefined || body === undefined) return;
    // The theme gives the footer a face, a size and a colour that no other row on the page carries,
    // so a rule that reached the wrong row could not pass by inheriting the right answer.
    expect(reference.fontFamily).not.toBe(body.fontFamily);
    expect(reference.fontSizePt).not.toBe(body.fontSizePt);

    await preparePrintPage(page, fixture);
    const measured = await page.evaluate(() => {
      const cell = document.querySelector('[data-testid="page"] table.tableblock > tfoot > tr > td.tableblock');
      if (cell === null) throw new Error('the preview has no footer row');
      const style = getComputedStyle(cell);
      return {
        family: style.fontFamily.split(',')[0].trim().replaceAll(/^["']|["']$/g, ''),
        sizePt: Number.parseFloat(style.fontSize) / (96 / 72),
        colour: style.color,
        slant: style.fontStyle,
      };
    });

    expect(normaliseFamily(measured.family)).toBe(normaliseFamily(reference.fontFamily));
    agree('the footer’s size', measured.sizePt, reference.fontSizePt, PRINT_FIDELITY_TOLERANCE.fontSizePt);
    expect(sameColour(colourOf(measured.colour), reference.colour)).toBe(true);
    // The reference names the FILE it embedded, and the renderer picks that file from the theme's
    // `font-style`; so the slant is read off the reference's own face name rather than restated.
    expect(measured.slant).toBe(reference.fontFamily.toLowerCase().includes('italic') ? 'italic' : 'normal');
  });

  test('its line box is the footer’s own, not the body’s', async ({ page }) => {
    const paper: Rgb = [255, 255, 255];
    const boxes = await paintedBoxes(fixture.referencePdf);
    const band = boxes.find((box) => box.filled && !sameColour(box.colour, paper) && box.heightPt > 5);
    expect(band, 'the reference paints a band behind the footer row').toBeDefined();
    if (band === undefined) return;
    // The body row's own rectangle: the table paints one behind every cell, and the body's is the one
    // directly above the band, in the same column.
    const bodyRow = boxes
      .toSorted((a, b) => a.bottomPt - b.bottomPt)
      .find(
        (box) =>
          box.filled &&
          sameColour(box.colour, paper) &&
          Math.abs(box.leftPt - band.leftPt) < 0.1 &&
          box.bottomPt >= band.topPt - 0.1,
      );
    expect(bodyRow, 'the reference paints the body row above the band').toBeDefined();
    if (bodyRow === undefined) return;

    await preparePrintPage(page, fixture);
    // The two rows' PADDING-box heights, which is where the difference between their line boxes lives:
    // the padding is the same on both and a collapsed border is outside it, so what is left is the
    // footer's own face at the footer's own size, plus the body's leading.
    const measured = await page.evaluate((perPoint) => {
      const table = [...document.querySelectorAll('[data-testid="page"] table.tableblock')].find((candidate) =>
        candidate.querySelector('tfoot'),
      );
      if (table === undefined) throw new Error('the preview has no table with a footer');
      const body = table.querySelector('tbody tr td.tableblock');
      const foot = table.querySelector('tfoot tr td.tableblock');
      if (body === null || foot === null) throw new Error('the preview has no body or footer cell');
      return { bodyPt: body.clientHeight / perPoint, footPt: foot.clientHeight / perPoint };
    }, PIXELS_PER_POINT);

    agree(
      'how much shorter the footer row is than a body row',
      measured.footPt - measured.bodyPt,
      band.heightPt - bodyRow.heightPt,
    );
  });
});

test.describe('columns are as wide as their weights say', () => {
  test('eight columns of equal weight are eight equal columns', async ({ page }) => {
    const lines = await referenceLines(fixture.referencePdf);
    // Each cell's first line begins at its column's content edge, because every one of them is
    // left-aligned; the first word of each is enough to find it, and is unique in the document.
    const referenceStarts = [
      'asciidoc',
      'default cell',
      'emphasis',
      'header',
      'literal',
      'mono cell',
      'strong cell',
      'verse cell',
    ].map((text) => referenceLine(lines, text).leftPt);
    const referencePitches = pitches(referenceStarts);
    // The reference's own statement of the case, so the claim is not this file's: eight weights of
    // one produce eight columns of one width, whatever the cells hold.
    expect(
      Math.max(...referencePitches) - Math.min(...referencePitches),
      'the reference divides the measure evenly',
    ).toBeLessThan(0.05);

    await preparePrintPage(page, fixture);
    const previewStarts: number[] = [];
    for (const text of [
      'asciidoc cell',
      'default cell',
      'emphasis cell',
      'header cell',
      'literal cell',
      'mono cell',
      'strong cell',
      'verse cell',
    ]) {
      const start = await previewFirstLine(page, text);
      previewStarts.push(start.leftPt);
    }
    for (const [index, pitch] of referencePitches.entries()) {
      agree(`the pitch from column ${String(index + 1)} to ${String(index + 2)}`, pitches(previewStarts)[index], pitch);
    }
  });

  test('a table with no cols attribute divides its measure evenly', async ({ page }) => {
    const lines = await referenceLines(fixture.referencePdf);
    const reference = referenceLine(lines, 'beta').leftPt - referenceLine(lines, 'alpha').leftPt;
    await preparePrintPage(page, fixture);
    const previewBeta = await previewFirstLine(page, 'beta');
    const previewAlpha = await previewFirstLine(page, 'alpha');
    agree('the pitch of a table with no cols attribute', previewBeta.leftPt - previewAlpha.leftPt, reference);
  });

  test('an autowidth table is still sized by its content', async ({ page }) => {
    const lines = await referenceLines(fixture.referencePdf);
    const reference = referenceLine(lines, 'yy').leftPt - referenceLine(lines, 'xx').leftPt;
    // The case a fixed layout would break: `convert_table` leaves an autowidth table's `column_widths`
    // empty and lets prawn-table measure, so the first column is as wide as `short` and no wider —
    // nothing like the half of the measure a weight would have given it.
    expect(reference, 'the reference sizes the autowidth table from its content').toBeLessThan(40);

    await preparePrintPage(page, fixture);
    const previewSecond = await previewFirstLine(page, 'yy');
    const previewFirst = await previewFirstLine(page, 'xx');
    agree(
      'the pitch of an autowidth table',
      previewSecond.leftPt - previewFirst.leftPt,
      reference,
      // This one crosses the whole of the first column, borders included, and an autowidth column is
      // the one case where the two media's borders do not cancel: the renderer sizes the column from
      // the text alone while the browser must also fit the border it drew.
      PRINT_FIDELITY_TOLERANCE.geometryPt + (await collapsedBorderPt(page)),
    );
  });
});
