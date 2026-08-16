/**
 * @file The constructs the fidelity anchors cannot measure.
 *
 * The anchors compare typography, colour and page geometry against reference PDFs, and they do that
 * exactly. What they cannot see is a construct that has no counterpart in a paragraph of body text:
 * an admonition's icon, a header column, a callout number, a key cap. Every one of those was drawn
 * wrong — or not at all — while all 28 anchor comparisons passed, because nothing was measuring them.
 *
 * These checks ask a narrower question than the anchors do: did the renderer's own value reach this
 * construct? A mask that points at a path the build does not publish, a fill scoped to `thead` when
 * the header is a column, a ring sized to the em box instead of the glyph — each shows up here as a
 * number that is wrong rather than as a page that merely looks a bit off.
 */

import { readFileSync } from 'node:fs';
import path from 'node:path';
import { expect, test } from '@playwright/test';
import { PRINT_FIDELITY_TOLERANCE, pageRasters, textRuns, type TextRun } from '../harness/pdftools';
import {
  PIXELS_PER_POINT,
  baselinesOf,
  colourOf,
  inkCentreOf,
  preparePrintDocument,
  readFixture,
  renderSourceWithWorker,
} from './harness';

/** The palette the renderer highlights with, as committed by the package that owns the gem. */
const PALETTE = JSON.parse(
  readFileSync(
    path.join(__dirname, '../../../../../packages/asciidoc-pdf/assets/rouge/palette.json'),
    'utf8',
  ),
) as {
  fallbackTheme: string;
  themes: Record<string, { styles: Record<string, { fg?: string }> }>;
};

/** The colour that palette gives a string literal. */
const PALETTE_STRING_COLOUR =
  PALETTE.themes[PALETTE.fallbackTheme].styles['Literal.String'].fg ?? '';

/**
 * A `#rrggbb` as the browser reports it back.
 *
 * Through the harness's own reader rather than a slice of its own, so a value that is not a colour
 * fails here instead of becoming `rgb(NaN, NaN, NaN)` — a string no computed style ever equals, which
 * would have read as "the construct is painted in the wrong colour".
 *
 * @param hex - The colour to render.
 * @returns The `rgb(r, g, b)` form a computed style reports.
 */
function rgbOf(hex: string): string {
  return `rgb(${colourOf(hex, `the expected colour ${hex}`).join(', ')})`;
}

/**
 * The theme's own values, written once and read by both the theme below and the expectations.
 *
 * Named rather than repeated, because an expectation that restates a theme value as a literal is a
 * transcription: it agrees with whatever was typed twice, and says nothing about the value having
 * travelled. Here the theme is the INPUT and the measurement is the output, which is a comparison.
 */
const TIP_ICON_SIZE_PT = 18;
const TIP_ICON_COLOUR = '#1A4E8A';
/**
 * The caret's colour, chosen to be one the stylesheet's own fallback is NOT.
 *
 * The renderer carries it inside the caret TEMPLATE (`menu.caret-content` is
 * `" <font size=\"1.15em\" color=\"#B12146\">›</font> "` in the gem's default theme), and the
 * stylesheet's fallback is that same `#B12146`. Asserting the default therefore asserted nothing: a
 * projection that stopped emitting `--print-menu-caret-font-color` altogether painted the identical
 * colour, and the check passed on a page nothing had reached.
 */
const MENU_CARET_COLOUR = '#0B7285';

/**
 * The pair a button's label is wrapped in, chosen to be one the stylesheet's own fallback is NOT.
 *
 * The renderer carries them in a TEMPLATE — `button.content` is `"[\u2009%s\u2009]"` in the gem's
 * default theme (default-theme.yml:65) — and the stylesheet's fallbacks are that same `"[\2009"` and
 * `"\2009]"` (print-preview.css:978, :982). Under a theme that says nothing about it, a projection
 * that resolved the template and one that emitted no property at all leave the identical brackets on
 * the page, so neither the opening nor the closing one would be evidence of anything.
 *
 * The thin space is kept where the renderer's own template puts it: inside each bracket, which is the
 * half of the mark a `toContain('[')` could never see. Both are written as escapes because a thin
 * space typed into a source file is a character no reader of it can see.
 */
const BUTTON_BRACKETS = { before: '\u00AB\u2009', after: '\u2009\u00BB' };

/** A theme that gives every construct below a value of its own, so a default cannot pass for a value. */
const THEME = `
extends: default
table:
  head:
    background-color: EEF2F6
admonition:
  column-rule-color: 1A4E8A
  icon:
    tip:
      stroke-color: ${TIP_ICON_COLOUR.slice(1)}
      size: ${TIP_ICON_SIZE_PT}
code:
  font-size: 9
conum:
  font-color: 1A4E8A
  font-size: 12
kbd:
  background-color: F0F2F5
  border-color: C9D0D7
button:
  background-color: 1A4E8A
  font-color: FFFFFF
  content: "${BUTTON_BRACKETS.before}%s${BUTTON_BRACKETS.after}"
menu:
  caret-content: ' <font size="1.15em" color="${MENU_CARET_COLOUR}">›</font> '
image:
  align: center
`;

const DOCUMENT = `= Doc
:icons: font
:experimental:

TIP: A tip with enough words in it that the block is several lines tall, which is what makes the
icon's vertical position something that can be wrong.

[cols="1h,3",options="header"]
|===
| Operator | Meaning

| \`d\` | Default
|===

[source,ruby]
----
puts "hello" # <1>
----
<1> Prints a greeting.

Press kbd:[Ctrl+F] then click btn:[Export], via menu:File[Export > PDF].
`;

/** The three kinds of table cell whose fills the renderer decides separately: row, column, body. */
const CELL_SELECTORS = ['thead th', 'tbody th', 'tbody td'];

/**
 * How wide the label column is, as a multiple of the icon's size.
 *
 * The renderer's own rule and the only number in this file that is not read from the theme or from
 * the page: `label_width = label_min_width || (icon_size * 1.5)` (`convert_admonition`,
 * converter.rb:936). It is written out here rather than derived because the documents in THIS file
 * are synthetic and have no reference PDF to derive it from; the alternative was a hand copy of the
 * stylesheet's own `calc()`, which cannot disagree with the stylesheet whatever either of them says.
 *
 * It is not unwitnessed, and an earlier note here claiming that no anchor in the suite converts with
 * `icons: font` was simply wrong: `rules-and-insets`, `list-geometry` and `table-cells` all do. The
 * product this factor names is pinned against a real render in `print-rules.spec.ts` — "an
 * admonition's content is inset on both sides" and "an admonition's column rule is … on the
 * boundary" both measure where the content column starts against the reference's own ink, and that
 * boundary IS the block's left padding plus this label width. So the reference decides the number;
 * what this file adds is the OTHER branch of the `||`, which no anchor's theme exercises because none
 * of them sets `label-min-width`.
 */
const ICON_LABEL_WIDTH_FACTOR = 1.5;

/**
 * How much a mark is magnified before its ink is measured.
 *
 * A callout ring is twelve to sixteen CSS pixels across, so half a pixel of the rasteriser's own
 * rounding is four per cent of it — as much as the whole claim below is allowed to move. Measured at
 * sixteen times the ring is over two hundred pixels and the same rounding is a quarter of a per cent,
 * which is what makes "the digit is at the ring's centre" a statement about the layout rather than
 * about the pixel grid. It converges: the same reading at eight times is within half a per cent of it.
 */
const MAGNIFY = 16;

/**
 * How far the digit's ink may sit from the ring's own centre, as a fraction of the ring.
 *
 * Vertically the two must agree, because nothing in the glyph excuses a difference: the digit is
 * placed in a grid area that IS the ring's inside, and at this magnification the three rings measured
 * below land within half a per cent of its middle.
 *
 * Horizontally the glyph itself has a say. The renderer centres the ADVANCE the circled digit takes,
 * not its ink, and a `1` in M+ 1mn draws nothing in the right-hand part of that advance — so its ink
 * sits about three per cent left of the middle whatever the layout does, while `12` fills the advance
 * and lands on it. The allowance is that bearing and nothing more; the defect it still catches is a
 * digit crammed against one side, which is a whole different order.
 */
const VERTICAL_CENTRE = 0.02;
const HORIZONTAL_CENTRE = 0.05;

/**
 * The anchor whose reference PDF draws the mark this file's synthetic documents cannot witness.
 *
 * Its source carries both kinds of callout — the ones inside a listing and the ones beside the
 * explanations under it — and its reference inks all six with the renderer's own `conum.glyphs:
 * circled` in M+ 1mn, which is the glyph the stylesheet draws a ring in place of.
 */
const RING_FIXTURE = 'list-geometry';

/**
 * The resolution the reference's rings are measured at.
 *
 * Six hundred rather than the hundred and fifty the rest of the suite rasterises at, because what is
 * being read is an edge. A twelve-point glyph is fifty pixels to the em at 300 dpi and a hundred at
 * 600, and the difference shows: measured at 300 the rings below come out 0.9200em tall against
 * 0.9053em wide — one circle disagreeing with itself by a per cent and a half, which is most of the
 * quantity's own precision — while at 600 both axes read 0.9055em. The finer raster is the one where
 * the reading agrees with itself.
 */
const RING_DPI = 600;

/**
 * How far the preview's ring may sit from the one the reference draws, in ems.
 *
 * Two hundredths of an em, and neither side comes anywhere near it: the preview's two rings read
 * 0.9053em and 0.9049em against the reference's 0.9055em, and their advances 0.9993em and 0.9989em
 * against its 1.0000em. So this is not a fitted tolerance but the width of the two roundings
 * underneath the comparison — the reference's glyph is rasterised at a hundred pixels to the em, and
 * the browser quantises a box to a sixty-fourth of a CSS pixel. It is a fifth of the difference the
 * comparison exists to catch: a ring drawn to the em box instead of to the glyph is out by 0.0945em.
 */
const RING_EM = 0.02;

/** One circled digit as the reference inks it, in ems of the size it is drawn at. */
interface ReferenceRing {
  /** The outer ring, top to bottom. */
  readonly heightEm: number;
  /** The outer ring, side to side: a circle's two extents are one number measured twice. */
  readonly widthEm: number;
  /** How far the whole mark steps the line, from the run's own advance. */
  readonly advanceEm: number;
}

/**
 * One glyph's inked extent along one axis, read off a raster.
 *
 * The edge is taken where the ink's darkness crosses half of the glyph's full ink, with the partial
 * pixel beyond it weighted by how dark it is — so an antialiased edge contributes the fraction of a
 * pixel it covers rather than a whole one or none. The walk starts inside the glyph and stops at the
 * first blank row or column, so neither the words beside the ring nor the lines above and below it
 * can join the run.
 *
 * @param darkestAt - How dark the darkest pixel of one row (or column) is, 0 to 255.
 * @param inside - An index known to fall inside the ink; the walk grows outwards from it.
 * @returns The two edges, in fractional pixels of the same axis.
 */
function inkEdges(darkestAt: (index: number) => number, inside: number): { from: number; to: number } {
  const full = darkestAt(inside);
  expect(full, 'the reference inks the glyph being measured').toBeGreaterThan(40);
  const half = full / 2;
  let low = inside;
  while (darkestAt(low - 1) >= half) low -= 1;
  let high = inside;
  while (darkestAt(high + 1) >= half) high += 1;
  return { from: low - darkestAt(low - 1) / full, to: high + 1 + darkestAt(high + 1) / full };
}

/**
 * The circled digit's own box, measured where the renderer actually drew it.
 *
 * The documents in this file are put on the page by `preparePrintDocument`, which has no reference
 * PDF behind it — so the only number a check written against that page alone could compare the ring
 * against is the `0.906em` the stylesheet itself sets. That is the value under test restating
 * itself: it agrees with the rule however the rule is written, and the one case it cannot notice is
 * the ring being wrong. Changing `print-preview.css:1141` from `0.906em` to `1em` left every
 * assertion in this test green.
 *
 * The glyph is the same glyph wherever it is drawn, though, so the reference this page has no
 * fixture for is read out of another one's. This walks the raster the way
 * `print-list-geometry.spec.ts:88` does and for the same reason; the two are not shared because both
 * live in spec files, and this one also reads the horizontal extent, which the ring's roundness is
 * stated from.
 *
 * @returns The ring the reference draws, in ems.
 */
async function referenceRing(): Promise<ReferenceRing> {
  const pdf = readFixture(RING_FIXTURE).referencePdf;
  const runs = await textRuns(pdf);
  const drawn = runs.filter((run) => /^[①-⑳]$/.test(run.text));
  expect(drawn.length, `${RING_FIXTURE}'s reference inks callout rings`).toBeGreaterThan(2);

  // The largest the page draws, and every ring at that size. The error in this reading is a fixed
  // number of raster pixels, so the biggest glyph carries the least of it: at 600 dpi the reference's
  // twelve-point rings are exactly a hundred pixels to the em and read 0.9055em on both axes, while
  // its eleven-point ones fall at 91.67 and read 0.9173em tall against 0.9099em wide — a circle that
  // disagrees with itself by seven thousandths of an em, which is a third of what the comparison
  // below is held to.
  const sizePt = Math.max(...drawn.map((run) => run.fontSizePt));
  const largest = drawn.filter((run) => run.fontSizePt === sizePt);
  expect(largest.length, 'and more than one of them at its largest size').toBeGreaterThan(1);

  const rasters = pageRasters(pdf, RING_DPI);
  const boxes = largest.map((run: TextRun): ReferenceRing => {
    const raster = rasters[run.page - 1];
    const perPx = 72 / raster.dpi;
    const sizePx = run.fontSizePt / perPx;
    const baselinePx = ((raster.heightPx * 72) / raster.dpi - run.yPt) / perPx;
    // The glyph's own advance, less a fiftieth at each end so a neighbour's ink cannot reach in.
    const from = Math.floor((run.xPt + 0.02 * run.fontSizePt) / perPx);
    const to = Math.ceil((run.xPt + 0.98 * run.fontSizePt) / perPx);
    const darkness = (x: number, y: number): number => 255 - Math.min(...raster.colourAt(x, y));

    const row = (y: number): number => {
      let value = 0;
      for (let x = from; x <= to; x += 1) value = Math.max(value, darkness(x, y));
      return value;
    };
    // A circled digit's ring is inked all the way round, so a row a third of the way up it is inside
    // the outline whatever the digit is, and so is the column through its middle.
    const vertical = inkEdges(row, Math.round(baselinePx - 0.36 * sizePx));
    const column = (x: number): number => {
      let value = 0;
      for (let y = Math.floor(vertical.from); y <= Math.ceil(vertical.to); y += 1) {
        value = Math.max(value, darkness(x, y));
      }
      return value;
    };
    const horizontal = inkEdges(column, Math.round((run.xPt + 0.5 * run.fontSizePt) / perPx));

    return {
      heightEm: (vertical.to - vertical.from) / sizePx,
      widthEm: (horizontal.to - horizontal.from) / sizePx,
      advanceEm: run.widthPt / run.fontSizePt,
    };
  });

  // The reading self-validates before anything is compared against it: the rings are one glyph drawn
  // several times, so a measurement that came out differently for two of them is not measuring the
  // glyph. Observed spread across the three: 0.0000em on every axis.
  const spread = (of: (box: ReferenceRing) => number): number =>
    Math.max(...boxes.map(of)) - Math.min(...boxes.map(of));
  expect(
    Math.max(spread((box) => box.heightEm), spread((box) => box.widthEm), spread((box) => box.advanceEm)),
    `the reference draws one ring: ${boxes.map((box) => box.heightEm.toFixed(4)).join(', ')}`,
  ).toBeLessThan(0.005);
  const ring = boxes[0];
  // …and it really is round, which is what lets a square box with a 50% radius be compared against a
  // single number below. Measured 0.9055em on both axes.
  expect(
    Math.abs(ring.heightEm - ring.widthEm),
    `the reference's ring is ${ring.heightEm.toFixed(4)}em tall and ${ring.widthEm.toFixed(4)}em wide`,
  ).toBeLessThan(0.005);
  // …and it is smaller than the em box it sits in, which is the whole of what makes the comparison
  // below discriminating: a ring drawn to the em would be wrong by 0.0945em, and the tolerance is a
  // fifth of that. Measured 0.9055em inside a 1.0000em advance.
  expect(
    ring.advanceEm - ring.heightEm,
    `the reference's ring is ${ring.heightEm.toFixed(4)}em inside a ${ring.advanceEm.toFixed(4)}em advance`,
  ).toBeGreaterThan(4 * RING_EM);
  return ring;
}

test.describe('the marks the renderer draws, rather than the properties it sets', () => {
  test("an admonition's icon is the renderer's own glyph, in the theme's colour, centred", async ({
    page,
  }) => {
    const served: { url: string; status: number }[] = [];
    page.on('response', (response) => {
      if (response.url().includes('admonition-icons')) {
        served.push({ url: response.url(), status: response.status() });
      }
    });

    const properties = await preparePrintDocument(page, { source: DOCUMENT, themeText: THEME });

    const icon = await page.evaluate(() => {
      const element = document.querySelector('[data-testid="page"] .icon-tip');
      if (element === null) return null;
      const before = getComputedStyle(element, '::before');
      const cell = element.closest('td');
      const block = element.closest('.admonitionblock');
      const iconBox = element.getBoundingClientRect();
      const blockBox = block?.getBoundingClientRect() ?? new DOMRect();
      return {
        width: before.width,
        height: before.height,
        background: before.backgroundColor,
        mask: before.maskImage,
        cellAlign: cell === null ? '' : getComputedStyle(cell).verticalAlign,
        // How far the icon's centre is from the block's, as a fraction of the block's height.
        centreOffset: Math.abs(
          (iconBox.top + iconBox.height / 2 - blockBox.top) / blockBox.height - 0.5,
        ),
      };
    });

    expect(icon).not.toBeNull();
    // The two numbers, derived rather than transcribed. `expect(width).toBe('36px')` was a hand copy
    // of the stylesheet's own `calc(var(--print-admonition-icon-tip-size, 32px) * 1.5)`, which is a
    // check that agrees with the rule it is checking however that rule is written.
    //
    // The size comes from the theme, through the projection: this document's theme asks for 18pt, so
    // the property has to be 18pt in CSS pixels and the box has to be that tall. Asserted on the
    // PROPERTY first, so a projection that stopped emitting it fails here rather than silently
    // handing the stylesheet its 32px fallback.
    const iconSizeProperty = properties['--print-admonition-icon-tip-size'];
    expect(iconSizeProperty, 'the projection resolves the tip icon’s size').toBeDefined();
    const iconSizePx = Number.parseFloat(iconSizeProperty ?? '');
    expect(iconSizePx, 'and it is the 18pt this theme asks for').toBeCloseTo(
      TIP_ICON_SIZE_PT * PIXELS_PER_POINT,
      2,
    );
    // …and the HEIGHT is what carries it. The renderer draws the glyph as a character at `size:
    // icon_size`, so the size is an em: the glyph fills it vertically and advances however wide its
    // own outline is.
    expect(Number.parseFloat(icon?.height ?? '')).toBeCloseTo(iconSizePx, 2);
    // The box's width is the label COLUMN's, and that is the renderer's own arithmetic rather than
    // this stylesheet's: `convert_admonition` sets `label_width = label_min_width || (icon_size *
    // 1.5)` (converter.rb:936). This theme sets no minimum, so the factor decides.
    expect(Number.parseFloat(icon?.width ?? '')).toBeCloseTo(iconSizePx * ICON_LABEL_WIDTH_FACTOR, 2);
    // Likewise the colour: the theme's own value, and the property it travelled through.
    expect(properties['--print-admonition-icon-tip-font-color'], 'the projection resolves its colour').toBe(
      TIP_ICON_COLOUR,
    );
    expect(icon?.background).toBe(rgbOf(TIP_ICON_COLOUR));
    expect(icon?.mask).toContain('/vendor/admonition-icons/tip.svg');
    expect(icon?.cellAlign).toBe('middle');
    expect(icon?.centreOffset ?? 1).toBeLessThan(0.1);

    // The mask was actually fetched, and the file was there. A mask whose URL 404s draws nothing at
    // all, which on screen is indistinguishable from a rule that never applied. The screenshot is
    // what makes the browser paint — a mask is fetched when it is drawn, not when it is declared.
    await page.screenshot();
    expect(served.map((response) => response.url.replace(/^.*\/vendor/, '/vendor'))).toEqual([
      '/vendor/admonition-icons/tip.svg',
    ]);
    expect(served[0]?.status).toBe(200);
  });

  // Both sides of the `||`, and the second row is the one that discriminates. `label_width =
  // label_min_width || (icon_size * 1.5)` REPLACES the product with the stated minimum; a stylesheet
  // written as `max(minimum, product)` — the reading the name "min-width" invites — agrees with the
  // renderer for every minimum above the product and disagrees with it for every minimum below one.
  // Only the 60pt case was measured, and 60pt is above this theme's 27pt product, so the whole
  // comparison was satisfied by an implementation that only ever raises. The 10pt case is the one
  // that can tell them apart, and it is the case an author who wants a NARROW label column writes.
  for (const { minimumPt, than } of [
    { minimumPt: 60, than: 'wider' },
    { minimumPt: 10, than: 'narrower' },
  ] as const) {
    test(`a theme's own label width of ${minimumPt}pt — ${than} than the product — replaces it, as the renderer's \`||\` does`, async ({
      page,
    }) => {
      const productPx = TIP_ICON_SIZE_PT * PIXELS_PER_POINT * ICON_LABEL_WIDTH_FACTOR;
      // A theme of its own rather than THEME with a line appended: both would carry an `admonition`
      // mapping, and a document with two mappings of one name is a document whose second one silently
      // replaces the first — including the icon size this test then compares against.
      const properties = await preparePrintDocument(page, {
        source: DOCUMENT,
        themeText: [
          'extends: default',
          'admonition:',
          `  label-min-width: ${minimumPt}`,
          '  icon:',
          '    tip:',
          `      size: ${TIP_ICON_SIZE_PT}`,
          '',
        ].join('\n'),
      });
      expect(properties['--print-admonition-label-min-width'], 'the projection resolves it').toBeDefined();

      const icon = await page.evaluate(() => {
        const element = document.querySelector('[data-testid="page"] .icon-tip');
        if (element === null) return null;
        const before = getComputedStyle(element, '::before');
        return { width: before.width, height: before.height };
      });
      expect(icon, 'the preview lays the tip icon out').not.toBeNull();
      // The stated minimum, and nothing derived from the product.
      expect(Number.parseFloat(icon?.width ?? '')).toBeCloseTo(minimumPt * PIXELS_PER_POINT, 1);
      // …and this case really does sit on the side of the product it claims to, so the two rows
      // between them straddle it and no single-branch implementation satisfies both.
      const comparison = expect(minimumPt * PIXELS_PER_POINT);
      if (than === 'wider') comparison.toBeGreaterThan(productPx);
      else comparison.toBeLessThan(productPx);
      // The icon keeps its own size inside the column either way: the minimum sets the COLUMN, and
      // `convert_admonition` goes on drawing the glyph at `icon_size`.
      expect(Number.parseFloat(icon?.height ?? '')).toBeCloseTo(TIP_ICON_SIZE_PT * PIXELS_PER_POINT, 1);
    });
  }

  test('a header column is filled like a header, not like a body cell', async ({ page }) => {
    await preparePrintDocument(page, { source: DOCUMENT, themeText: THEME });

    const fills = await page.evaluate(
      (selectors) =>
        selectors
          .map((selector) => document.querySelector(`[data-testid="page"] ${selector}`))
          .map((element) =>
            element === null ? 'missing' : getComputedStyle(element).backgroundColor,
          ),
      CELL_SELECTORS,
    );
    const [headRow, headColumn, bodyCell] = fills;

    // `[cols="1h,3"]` puts the header in a COLUMN: those cells are `th` inside `tbody`, and the
    // renderer fills them exactly as it fills the header row.
    expect(headRow).toBe('rgb(238, 242, 246)');
    expect(headColumn).toBe('rgb(238, 242, 246)');
    expect(bodyCell).toBe('rgba(0, 0, 0, 0)');
  });

  test('a callout number is a ring the size of the glyph, not of the em box it sits in', async ({
    page,
  }) => {
    await preparePrintDocument(page, { source: DOCUMENT, themeText: THEME });

    const measure = (selector: string) =>
      page.evaluate((css) => {
        const element = document.querySelector(`[data-testid="page"] ${css}`);
        if (element === null) return null;
        const style = getComputedStyle(element);
        const fallback = element.nextElementSibling;
        const box = element.getBoundingClientRect();
        return {
          height: box.height,
          width: box.width,
          // The mark's whole advance: the ring is inset inside the em the glyph steps the line by,
          // and the stylesheet carries that inset as the element's own inline margins. A ring that
          // grew to the em box while the margins stayed would step every character after it along.
          advance:
            box.width +
            Number.parseFloat(style.marginLeft) +
            Number.parseFloat(style.marginRight),
          fontSize: Number.parseFloat(style.fontSize),
          colour: style.color,
          radius: style.borderTopLeftRadius,
          fallbackShown: fallback === null ? 'none' : getComputedStyle(fallback).display,
        };
      }, selector);

    // The glyph the renderer inks in place of this ring, measured on a page it really rendered.
    const reference = await referenceRing();

    // The marker beside the explanation, which is where the renderer really does set the conum font.
    const marker = await measure('.colist .conum[data-value]');

    expect(marker).not.toBeNull();
    // 12pt is 16px.
    expect(marker?.fontSize).toBeCloseTo(16, 1);
    expect(marker?.colour).toBe('rgb(26, 78, 138)');
    // Round, not merely rounded: half the box on each side, which is a circle at any size.
    expect(marker?.radius).toBe('50%');
    // The markup says the number twice: the ring, and a plain `(1)` for a reader with no icon font.
    expect(marker?.fallbackShown).toBe('none');

    // Inside the code block the same number is drawn as part of the listing's own text: the renderer
    // gives that fragment a colour and a family but no size, so it takes the code's. Applying
    // `conum.font-size` there too inflates every callout in every source block — 12pt against 9pt
    // code here — which is a mark half again too large sitting on the line it annotates.
    const inCode = await measure('pre .conum[data-value]');
    expect(inCode).not.toBeNull();
    // 9pt code, as the theme sets it, is 12px.
    expect(inCode?.fontSize).toBeCloseTo(12, 1);
    expect(inCode?.colour).toBe('rgb(26, 78, 138)');

    // How BIG the ring is, against the only thing that can decide it: the circled digit the export
    // draws. Both rings are held to the one reading — it is one glyph, and the size it is set at is
    // the only thing that differs between the two — so the marker's 16px box and the listing's 12px
    // box are two independent samples of the same claim.
    //
    // Every number on this side is the page's; every number on the other is the reference's. That is
    // the whole point of the comparison: the previous version of this test compared the preview's
    // ring against the preview's own ring, and `print-preview.css:1141`'s `0.906em` could be changed
    // to `1em` without a single assertion here moving. Simulated by injecting that override into the
    // prepared page, the marker now reads 1.0000em against the reference's 0.9055em and fails here.
    for (const [where, ring] of [
      ['the marker beside the explanation', marker],
      ['the ring inside the listing', inCode],
    ] as const) {
      const size = ring?.fontSize ?? 1;
      const heightEm = (ring?.height ?? 0) / size;
      const widthEm = (ring?.width ?? 0) / size;
      const advanceEm = (ring?.advance ?? 0) / size;
      expect(
        Math.abs(heightEm - reference.heightEm),
        `${where} is ${heightEm.toFixed(4)}em tall, the reference's glyph ${reference.heightEm.toFixed(4)}em`,
      ).toBeLessThan(RING_EM);
      expect(
        Math.abs(widthEm - reference.widthEm),
        `${where} is ${widthEm.toFixed(4)}em wide, the reference's glyph ${reference.widthEm.toFixed(4)}em`,
      ).toBeLessThan(RING_EM);
      // …and the mark as a whole still advances the em the glyph advances, which is what the inset on
      // each side is for. This is the half of the claim a diameter alone cannot make: a ring drawn to
      // the em box with no inset around it is the right advance and the wrong mark, and a ring of the
      // right size with the wrong inset is the right mark set at the wrong pitch.
      expect(
        Math.abs(advanceEm - reference.advanceEm),
        `${where} advances ${advanceEm.toFixed(4)}em, the reference's glyph ${reference.advanceEm.toFixed(4)}em`,
      ).toBeLessThan(RING_EM);
    }
  });

  test("a callout number's digit is painted at the centre of its ring", async ({ page }) => {
    // The centre, measured from the paint. Every property involved read back exactly as written while
    // the digit sat low and left of the ring: a fixed height, a fixed line height and a border the
    // browser rounds up to a whole pixel are three numbers that only agree by coincidence, and a
    // check that asserts each of them separately never notices that they disagree with each other.
    await preparePrintDocument(page, {
      source: `${DOCUMENT}\n\n[source,ruby]\n----\nputs 1 # <12>\n----\n<12> The twelfth.\n`,
      themeText: THEME,
    });

    // The ring's own stroke is inked in the same colour as the digit, so it is taken out for the
    // duration of the capture; what is left inside the box is the digit and nothing else.
    const mute =
      '.asciidoc-preview-content[data-preview-style="print"] .conum[data-value]' +
      ' { border-color: transparent !important; }';

    for (const selector of ['.colist .conum[data-value]', 'pre .conum[data-value]']) {
      const ink = await inkCentreOf(page, selector, mute, MAGNIFY);
      expect(ink, `${selector} paints a digit`).not.toBeNull();
      if (ink === null) continue;
      expect(ink.coverage, `${selector} paints more than an empty box`).toBeGreaterThan(0.02);
      expect(Math.abs(ink.boxY - 0.5), `${selector} vertical centre`).toBeLessThan(VERTICAL_CENTRE);
      expect(Math.abs(ink.boxX - 0.5), `${selector} horizontal centre`).toBeLessThan(HORIZONTAL_CENTRE);
    }
  });

  test('a two-digit callout keeps the ring the glyph has and fits its digits inside it', async ({
    page,
  }) => {
    // The renderer draws U+246B for twelve, and that glyph is exactly as wide and as tall as U+2460:
    // the ring does not grow for a second digit, the digits are set closer together instead. A ring
    // that widened would step every character after it along the line.
    // Asciidoctor renumbers callouts in order, so a two-digit one only exists in a block that really
    // has twelve of them.
    const marked = Array.from({ length: 12 }, (_, index) => `puts ${index + 1} # <${index + 1}>`);
    const explained = Array.from({ length: 12 }, (_, index) => `<${index + 1}> Line ${index + 1}.`);
    await preparePrintDocument(page, {
      source: `= Doc\n\n[source,ruby]\n----\n${marked.join('\n')}\n----\n${explained.join('\n')}\n`,
      themeText: THEME,
    });

    const rings = await page.evaluate(() =>
      [...document.querySelectorAll('[data-testid="page"] .colist .conum[data-value]')].map(
        (element) => {
          const box = element.getBoundingClientRect();
          return {
            value: element instanceof HTMLElement ? element.dataset.value : undefined,
            width: box.width,
            height: box.height,
          };
        },
      ),
    );
    expect(rings.at(0)?.value).toBe('1');
    expect(rings.at(-1)?.value).toBe('12');
    expect(rings.at(-1)?.width).toBeCloseTo(rings[0].width, 2);
    expect(rings.at(-1)?.height).toBeCloseTo(rings[0].height, 2);

    const ink = await inkCentreOf(
      page,
      '.colist .conum[data-value="12"]',
      '.asciidoc-preview-content[data-preview-style="print"] .conum[data-value]' +
        ' { border-color: transparent !important; }',
      MAGNIFY,
    );
    expect(ink).not.toBeNull();
    if (ink === null) return;
    expect(
      Math.abs(ink.boxX - 0.5),
      'two digits stay centred rather than crammed to one side',
    ).toBeLessThan(HORIZONTAL_CENTRE);
    expect(Math.abs(ink.boxY - 0.5)).toBeLessThan(VERTICAL_CENTRE);
  });

  test('the experimental macros are drawn, not left as bare words', async ({ page }) => {
    const properties = await preparePrintDocument(page, { source: DOCUMENT, themeText: THEME });

    const inline = await page.evaluate(() => {
      const page_ = '[data-testid="page"] ';
      const kbd = document.querySelector(`${page_}kbd`);
      const button = document.querySelector(`${page_}b.button`);
      const caret = document.querySelector(`${page_}.menuseq .caret`);
      return {
        kbdBackground: kbd === null ? 'missing' : getComputedStyle(kbd).backgroundColor,
        kbdRule: kbd === null ? 'missing' : getComputedStyle(kbd).boxShadow,
        buttonBackground: button === null ? 'missing' : getComputedStyle(button).backgroundColor,
        buttonBefore: button === null ? 'missing' : getComputedStyle(button, '::before').content,
        buttonAfter: button === null ? 'missing' : getComputedStyle(button, '::after').content,
        caretBefore: caret === null ? 'missing' : getComputedStyle(caret, '::before').content,
        caretColour: caret === null ? 'missing' : getComputedStyle(caret, '::before').color,
      };
    });

    expect(inline.kbdBackground).toBe('rgb(240, 242, 245)');
    // The cap's rule is a shadow's spread rather than a border, so this asks for a spread instead of
    // a border width. Changed on purpose: a browser floors every `border-width` to a whole CSS pixel
    // and a border grows the box it is on, while the renderer strokes its rectangle ON the fill's own
    // edge at the width the theme asked for — so a bordered cap was both a pixel too heavy and a
    // pixel too big in every direction. A shadow keeps its width and takes no room.
    expect(inline.kbdRule).not.toBe('none');
    // Read as the four lengths a shadow IS, rather than matched as a string. The pattern this
    // replaced ended in `\d` after the third `0px`, and the fourth length is the SPREAD — so
    // `"rgb(201, 208, 215) 0px 0px 0px 0px"`, a cap carrying no rule at all, matched it exactly as
    // `"…0.6667px"` did, and the `not.toBe('none')` above passed too because a zero-spread shadow is
    // still a shadow. "A key cap has a rule" was satisfied by a key cap with no rule.
    const shadow =
      /^(rgba?\([^)]*\))\s+(-?[\d.]+)px\s+(-?[\d.]+)px\s+(-?[\d.]+)px\s+(-?[\d.]+)px$/.exec(
        inline.kbdRule,
      );
    expect(shadow, `the key cap's rule reads ${JSON.stringify(inline.kbdRule)}`).not.toBeNull();
    if (shadow !== null) {
      // The theme's own `kbd.border-color`, arrived at through the resolver and the projection.
      expect(shadow[1], "the cap's rule is the theme's border colour").toBe('rgb(201, 208, 215)');
      // The renderer strokes the cap's rectangle on its own edge: no offset, no blur.
      expect(
        [shadow[2], shadow[3], shadow[4]].map(Number),
        'and is stroked on the box rather than cast off it',
      ).toEqual([0, 0, 0]);
      // …and it has a width. This is the whole of what "a key cap has a rule" claims.
      expect(Number(shadow[5]), 'and it is a rule rather than a bare tint').toBeGreaterThan(0);
    }
    expect(inline.buttonBackground).toBe('rgb(26, 78, 138)');
    // BOTH brackets, and the thin space inside each of them. Only the opening one was read, under a
    // comment that described the pair — so the closing bracket, which is a mark the page really
    // draws, was covered by nothing, and neither thin space was: `toContain('[')` is satisfied by a
    // `::before` of `"["` alone. The whole string is compared on each side now, against the template
    // this theme states rather than against the renderer's default, for the same reason the caret's
    // colour is: the stylesheet's fallbacks ARE the default pair, so a projection that emitted
    // nothing would leave the expected brackets on the page.
    expect(properties['--print-button-content-before'], 'the projection reads the button template').toBeDefined();
    expect(properties['--print-button-content-after'], 'both halves of it').toBeDefined();
    expect(inline.buttonBefore).toBe(`"${BUTTON_BRACKETS.before}"`);
    expect(inline.buttonAfter).toBe(`"${BUTTON_BRACKETS.after}"`);
    // With `icons: font` the caret is an empty element that needs a font this application never
    // loads; without a glyph of our own a menu path loses everything between its parts.
    expect(inline.caretBefore).toContain('›');
    // The colour the renderer carries INSIDE the caret template, which this theme sets away from the
    // gem's own. It used to be asserted as `rgb(177, 33, 70)` — the stylesheet's fallback, which is
    // the gem's default spelled out — so the check passed whether or not the projection emitted
    // anything at all. Both the property and the paint are compared now, against the theme's input.
    expect(properties['--print-menu-caret-font-color'], 'the projection reads the caret template').toBe(
      MENU_CARET_COLOUR,
    );
    expect(inline.caretColour).toBe(rgbOf(MENU_CARET_COLOUR));
  });

  test('a stem block opens the block margin under it, like every other block', async ({ page }) => {
    // `convert_stem` ends the way every block converter ends — `theme_margin :block, :bottom,
    // (next_enclosed_block node)` — so what follows a block of mathematics is `block.margin-bottom`,
    // not the paragraph rhythm and not nothing. Nothing here opened any: the next block sat one
    // WITHIN-paragraph line gap away, which on the bundled demo is 20px where the export leaves 39,
    // and 7px where an admonition follows against the page's 34.
    //
    // The two margins are deliberately different in the theme below, because the defect this guards
    // against is a block that takes the prose rhythm as much as one that takes none.
    await preparePrintDocument(page, {
      source: '= Doc\n\n[stem]\n++++\nx = y\n++++\n\nA paragraph after it.\n\nA second paragraph.\n',
      themeText: 'extends: default\nblock:\n  margin-bottom: 18\nprose:\n  margin-bottom: 6\n',
    });

    const gaps = await page.evaluate((perPoint) => {
      const stem = document.querySelector('[data-testid="page"] .stemblock');
      const paragraphs = [...document.querySelectorAll('[data-testid="page"] .paragraph')];
      if (stem === null || paragraphs.length < 2) return null;
      const gap = (above: Element, below: Element): number =>
        (below.getBoundingClientRect().top - above.getBoundingClientRect().bottom) / perPoint;
      return {
        underStem: gap(stem, paragraphs[0]),
        betweenParagraphs: gap(paragraphs[0], paragraphs[1]),
      };
    }, PIXELS_PER_POINT);

    expect(gaps, 'the preview lays out a stem block and the paragraphs after it').not.toBeNull();
    if (gaps === null) return;
    // 18pt and 6pt, the two rhythms the theme set, as the page opens them.
    expect(gaps.underStem).toBeCloseTo(18, 1);
    expect(gaps.betweenParagraphs).toBeCloseTo(6, 1);
  });

  test('a menu path does not hang below the line it is on', async ({ page }) => {
    // The caret element the markup carries is EMPTY under `icons: font`, and the stylesheet zeroes
    // its font size so that the `›` a document converted without icons carries is not drawn twice.
    // A zero font size with an inherited LENGTH line height is not a zero box, though: the box keeps
    // the whole inherited length with no content area inside it, so half of it hangs below the
    // baseline — several points more than the line's own descent, opening the gap to the line BELOW.
    //
    // The renderer has nothing there at all. `convert_inline_menu` joins the parts with the theme's
    // caret text and writes no other fragment, and the line's advance is `max_line_height + leading`
    // measured over the fragments that exist. So the step from a line carrying a menu path to the
    // next line is the plain step, exactly.
    const filler =
      'Alpha beta gamma delta epsilon zeta eta theta iota kappa lambda mu nu xi omicron pi rho sigma tau upsilon phi chi psi omega alpha beta gamma';
    await preparePrintDocument(page, {
      source: `= Doc\n:experimental:\n\n[#plain]\n${filler} ${filler}\n\n[#withmenu]\n${filler} menu:File[Export > PDF] ${filler}\n`,
      themeText: THEME,
    });

    const plain = await baselinesOf(page, '#plain p');
    const withMenu = await baselinesOf(page, '#withmenu p');
    expect(plain.length, 'the filler wraps to more than two lines').toBeGreaterThan(2);
    expect(withMenu.length, 'the menu paragraph wraps to more than two lines').toBeGreaterThan(2);

    // Which of the paragraph's lines the menu path landed on, found from the baselines themselves:
    // the first one at or below the top of the caret's own box.
    const caretTopPt = await page.evaluate((perPoint) => {
      const caret = document.querySelector('[data-testid="page"] #withmenu .menuseq .caret');
      const column = document.querySelector('[data-testid="page"]');
      if (caret === null || column === null) return -1;
      return (caret.getBoundingClientRect().top - column.getBoundingClientRect().top) / perPoint;
    }, PIXELS_PER_POINT);
    expect(caretTopPt, 'the preview lays out a caret').toBeGreaterThan(0);
    const caretLine = withMenu.findIndex((baseline) => baseline >= caretTopPt);
    expect(caretLine, 'the caret is on a line with one above and one below it').toBeGreaterThan(0);
    expect(caretLine).toBeLessThan(withMenu.length - 1);

    const plainStep = plain[1] - plain[0];
    const below = withMenu[caretLine + 1] - withMenu[caretLine];
    expect(
      Math.abs(below - plainStep),
      `the line under a menu path steps ${below.toFixed(2)}pt, a plain line ${plainStep.toFixed(2)}pt`,
    ).toBeLessThan(0.1);

    // And the line the caret IS on opens by its own fragment's height, the way the renderer's
    // `max_line_height` opens for a fragment set larger than the rest of the line. Zeroing the caret
    // element must not zero the glyph the rule beside it draws.
    const above = withMenu[caretLine] - withMenu[caretLine - 1];
    expect(
      above,
      `the line carrying a menu path steps ${above.toFixed(2)}pt, a plain line ${plainStep.toFixed(2)}pt`,
    ).toBeGreaterThan(plainStep + 0.1);
  });

  test('source blocks are highlighted, because the export always highlights them', async ({ page }) => {
    // Through the render worker, which is the only thing that puts token markup on the page at all:
    // Asciidoctor emits `<pre class="highlight"><code class="language-ruby">` and the worker replaces
    // its body with highlight.js spans. A page built from Asciidoctor's own output has no
    // `.hljs-string` anywhere, so a check written against one asks the stylesheet what colour it
    // WOULD use and never finds out whether anything is ever painted in it — the worker could stop
    // emitting token spans altogether and nothing here would notice.
    await preparePrintDocument(
      page,
      { source: DOCUMENT, themeText: THEME },
      await renderSourceWithWorker(DOCUMENT),
    );

    const token = await page.evaluate(() => {
      const element = document.querySelector('[data-testid="page"] pre .hljs-string');
      return element === null
        ? null
        : { text: element.textContent, colour: getComputedStyle(element).color };
    });

    expect(token, 'the worker marks the string in the source block as a string token').not.toBeNull();
    expect(token?.text, 'and the token it marked is the string the document carries').toContain('hello');
    // The colour the renderer's own palette gives a string, read out of the file that carries it
    // rather than restated: the export highlights with rouge under this palette, so a preview that
    // agreed with a number typed here would prove nothing about agreeing with the export.
    expect(token?.colour).toBe(rgbOf(PALETTE_STRING_COLOUR));
  });

  test("a heading's space above adds to the space the block before it left", async ({ page }) => {
    // The renderer moves the cursor down twice — once for the paragraph's `prose.margin-bottom` and
    // again for the heading's `heading.margin-top` — while CSS collapses two adjacent margins to the
    // larger of them. Collapsing quietly drops the smaller of the two at every section boundary, and
    // no measurement of either element on its own can see it.
    await preparePrintDocument(page, {
      source: '= Doc\n\nA paragraph before the section.\n\n== A Section\n\nA paragraph inside it.\n',
      themeText: 'extends: default\nprose:\n  margin-bottom: 12\nheading:\n  margin-top: 9\n',
    });

    const gap = await page.evaluate(() => {
      const before = document.querySelector('[data-testid="page"] #preamble .paragraph');
      const heading = document.querySelector('[data-testid="page"] h2');
      if (before === null || heading === null) return null;
      return heading.getBoundingClientRect().top - before.getBoundingClientRect().bottom;
    });

    expect(gap).not.toBeNull();
    // 12pt + 9pt, as pixels at 96/72. Collapsing would give 12pt alone.
    expect(gap ?? 0).toBeCloseTo((12 + 9) * (96 / 72), 1);
  });

  test("a footnote's marker is the bracketed number the converter inks", async ({ page }) => {
    // `ink_footnotes` writes `[<a anchor="_footnoteref_N">N</a>] ` — literal brackets around a link,
    // in the footnote's own typography. The HTML says `N.` instead, so the page has to say the same
    // thing the export says.
    //
    // This test used to assert that the NUMBER took the footnote's colour too, on the stated ground
    // that "an anchor fragment carries no colour of its own". That is not what the formatter does:
    // `transform.rb`'s `when :a` branch runs `update_fragment fragment, @theme_settings[:link]` for
    // every `<a>` that is not the invisible `<a id=…>` destination marker, and those settings carry
    // `theme.link_font_color`. Sampling the digit between the brackets on a reference raster of the
    // demo project gives the theme's link colour to the channel. So the expectation below is the
    // opposite of what it was, on purpose: the digit is the link colour and the brackets are not.
    await preparePrintDocument(page, {
      source: '= Doc\n\nA sentence.footnote:[The note itself.]\n',
      themeText: 'extends: default\nfootnotes:\n  font-color: 445566\nlink:\n  font-color: 0B7285\n',
    });

    // This harness converts with Asciidoctor directly, so it does not run the render worker's own
    // post-processing. The worker names the separator Asciidoctor emits as a bare text node — no
    // selector can reach one — and that named span is the markup the stylesheet is written against,
    // so it is put in here rather than left out and the rule left unexercised.
    await page.evaluate(() => {
      for (const entry of document.querySelectorAll('[data-testid="page"] #footnotes .footnote')) {
        for (const node of entry.childNodes) {
          if (!(node instanceof Text) || !node.data.startsWith('. ')) continue;
          const separator = document.createElement('span');
          separator.className = 'footnote-separator';
          separator.textContent = '. ';
          node.replaceWith(separator, document.createTextNode(node.data.slice(2)));
          break;
        }
      }
    });

    const marker = await page.evaluate(() => {
      const entry = document.querySelector('[data-testid="page"] #footnotes .footnote');
      const link = entry?.querySelector('a');
      const separator = entry?.querySelector('.footnote-separator');
      if (entry === null || entry === undefined || link === null || link === undefined) return null;
      return {
        before: getComputedStyle(link, '::before').content,
        after: getComputedStyle(link, '::after').content,
        colour: getComputedStyle(link).color,
        bracketColour: getComputedStyle(link, '::before').color,
        closingBracketColour: getComputedStyle(link, '::after').color,
        separatorShown: separator === null || separator === undefined ? 'none' : getComputedStyle(separator).display,
        // What a reader actually sees, with the hidden run taken out — a separator that is merely
        // overdrawn still leaves a full stop in the text a reader can select, search and copy.
        visible: [...entry.childNodes]
          .filter(
            (node) =>
              !(node instanceof HTMLElement) || getComputedStyle(node).display !== 'none',
          )
          .map((node) => node.textContent ?? '')
          .join('')
          .replaceAll(/\s+/g, ' ')
          .trim(),
      };
    });

    expect(marker).not.toBeNull();
    // The brackets, read off a page the external toolchain really rendered rather than transcribed
    // from the stylesheet's own `content`. `list-geometry`'s document carries a footnote, and its
    // reference inks the entry as `[1] The footnote's own text…` — so the opening bracket, the
    // closing one and the space after it are all statements the reference makes. Transcribing them
    // here would have agreed with whatever the stylesheet was written to emit.
    const reference = await textRuns(readFixture('list-geometry').referencePdf);
    const entry = reference.find((run) => /^\[\d+]\s/.test(run.text) && run.text.length > 20);
    expect(entry, "the reference PDF inks a footnote entry with the converter's own marker").toBeDefined();
    const bracketed = /^(\[)\d+(]\s)/.exec(entry?.text ?? '');
    expect(bracketed, 'and the marker is a bracketed number').not.toBeNull();
    expect(marker?.before).toBe(`"${bracketed?.[1] ?? ''}"`);
    expect(marker?.after).toBe(`"${bracketed?.[2] ?? ''}"`);
    expect(marker?.separatorShown).toBe('none');
    // The number, then the note. A full stop between them is the HTML's own separator surviving —
    // and surviving where a reader would still select, search and copy it, which is why this looks at
    // the text rather than at whether something was drawn over it. The space a reader sees after the
    // closing bracket is generated content, so it is asserted above rather than here.
    expect(marker?.visible ?? '').not.toMatch(/^\d+\./);
    // The digit is inside the `<a>`; the brackets are outside it in the renderer's own string, and
    // are generated content here for the same reason.
    expect(marker?.colour).toBe('rgb(11, 114, 133)');
    expect(marker?.bracketColour).toBe('rgb(68, 85, 102)');
    expect(marker?.closingBracketColour).toBe('rgb(68, 85, 102)');
  });

  test('table stripes land on the rows the renderer colours', async ({ page }) => {
    // prawn-table takes `row_colors` in turn over the BODY rows, from index zero: `even` gives it
    // `[body, stripe]` so the stripe lands on the second row, `odd` gives it `[stripe, body]` so it
    // lands on the first, and `all` gives it one colour. Getting the sense the wrong way round paints
    // a table that looks striped and is striped on the wrong rows.
    const rows = ['| a | 1', '| b | 2', '| c | 3'].join('\n\n');
    const table = (stripes: string) =>
      `[cols="1,1",options="header",stripes=${stripes}]\n|===\n| H1 | H2\n\n${rows}\n|===\n`;
    await preparePrintDocument(page, {
      source: `= Doc\n\n${table('even')}\n${table('odd')}\n${table('all')}\n`,
      themeText: 'extends: default\ntable:\n  body:\n    stripe-background-color: E6F0FA\n',
    });

    const striped = await page.evaluate(() =>
      [...document.querySelectorAll('[data-testid="page"] table.tableblock')].map((element) =>
        [...element.querySelectorAll('tbody tr')].map(
          (row) => getComputedStyle(row).backgroundColor === 'rgb(230, 240, 250)',
        ),
      ),
    );

    expect(striped).toEqual([
      [false, true, false],
      [true, false, true],
      [true, true, true],
    ]);
  });

  test('a block image sits where the theme says', async ({ page }) => {
    await preparePrintDocument(page, {
      source: '= Doc\n\nimage::x.png[A diagram,width=100]\n',
      themeText: THEME,
    });

    const margins = await page.evaluate(() => {
      const image = document.querySelector('[data-testid="page"] .imageblock img');
      if (image === null) return null;
      const style = getComputedStyle(image);
      return { left: style.marginLeft, right: style.marginRight, display: style.display };
    });

    // `image.align: center` has to become the margins that centre it. `margin: center` is not a
    // declaration, so a projection that carried the keyword would leave the image hard left with
    // every property still present and every existence check still passing.
    expect(margins?.display).toBe('block');
    expect(Number.parseFloat(margins?.left ?? '0')).toBeCloseTo(
      Number.parseFloat(margins?.right ?? '-1'),
      1,
    );
    expect(Number.parseFloat(margins?.left ?? '0')).toBeGreaterThan(0);
  });
});

/**
 * The admonition glyphs, measured as INK rather than as declared sizes.
 *
 * The check above asks whether the theme's value reached the box. It cannot see what the mask then
 * did inside that box, and for one glyph of the five the answer was wrong: `mask-size: contain` fits
 * the whole image inside, which for anything WIDER than tall means fitting it to the width. The
 * warning triangle is the only one of the renderer's five that is wider than its em — 576 units of
 * advance against a 512-unit em — so it alone came out an eighth short in BOTH directions while the
 * other four, all taller than wide, were right to the pixel and every declared property read back
 * exactly as written.
 *
 * The reference here is the committed SVG itself rather than a reference PDF, and it has to be: no
 * anchor fixture converts with `icons: font`, so no reference PDF in this suite draws one of these
 * glyphs at all. It is still the renderer's own rule being checked, because that rule is what the
 * asset encodes — `convert_admonition` draws the glyph as a CHARACTER at `size: icon_size`, so the
 * size is an em, and `generate-admonition-icons.mjs` writes each file with
 * `viewBox="0 0 <advance> <unitsPerEm>"` for exactly that reason. An `<img>` of the same file given
 * the same height is therefore the glyph as the page draws it, and the mask has to paint the same ink.
 */
test.describe('the admonition glyphs, as ink', () => {
  // Sampled well above CSS resolution so that a one-device-pixel edge is a small fraction of the
  // glyph rather than a few percent of it.
  test.use({ deviceScaleFactor: 4 });

  /**
   * A colour for each of the five, chosen to be one the renderer's own default is NOT.
   *
   * This table used to hold the gem's default colours and was never read: the ink measurement below
   * separated glyph from paper on a generic darkness threshold, and the comment above it claimed a
   * check on the colour that nothing performed. Restating the defaults would not have been one
   * either — the stylesheet's own fallbacks are those same values, so a projection that reached no
   * element would paint the expected colour anyway.
   *
   * They are the THEME's now, so each is an input this test chose: the projection has to carry it and
   * the mask has to paint it, and neither can be satisfied by a default.
   */
  const ICON_COLOURS: Readonly<Record<string, string>> = {
    note: '#0B7285',
    tip: '#7A5C00',
    important: '#A21B2B',
    warning: '#1F5C3A',
    caution: '#5B2C83',
  };

  /** The theme that sets them, written from the table above so the two cannot drift apart. */
  const ICON_THEME = [
    'extends: default',
    'admonition:',
    '  icon:',
    ...Object.entries(ICON_COLOURS).flatMap(([kind, colour]) => [
      `    ${kind}:`,
      `      stroke-color: ${colour.slice(1)}`,
    ]),
    '',
  ].join('\n');

  /** The five kinds, so every glyph is measured rather than the one that was wrong. */
  const ADMONITIONS = [
    '= Doc',
    ':icons: font',
    '',
    'NOTE: A note admonition.',
    '',
    'TIP: A tip admonition.',
    '',
    'IMPORTANT: An important admonition.',
    '',
    'WARNING: A warning admonition.',
    '',
    'CAUTION: A caution admonition.',
    '',
  ].join('\n');

  test('each glyph is the shape and size the file draws at that height', async ({ page }) => {
    const properties = await preparePrintDocument(page, { source: ADMONITIONS, themeText: ICON_THEME });
    // A mask is fetched when it is painted, not when it is declared.
    await page.screenshot();

    /** The box the ink of one screenshot occupies, in CSS pixels, and the colour most of it is. */
    const inkBox = async (
      png: Buffer,
    ): Promise<{ width: number; height: number; colour: [number, number, number] } | null> =>
      page.evaluate(
        async ({ base64, scale }) => {
          const image = new Image();
          image.src = `data:image/png;base64,${base64}`;
          await image.decode();
          const canvas = document.createElement('canvas');
          canvas.width = image.naturalWidth;
          canvas.height = image.naturalHeight;
          const context = canvas.getContext('2d');
          if (context === null) return null;
          context.drawImage(image, 0, 0);
          const { data } = context.getImageData(0, 0, canvas.width, canvas.height);
          let left = canvas.width;
          let top = canvas.height;
          let right = -1;
          let bottom = -1;
          // Which colour the ink IS, taken as the most common one over the inked pixels: a glyph's
          // interior is the fill exactly, and only its antialiased fringe is anything else.
          const counts = new Map<string, number>();
          for (let index = 0; index < data.length; index += 4) {
            // Anything that is neither the paper nor fully transparent is ink. Taken as a threshold
            // rather than as an exact colour so that both sides include the same antialiased fringe.
            const opaque = data[index + 3] > 128;
            const dark = data[index] < 200 || data[index + 1] < 200 || data[index + 2] < 200;
            if (!opaque || !dark) continue;
            const pixel = index / 4;
            const x = pixel % canvas.width;
            const y = Math.floor(pixel / canvas.width);
            if (x < left) left = x;
            if (x > right) right = x;
            if (y < top) top = y;
            if (y > bottom) bottom = y;
            const key = `${data[index]},${data[index + 1]},${data[index + 2]}`;
            counts.set(key, (counts.get(key) ?? 0) + 1);
          }
          if (right < 0) return null;
          const modal = [...counts.entries()].toSorted((a, b) => b[1] - a[1])[0][0];
          return {
            width: (right + 1 - left) / scale,
            height: (bottom + 1 - top) / scale,
            colour: modal.split(',').map(Number) as [number, number, number],
          };
        },
        { base64: png.toString('base64'), scale: 4 },
      );

    for (const kind of Object.keys(ICON_COLOURS)) {
      const iconHeight = await page.evaluate((name) => {
        const element = document.querySelector(`[data-testid="page"] .icon-${name}`);
        return element === null
          ? 0
          : Number.parseFloat(getComputedStyle(element, '::before').height);
      }, kind);
      expect(iconHeight, `the preview sizes the ${kind} icon`).toBeGreaterThan(0);

      // The same file, drawn by the browser at the same height, with its own aspect ratio: this is
      // the glyph the renderer sets at `size: icon_size`.
      await page.evaluate(
        ({ name, height }) => {
          document.querySelector('#glyph-probe')?.remove();
          const probe = document.createElement('img');
          probe.id = 'glyph-probe';
          probe.src = `/vendor/admonition-icons/${name}.svg`;
          probe.style.cssText = `display:block;height:${height}px;width:auto;background:#fff`;
          document.body.append(probe);
        },
        { name: kind, height: iconHeight },
      );
      await page.locator('#glyph-probe').waitFor();
      const expected = await inkBox(await page.locator('#glyph-probe').screenshot());
      // The CELL rather than the `<i>`: the glyph is a `vertical-align: middle` inline-block, so it
      // stands taller than the inline box of the element carrying it and a screenshot of that element
      // would clip the very thing being measured.
      const painted = await inkBox(
        await page.locator(`[data-testid="page"] .admonitionblock.${kind} td.icon`).screenshot(),
      );
      await page.evaluate(() => document.querySelector('#glyph-probe')?.remove());

      expect(expected, `the ${kind} file draws ink`).not.toBeNull();
      expect(painted, `the preview paints the ${kind} glyph`).not.toBeNull();
      if (expected === null || painted === null) continue;

      // WHAT colour that ink is, which is the half the shape comparison cannot see: a mask paints
      // the element's own `background-color`, so a glyph in the wrong colour is the same glyph. The
      // theme's value for this kind, through the property it has to travel by — asserted first, so a
      // projection that emitted nothing fails here instead of letting the stylesheet's fallback (the
      // renderer's default, which is what this table used to hold) paint the expected answer.
      const wanted = ICON_COLOURS[kind];
      expect(properties[`--print-admonition-icon-${kind}-font-color`], `the ${kind} icon's colour`).toBe(
        wanted,
      );
      const channels = colourOf(wanted, `the ${kind} icon's colour`);
      for (const [channel, value] of painted.colour.entries()) {
        expect(
          Math.abs(value - channels[channel]),
          `${kind}: painted rgb(${painted.colour.join(', ')}), theme ${wanted}`,
        ).toBeLessThanOrEqual(PRINT_FIDELITY_TOLERANCE.colourChannel);
      }

      // A quarter of a CSS pixel, which is the device pixel both measurements are quantised in.
      expect(
        Math.abs(painted.height - expected.height),
        `${kind}: preview ${painted.height.toFixed(2)}px tall, the file at this size ${expected.height.toFixed(2)}px`,
      ).toBeLessThanOrEqual(0.3);
      expect(
        Math.abs(painted.width - expected.width),
        `${kind}: preview ${painted.width.toFixed(2)}px wide, the file at this size ${expected.width.toFixed(2)}px`,
      ).toBeLessThanOrEqual(0.3);
    }
  });
});
