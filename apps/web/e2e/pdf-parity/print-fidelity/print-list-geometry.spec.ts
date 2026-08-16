/**
 * @file The column a list's marker is set in, and the vertical rhythm around it.
 *
 * Everything measured here is arithmetic the renderer does explicitly and a browser does differently
 * on its own, which is why every one of them was wrong while the typographic anchors passed.
 *
 * A browser's `list-style-type: disc` is not the renderer's disc: the renderer writes the GLYPH
 * `Bullets[:disc]` — U+2022 — in the face and at the size in force where the list sits, and places it
 * itself, one `rendered_width_of_char 'x'` clear of the text column. A browser synthesises a circle of
 * its own diameter and leaves a gap of its own choosing. Neither number is a rounding of the other.
 *
 * The rhythm around a list is the same kind of difference. `convert_list` opens no bottom margin at
 * all for a nested list and `convert_list_item` spaces an item's text from the list under it by
 * `list.item-spacing` rather than by a paragraph gap, so the renderer's marker pitch is one number
 * from the first item to the last however deep the list goes. And `theme_margin` swaps the prose
 * rhythm for the block one whenever what comes next is a SECTION, which is why the space above a
 * heading that follows a paragraph is not the space that follows a paragraph anywhere else.
 *
 * WHICH INSTRUMENT READS THE REFERENCE, and where it changes. Most of what is compared below is the
 * POSITION of a run of text — where it starts, and which baseline it sits on — and for those the text
 * layer is read, because that is what the text layer records exactly. Two of the eight checks reach
 * past it and RASTERISE the reference page, because what they need is not something the file names:
 *
 *   - "a callout list is the ring, one x, then the explanation" reads its positions from the text
 *     layer like the rest, and then asks a second question the text layer cannot answer: how far the
 *     ring GLYPH's own outline stands above and below the baseline the run places it on. The text
 *     layer records the run, not the outline. So the page is rasterised at {@link RING_DPI} and the
 *     ring is measured where it was drawn — see {@link glyphInkBox} for why it is measured at all.
 *   - "no rule is drawn above the footnote list" is a claim about a mark the file DRAWS rather than
 *     about anything it names, and rasterises throughout. The page is taken at {@link DPI} and the
 *     band between the last body line and the first entry is asked for its longest contiguous run of
 *     ink.
 *
 * Those two carry a raster's own precision rather than the text layer's, which is why the resolution
 * each uses is argued where it is declared. This file used to open by saying the reference side was
 * read "from the text layer rather than from a raster" and that "every subject here is the POSITION
 * of a run of text", which read as a guarantee about every number below and was untrue of both.
 *
 * The preview's side is read from the DOM, and the marker's gutter from the marker box's own margin —
 * the length the stylesheet computes from the face's `x` advance is the same length the renderer
 * computes, so comparing it against the gap the reference actually leaves is a comparison of two
 * independent derivations.
 */

import { expect, test, type Page } from '@playwright/test';
import {
  PRINT_FIDELITY_TOLERANCE,
  drawnRuns,
  pageRasters,
  sameColour,
  textRuns,
  type Rgb,
  type TextRun,
} from '../harness/pdftools';
import {
  PIXELS_PER_POINT,
  advanceWidthPt,
  baselinesOf,
  colourOf,
  preparePrintPage,
  readFixture,
} from './harness';

/** The fixture this file is about, and the only one that carries every construct it measures. */
const FIXTURE = 'list-geometry';

/** The resolution the reference is rasterised at, for the one check that asks about a drawn rule. */
const DPI = 150;

/**
 * How far two independently-derived positions may differ.
 *
 * Tighter than the shared geometry tolerance because nothing here is rasterised: both sides are
 * lengths computed from the same theme and the same face metrics, so a difference of more than a
 * hundredth of a point means one of the two derivations is not the renderer's.
 */
const DERIVED_PT = 0.05;

/** The bullet glyphs the renderer's `Bullets` table names, by nesting depth. */
const BULLETS = ['•', '◦', '▪'];

/**
 * The resolution the callout ring's own glyph box is measured at.
 *
 * Six hundred rather than the hundred and fifty everything else here uses, because the quantity is
 * a tenth of the ring: at 150 dpi one pixel is a twenty-fifth of the glyph and the antialiased edge
 * is most of the measurement, while at 600 the same edge is a hundredth of it and the box comes out
 * the same to within a pixel from either of the two rings measured.
 */
const RING_DPI = 600;

/** A glyph's ink, as the reference paints it, in ems of the size it is drawn at. */
interface GlyphInkBox {
  /** How far its topmost ink stands above the baseline. */
  readonly aboveBaselineEm: number;
  /** How far its lowest ink hangs below it. */
  readonly belowBaselineEm: number;
  /** The whole of it, top to bottom. */
  readonly heightEm: number;
}

/**
 * Where one drawn glyph's ink sits about its own baseline, read out of the reference's paint.
 *
 * The alternative is to type the numbers in — a ring `0.906em` across sitting `0.093em` below the
 * baseline — and those are the very numbers the stylesheet under test draws the ring with. A spec
 * that restates them compares the preview against itself and passes whatever either of them says; the
 * one thing it cannot notice is the two of them being wrong together, which is exactly the case where
 * the ring does not match the page.
 *
 * So the glyph is measured where it was actually drawn. Each row of the raster inside the glyph's own
 * advance is reduced to its darkest pixel, and the outline's edge is taken where that darkness
 * crosses half of the glyph's full ink — with the partial row weighted by how dark it is, so an
 * antialiased edge contributes the fraction of a pixel it covers rather than a whole one or none.
 * Ink only, and only within the advance, so neither the words beside the ring nor the lines above and
 * below it can join the run: the walk starts inside the glyph and stops at the first blank row.
 *
 * @param raster - The rasterised page the glyph is drawn on.
 * @param run - The run that drew it: its position, its baseline and its size.
 * @returns The glyph's ink box.
 */
function glyphInkBox(raster: ReturnType<typeof pageRasters>[number], run: TextRun): GlyphInkBox {
  const perPx = 72 / raster.dpi;
  const baselinePx = ((raster.heightPx * 72) / raster.dpi - run.yPt) / perPx;
  const sizePx = run.fontSizePt / perPx;
  // The glyph's own advance, less a fiftieth at each end so a neighbour's ink cannot reach in.
  const from = Math.floor((run.xPt + 0.02 * run.fontSizePt) / perPx);
  const to = Math.ceil((run.xPt + 0.98 * run.fontSizePt) / perPx);
  const darkest = (y: number): number => {
    let value = 0;
    for (let x = from; x <= to; x += 1) {
      const [red, green, blue] = raster.colourAt(x, y);
      value = Math.max(value, 255 - Math.min(red, green, blue));
    }
    return value;
  };

  // A circled digit's ring is inked all the way round, so a row a third of the way up it is inside
  // the outline whatever the glyph is; the walk grows outwards from there.
  const inside = Math.round(baselinePx - 0.36 * sizePx);
  const full = darkest(inside);
  expect(full, 'the reference inks the glyph this is measuring').toBeGreaterThan(40);
  const half = full / 2;
  let top = inside;
  while (darkest(top - 1) >= half) top -= 1;
  let bottom = inside;
  while (darkest(bottom + 1) >= half) bottom += 1;
  // The partial row beyond each end, as the fraction of a pixel its darkness says it covers.
  const topEdge = top - darkest(top - 1) / full;
  const bottomEdge = bottom + 1 + darkest(bottom + 1) / full;

  return {
    aboveBaselineEm: (baselinePx - topEdge) / sizePx,
    belowBaselineEm: (bottomEdge - baselinePx) / sizePx,
    heightEm: (bottomEdge - topEdge) / sizePx,
  };
}

/** One line of the reference, as the marker that opens it and the text that follows. */
interface ReferenceItem {
  /** The marker's own run. */
  readonly marker: TextRun;
  /** The first run of the item's text. */
  readonly text: TextRun;
}

/**
 * Pair every marker run with the text run beside it.
 *
 * The renderer draws a marker as a run of its own, at its own position, and then the item's text at
 * the column the list is indented to — so a marker and the first text run sharing a baseline are the
 * two halves of one item. The synthetic space run pdf.js inserts across the gap between them is
 * skipped: it is the reader's reconstruction of a gap, not something the file draws.
 *
 * @param runs - Every run in the reference.
 * @param markers - The marker strings to look for.
 * @returns One entry per item, in reading order.
 */
function itemsMarkedWith(runs: readonly TextRun[], markers: readonly string[]): ReferenceItem[] {
  const found: ReferenceItem[] = [];
  for (const [index, run] of runs.entries()) {
    if (!markers.includes(run.text)) continue;
    const text = runs
      .slice(index + 1)
      .find(
        (candidate) =>
          candidate.page === run.page &&
          // The same LINE, not the same baseline: a callout list's ring is set at the conum's own
          // baseline and its explanation at the body's, which is the offset measured further down.
          Math.abs(candidate.yPt - run.yPt) < run.fontSizePt / 2 &&
          candidate.xPt > run.xPt &&
          candidate.text.trim() !== '',
      );
    if (text !== undefined) found.push({ marker: run, text });
  }
  return found;
}

/**
 * The colour the reference inks a list's markers in, and the colour it inks body text in.
 *
 * A marker has a colour of its own. `convert_list_item` opens by reading the theme's
 * `list_marker_font_color` and falling back to the document's own `font_color` only when the theme
 * names none, and this fixture's theme sets `list.marker.font-color` to a dark red
 * (`list-theme.yml`) precisely so that the key has somewhere to be visible. Nothing in this
 * suite read it, and the stylesheet's own fallback is `currentcolor` — so deleting the declaration
 * outright left every marker drawn in the body's colour, which is a perfectly plausible-looking
 * mark, and no comparison anywhere noticed.
 *
 * BOTH colours are returned because only the pair is a check. The body's ink is what makes a marker
 * that fell back to `currentcolor` fail rather than pass, and the caller is handed it rather than
 * asked to trust that the two differ: the disagreement is asserted here, on the reference's own
 * numbers, before either is used. Measured on this fixture: the markers are `rgb(139, 0, 0)` and the
 * body is `rgb(51, 51, 51)`.
 *
 * Read with {@link drawnRuns}, which is the only reader in the harness that carries a fill colour at
 * all. It attaches no position to a run and needs none here: the bullet glyphs are drawn nowhere
 * else in this document, and every marker run is required to agree with every other before the
 * colour is used, so a stray glyph elsewhere on the page would fail rather than be averaged in.
 *
 * @param bytes - The reference PDF's bytes.
 * @param markers - The marker strings to look for.
 * @returns The marker colour and the body colour.
 * @throws {Error} When the reference draws no body paragraph to contrast the markers with.
 */
async function referenceInk(
  bytes: Uint8Array,
  markers: readonly string[],
): Promise<{ marker: Rgb; body: Rgb }> {
  const drawn = await drawnRuns(bytes);
  const inked = drawn.filter((run) => markers.includes(run.text.trim()));
  expect(inked.length, 'the reference inks the list markers').toBeGreaterThan(0);
  for (const run of inked) {
    expect(
      sameColour(run.colour, inked[0].colour),
      `the reference inks every marker alike: ${inked.map((each) => each.colour.join(',')).join(' | ')}`,
    ).toBe(true);
  }
  const body = drawn.find((run) => run.text.startsWith('A paragraph that ends'));
  if (body === undefined) {
    throw new Error(
      'referenceInk: the reference draws no body paragraph to contrast the marker colour with. ' +
        'Without it a marker that fell back to the body\'s own ink would pass this check.',
    );
  }
  expect(
    sameColour(inked[0].colour, body.colour),
    `the theme gives the marker a colour the body is not set in: marker ${inked[0].colour.join(',')}, ` +
      `body ${body.colour.join(',')}`,
  ).toBe(false);
  return { marker: inked[0].colour, body: body.colour };
}

/** Every run of the reference's own text for one paragraph, found by how it starts. */
function runsStartingWith(runs: readonly TextRun[], prefix: string): TextRun[] {
  const first = runs.findIndex((run) => run.text.startsWith(prefix));
  if (first === -1) return [];
  return runs.filter((run) => run.page === runs[first].page && run.yPt === runs[first].yPt);
}

/** What the preview made of one list item: where its text starts, and where its marker box ends. */
interface PreviewItem {
  /** The text column, in points from the page column's left edge. */
  readonly textPt: number;
  /** The gap between the marker box's right edge and that column, in points. */
  readonly gutterPt: number;
  /** The marker's own content, as the stylesheet asks for it. */
  readonly marker: string;
  /**
   * How wide the marker box the browser laid out actually is, in points.
   *
   * The one property of a marker drawn from a `counter()` that says which STRING was drawn. A
   * computed `content` reports the expression rather than the glyphs (see the ordered-marker check),
   * and generated content reaches neither the DOM nor Chromium's accessibility tree — verified
   * directly against `Accessibility.getFullAXTree`, which carries no node for any of these markers.
   * Its used width does reach a computed style, and it is the advance of whatever the browser put
   * there.
   */
  readonly markerWidthPt: number;
  /** The colour the marker is drawn in, as the browser resolved it. */
  readonly markerColour: string;
  /** The size the marker is set at, in points. */
  readonly fontSizePt: number;
  /** The item's box top, in points from the page column's top. */
  readonly topPt: number;
}

/**
 * Measure every item of every list on the page.
 *
 * @param page - The browser page.
 * @param selector - A selector for the list items.
 * @returns One entry per item, in document order.
 */
async function previewItems(page: Page, selector: string): Promise<PreviewItem[]> {
  return page.evaluate(
    ({ selector: css, perPoint }) => {
      const column = document.querySelector('[data-testid="page"]');
      if (column === null) return [];
      const origin = column.getBoundingClientRect();
      return [...document.querySelectorAll(`[data-testid="page"] ${css}`)].map((item) => {
        const box = item.getBoundingClientRect();
        const marker = getComputedStyle(item, '::before');
        return {
          textPt: (box.left - origin.left) / perPoint,
          gutterPt: Number.parseFloat(marker.marginRight) / perPoint,
          // The quotes a computed `content` is reported inside are the CSS syntax, not the glyph.
          marker: marker.content.replaceAll('"', ''),
          markerWidthPt: Number.parseFloat(marker.width) / perPoint,
          markerColour: marker.color,
          fontSizePt: Number.parseFloat(marker.fontSize) / perPoint,
          topPt: (box.top - origin.top) / perPoint,
        };
      });
    },
    { selector, perPoint: PIXELS_PER_POINT },
  );
}

/** The differences between consecutive values, which is what a pitch is. */
function steps(values: readonly number[]): number[] {
  return values.slice(1).map((value, index) => value - values[index]);
}

test.describe('the column a list marker is set in, and the rhythm around it', () => {
  test('a bullet is the renderer\'s own glyph, one x clear of the text column', async ({ page }) => {
    // Three depths, because the renderer walks disc, circle, square by nesting depth and each is a
    // different glyph of a different width — a preview that drew one browser-synthesised circle at
    // every depth agreed with the page at none of them.
    const fixture = readFixture(FIXTURE);
    await preparePrintPage(page, fixture);

    const runs = await textRuns(fixture.referencePdf);
    const reference = itemsMarkedWith(runs, BULLETS);
    expect(reference.length, 'the reference draws the bullets').toBe(6);
    const ink = await referenceInk(fixture.referencePdf, BULLETS);

    const preview = await previewItems(page, '.ulist li');
    expect(preview.length, 'the preview lays every item out').toBe(reference.length);

    for (const [index, item] of reference.entries()) {
      const mine = preview[index];
      const where = `bullet ${index + 1} (${item.marker.text})`;
      expect(mine.marker, `${where}: the preview draws the glyph the renderer names`).toBe(item.marker.text);
      // …in the colour the renderer inks it in, which is a theme key of the marker's own and not the
      // one the text around it takes. `referenceInk` has already established that the two are
      // different on the page, so a marker drawn at the stylesheet's `currentcolor` fallback fails
      // here rather than passing on the body's ink.
      expect(
        sameColour(colourOf(mine.markerColour, `${where}: the preview's marker colour`), ink.marker),
        `${where}: preview inks it ${mine.markerColour}, page rgb(${ink.marker.join(', ')}); the body is ` +
          `rgb(${ink.body.join(', ')})`,
      ).toBe(true);
      expect(
        Math.abs(mine.fontSizePt - item.marker.fontSizePt),
        `${where}: preview sets it at ${mine.fontSizePt.toFixed(2)}pt, page ${item.marker.fontSizePt.toFixed(2)}pt`,
      ).toBeLessThanOrEqual(PRINT_FIDELITY_TOLERANCE.fontSizePt);

      // The list's own indent, which decides where the item's text starts.
      const textPt = item.text.xPt;
      expect(
        Math.abs(mine.textPt - textPt),
        `${where}: preview indents the text to ${mine.textPt.toFixed(2)}pt, page ${textPt.toFixed(2)}pt`,
      ).toBeLessThanOrEqual(PRINT_FIDELITY_TOLERANCE.geometryPt);

      // The gutter itself: `bounds.left - marker_gap + character_spacing_correction` is where the
      // renderer puts the marker's right edge, and the marker run's own advance says where that is.
      const gutterPt = item.text.xPt - (item.marker.xPt + item.marker.widthPt);
      expect(
        Math.abs(mine.gutterPt - gutterPt),
        `${where}: preview leaves ${mine.gutterPt.toFixed(3)}pt, page ${gutterPt.toFixed(3)}pt`,
      ).toBeLessThanOrEqual(DERIVED_PT);
    }
  });

  test('an ordered marker is right-aligned to the same column, at the same gutter', async ({ page }) => {
    // The markers of an ordered list are of DIFFERENT widths — `a.` and `b.` are not the same number
    // of points — and the renderer right-aligns each into a box that ends at one shared column. A
    // gutter measured from the wrong side is a marker column that wanders with the numbering.
    const fixture = readFixture(FIXTURE);
    await preparePrintPage(page, fixture);

    const runs = await textRuns(fixture.referencePdf);
    const reference = itemsMarkedWith(runs, ['1.', '2.', '3.', 'a.', 'b.']);
    expect(reference.length, 'the reference draws the numbers').toBe(5);

    const preview = await previewItems(page, '.olist li');
    expect(preview.length, 'the preview lays every step out').toBe(reference.length);

    // The face the marker is laid out in, read off the marker itself rather than assumed: the
    // advance below is only a statement about which STRING was drawn if it is measured in the face
    // the browser really used to draw it.
    const markerFont = await page.evaluate((perPoint) => {
      const item = document.querySelector('[data-testid="page"] .olist li');
      if (item === null) throw new Error('the preview lays out no ordered list');
      const marker = getComputedStyle(item, '::before');
      return {
        family: marker.fontFamily,
        weight: marker.fontWeight,
        style: marker.fontStyle,
        sizePt: Number.parseFloat(marker.fontSize) / perPoint,
      };
    }, PIXELS_PER_POINT);

    for (const [index, item] of reference.entries()) {
      const mine = preview[index];
      const where = `step ${index + 1} (${item.marker.text})`;
      // A counter expression is what a computed `content` reports; no browser resolves it to the
      // number it will draw. What can be held from the expression alone is that the marker IS the
      // list's own counter followed by a full stop, which is the string `convert_list_item` builds
      // (`%(#{index}.)`) — and that is ALL it holds. `counter(list-item, upper-alpha) .` matches this
      // pattern exactly as `lower-alpha` does, so on its own it passes a preview drawing `A.` where
      // the page draws `a.`; the numbering style, which is the only part of the marker a reader
      // actually sees, is inside the part the pattern skips over.
      expect(mine.marker, `${where}: the preview draws a counter and a full stop`).toMatch(
        /^counter\(list-item[^)]*\) \.$/,
      );
      // So the glyphs are compared by their ADVANCE, which is the one property of a counter marker
      // that reaches a measurement. The string the browser generates is in neither the DOM nor
      // Chromium's accessibility tree — checked directly against `Accessibility.getFullAXTree`,
      // which carries no node for any of these markers — but the box it laid out for it has a used
      // width, and `advanceWidthPt` will set an arbitrary string in the same face on the same page.
      // Setting the string the REFERENCE draws and comparing the two widths is therefore a
      // comparison of the marker the preview renders against the marker the page renders.
      //
      // Measured on this fixture: the reference's own `1.` sets to 8.900pt against a marker box laid
      // out at 8.906pt, `a.` to 8.943 against 8.953, `b.` to 9.502 against 9.504 — 0.010pt at worst,
      // well inside the 0.05pt bound. Under the mutation this exists for — `lower-alpha` changed to
      // `upper-alpha` in `src/styles/print-preview.css` — the preview lays `A.` out at 10.512pt
      // against the 8.943pt the page's `a.` needs, which is 1.57pt of signal against a 0.05pt bound.
      //
      // Deliberately NOT compared against the PDF's own advance for the run, which is half a point
      // shorter: prawn inks a marker inside `character_spacing(-0.5)` (`converter.rb:1715-1721`) and
      // hands the same half point back through `character_spacing_correction`, which is the `- 0.5pt`
      // the stylesheet's `margin-right` carries and which the gutter comparison below is what really
      // checks. Measured: 8.399pt in the file against the 8.900pt the same string sets to here.
      const markerPt = await advanceWidthPt(page, item.marker.text, markerFont, markerFont.sizePt);
      expect(
        Math.abs(mine.markerWidthPt - markerPt),
        `${where}: the preview's marker box is ${mine.markerWidthPt.toFixed(3)}pt wide, the page's ` +
          `"${item.marker.text}" sets to ${markerPt.toFixed(3)}pt in the same face`,
      ).toBeLessThanOrEqual(DERIVED_PT);
      const gutterPt = item.text.xPt - (item.marker.xPt + item.marker.widthPt);
      expect(
        Math.abs(mine.gutterPt - gutterPt),
        `${where}: preview leaves ${mine.gutterPt.toFixed(3)}pt, page ${gutterPt.toFixed(3)}pt`,
      ).toBeLessThanOrEqual(DERIVED_PT);
      const textPt = item.text.xPt;
      expect(
        Math.abs(mine.textPt - textPt),
        `${where}: preview indents the text to ${mine.textPt.toFixed(2)}pt, page ${textPt.toFixed(2)}pt`,
      ).toBeLessThanOrEqual(PRINT_FIDELITY_TOLERANCE.geometryPt);
    }
  });

  test('a nested list keeps the pitch of the list around it', async ({ page }) => {
    // `convert_list` ends with `theme_margin :prose, :bottom … unless node.nested?` — no bottom margin
    // at all for a nested list — and `convert_list_item` gives an item whose only other content is one
    // nested list a bottom margin of `list.item-spacing` rather than the paragraph gap. Together those
    // make the marker pitch a single number from the first item to the last. The preview spaced a
    // nested list like a paragraph at both ends, which opened an extra gap above the first nested item
    // and below the last while leaving the plain runs of items correct.
    const fixture = readFixture(FIXTURE);
    await preparePrintPage(page, fixture);

    const runs = await textRuns(fixture.referencePdf);
    const bullets = itemsMarkedWith(runs, BULLETS);
    expect(bullets.length, 'the reference draws every bullet').toBe(6);
    // Downwards on the page is downwards in the list; the text layer measures upwards from the page's
    // bottom edge, so a pitch is the drop from one baseline to the next.
    const referencePitch = steps(bullets.map((item) => -item.marker.yPt));
    for (const pitch of referencePitch) {
      expect(
        Math.abs(pitch - referencePitch[0]),
        `the reference's own pitch is one number: ${referencePitch.map((p) => p.toFixed(2)).join(', ')}`,
      ).toBeLessThanOrEqual(DERIVED_PT);
    }

    const preview = await previewItems(page, '.ulist li');
    const previewPitch = steps(preview.map((item) => item.topPt));
    expect(previewPitch.length).toBe(referencePitch.length);
    for (const [index, pitch] of previewPitch.entries()) {
      expect(
        Math.abs(pitch - referencePitch[index]),
        `item ${index + 2}: preview pitch ${pitch.toFixed(2)}pt, page ${referencePitch[index].toFixed(2)}pt`,
      ).toBeLessThanOrEqual(PRINT_FIDELITY_TOLERANCE.geometryPt);
    }
  });

  test('a callout list is the ring, one x, then the explanation', async ({ page }) => {
    // `convert_colist_item` measures the marker column as `rendered_width_of_string %(#{glyph}x)` in
    // the CONUM's face, centres the ring in it and indents the explanation by the whole width — so the
    // air either side of the ring is half an `x` and nothing else. It also inks the ring inside
    // `theme_font :conum`, in a box opened at the same cursor as the words, which is what sets the ring
    // off the explanation's own baseline by the difference between the two constructs' line metrics.
    const fixture = readFixture(FIXTURE);
    const prepared = await preparePrintPage(page, fixture);

    const runs = await textRuns(fixture.referencePdf);
    const rings = itemsMarkedWith(runs, ['①', '②', '③']);
    // The listing above the list carries the same glyphs; only the ones beside an explanation are set
    // in the conum's own size, which is what tells the two apart.
    const explanations = rings.filter((item) => item.marker.fontSizePt !== item.text.fontSizePt);
    expect(explanations.length, 'the reference draws three explanations').toBe(3);

    const preview = await page.evaluate((perPoint) => {
      const column = document.querySelector('[data-testid="page"]');
      const list = document.querySelector('[data-testid="page"] .colist');
      if (column === null || list === null) return null;
      const origin = column.getBoundingClientRect();
      return [...list.querySelectorAll('tr')].map((row) => {
        const cells = [...row.children];
        const ring = row.querySelector('.conum');
        return {
          listLeftPt: (list.getBoundingClientRect().left - origin.left) / perPoint,
          markerColumnPt: cells[0].getBoundingClientRect().width / perPoint,
          textPt: (cells[1].getBoundingClientRect().left - origin.left) / perPoint,
          // The glyph's ADVANCE box, which is what the renderer centres — the drawn ring is inset
          // inside it by the face's own side bearing, and the stylesheet carries that as the ring's
          // inline margin so that the whole mark advances the em the glyph advances.
          ringLeftPt:
            ring === null
              ? 0
              : (ring.getBoundingClientRect().left - origin.left - Number.parseFloat(getComputedStyle(ring).marginLeft)) /
                perPoint,
          ringTopPt: ring === null ? 0 : (ring.getBoundingClientRect().top - origin.top) / perPoint,
          ringHeightPt: ring === null ? 0 : ring.getBoundingClientRect().height / perPoint,
          rowTopPt: (row.getBoundingClientRect().top - origin.top) / perPoint,
        };
      });
    }, PIXELS_PER_POINT);

    expect(preview, 'the preview lays the callout list out').not.toBeNull();
    if (preview === null) return;
    expect(preview.length).toBe(explanations.length);

    // Both sides are measured from the LIST's own left edge, so the comparison is about the marker
    // column rather than about where the page margin happens to put the list.
    const referenceLeftPt = prepared.marginPt.left;

    for (const [index, item] of explanations.entries()) {
      const mine = preview[index];
      const where = `explanation ${index + 1}`;
      expect(
        Math.abs(mine.textPt - mine.listLeftPt - (item.text.xPt - referenceLeftPt)),
        `${where}: preview indents the explanation ${(mine.textPt - mine.listLeftPt).toFixed(2)}pt, page ${(
          item.text.xPt - referenceLeftPt
        ).toFixed(2)}pt`,
      ).toBeLessThanOrEqual(PRINT_FIDELITY_TOLERANCE.geometryPt);
      // Half an `x` of air before the ring, which is what centring it in that column comes to.
      expect(
        Math.abs(mine.ringLeftPt - mine.listLeftPt - (item.marker.xPt - referenceLeftPt)),
        `${where}: preview sets the ring at ${(mine.ringLeftPt - mine.listLeftPt).toFixed(2)}pt, page ${(
          item.marker.xPt - referenceLeftPt
        ).toFixed(2)}pt`,
      ).toBeLessThanOrEqual(PRINT_FIDELITY_TOLERANCE.geometryPt);
    }

    // And the ring's height above the words, which is the whole of what `theme_font :conum` does to
    // it. The glyph box a circled digit occupies is read out of the reference's own paint rather than
    // typed in: the stylesheet places the ring from a height and a baseline offset of its own, so a
    // spec restating those two numbers would agree with it however wrong they both were.
    const rasters = pageRasters(fixture.referencePdf, RING_DPI);
    const boxes = explanations.map((item) => glyphInkBox(rasters[item.marker.page - 1], item.marker));
    // What the reference says, before the preview is asked anything: one glyph drawn three times is
    // one box, so a measurement that came out differently for two of them is not measuring the glyph.
    for (const box of boxes) {
      expect(
        Math.abs(box.heightEm - boxes[0].heightEm),
        `the reference draws one ring: ${boxes.map((each) => each.heightEm.toFixed(4)).join(', ')}`,
      ).toBeLessThanOrEqual(0.005);
      expect(
        Math.abs(box.aboveBaselineEm - boxes[0].aboveBaselineEm),
        'and sets every one of them at the same height above its baseline',
      ).toBeLessThanOrEqual(0.005);
    }

    const first = explanations[0];
    // The ring the preview draws is that same box: a box of the wrong height cannot sit at the right
    // top and the right bottom at once, so this is the half of the claim a position cannot make.
    expect(
      Math.abs(preview[0].ringHeightPt - boxes[0].heightEm * first.marker.fontSizePt),
      `preview draws the ring ${preview[0].ringHeightPt.toFixed(2)}pt tall, the page's glyph ${(
        boxes[0].heightEm * first.marker.fontSizePt
      ).toFixed(2)}pt`,
    ).toBeLessThanOrEqual(PRINT_FIDELITY_TOLERANCE.geometryPt);

    const ringTopFromTextBaselinePt =
      first.marker.yPt + boxes[0].aboveBaselineEm * first.marker.fontSizePt - first.text.yPt;
    // `baselinesOf` throws when the explanation sets no line, so there is no guard here and no way
    // past the signed pair below: the previous `not.toBeNull()` was satisfied by an empty answer and
    // the `return` under it skipped the rest of this test without failing anything.
    const previewBaselines = await baselinesOf(page, '.colist td + td');
    const previewRingTop = preview[0].ringTopPt - previewBaselines[0];
    // The one comparison in this file that crosses the browser's line model and prawn's — the ring's
    // top against a baseline the browser placed — so it is the one that carries the quantisation
    // allowance, whose arithmetic is recorded where it is declared.
    //
    // SIGNED, and the pair is what keeps the allowance from swallowing an error of its own size. The
    // ring's top is placed by the cell's own padding, which is arithmetic; the explanation's baseline
    // is placed by Chromium, which rounds the face's ascent and descent to whole pixels and FLOORS
    // the half-leading it derives from them. That error is one-signed: the derivation at
    // `lineBoxQuantisationPt` puts the baseline up to 1.5 CSS pixels ABOVE where prawn puts it and
    // half a pixel below — and a baseline placed higher makes this difference, measured downward,
    // LARGER. So the allowance belongs on the positive side only. An absolute comparison also gave
    // 1.625pt of room on the negative side, where the quantisation cannot go: a stylesheet raising
    // the ring a point and a half too far above the explanation would have passed.
    const raisedPt = previewRingTop - -ringTopFromTextBaselinePt;
    const where =
      `preview raises the ring ${(-previewRingTop).toFixed(2)}pt above the explanation's baseline, page ${ringTopFromTextBaselinePt.toFixed(
        2,
      )}pt`;
    expect(raisedPt, where).toBeGreaterThanOrEqual(-PRINT_FIDELITY_TOLERANCE.geometryPt);
    expect(raisedPt, where).toBeLessThanOrEqual(
      PRINT_FIDELITY_TOLERANCE.geometryPt + PRINT_FIDELITY_TOLERANCE.lineBoxQuantisationPt,
    );
  });

  test('a paragraph before a heading opens the block margin, not the prose one', async ({ page }) => {
    // `theme_margin category, side, node` swaps the category outright — `category = :block if node !=
    // true && node.context == :section` — so the gap between a paragraph and the heading after it is
    // `block.margin-bottom + heading.margin-top`, while the same paragraph anywhere else is followed by
    // `prose.margin-bottom`. This fixture's theme sets the two 6pt apart, so a preview using the wrong
    // one cannot pass by coincidence.
    const fixture = readFixture(FIXTURE);
    await preparePrintPage(page, fixture);

    const runs = await textRuns(fixture.referencePdf);
    const closing = runsStartingWith(runs, 'renderer opens between the two');
    const heading = runsStartingWith(runs, 'Bullets');
    expect(closing.length, 'the reference sets the paragraph').toBeGreaterThan(0);
    expect(heading.length, 'the reference sets the heading after it').toBeGreaterThan(0);
    const referenceDropPt = closing[0].yPt - heading[0].yPt;

    const paragraphBaselines = await baselinesOf(page, '.sect1 > .sectionbody > .paragraph > p');
    const headingBaselines = await baselinesOf(page, 'h3');
    const previewDropPt = headingBaselines[0] - paragraphBaselines.at(-1)!;

    expect(
      Math.abs(previewDropPt - referenceDropPt),
      `preview drops ${previewDropPt.toFixed(2)}pt from the paragraph's last baseline to the heading's, page ${referenceDropPt.toFixed(
        2,
      )}pt`,
    ).toBeLessThanOrEqual(PRINT_FIDELITY_TOLERANCE.geometryPt);
  });

  test('the contents heading opens the top margin a level-2 heading opens', async ({ page }) => {
    // `ink_toc` inks the contents title through `ink_general_heading … level: 2`, which takes
    // `heading.h2.margin-top` above it exactly as a section heading does. Nothing opened any here, so
    // the first two things a reader sees sat a whole `heading.margin-top` closer together than the
    // export sets them.
    const fixture = readFixture(FIXTURE);
    await preparePrintPage(page, fixture);

    const runs = await textRuns(fixture.referencePdf);
    const title = runsStartingWith(runs, 'Marker Columns');
    const contents = runsStartingWith(runs, 'Table of Contents');
    expect(title.length, 'the reference sets the document title').toBeGreaterThan(0);
    expect(contents.length, 'the reference sets the contents heading').toBeGreaterThan(0);
    const referenceDropPt = title[0].yPt - contents[0].yPt;

    const titleBaselines = await baselinesOf(page, 'h1');
    const contentsBaselines = await baselinesOf(page, '#toctitle');
    const previewDropPt = contentsBaselines[0] - titleBaselines.at(-1)!;

    expect(
      Math.abs(previewDropPt - referenceDropPt),
      `preview drops ${previewDropPt.toFixed(2)}pt from the title's baseline to the contents heading's, page ${referenceDropPt.toFixed(
        2,
      )}pt`,
    ).toBeLessThanOrEqual(PRINT_FIDELITY_TOLERANCE.geometryPt);
  });

  test('no rule is drawn above the footnote list, and an authored one still is', async ({ page }) => {
    // `ink_footnotes` draws nothing: a block margin, an optional `footnotes.margin-top`, then the
    // entries. The preview drew TWO rules there — its own `border-top` on `#footnotes`, and the `<hr>`
    // Asciidoctor's HTML backend opens the block with, picked up by the thematic-break rule. The
    // second is why suppressing it has to be done by where the `<hr>` sits rather than by weakening the
    // rule that draws a real one: this fixture carries an authored break as well, and it is still on
    // the page.
    //
    // The SPACE above the list is deliberately not compared. The renderer's own default for
    // `footnotes.margin-top` is the keyword `auto`, which pushes the list to the bottom of the page —
    // and a preview that renders no page breaks has no page bottom to push it to.
    const fixture = readFixture(FIXTURE);
    await preparePrintPage(page, fixture);

    const rasters = pageRasters(fixture.referencePdf, DPI);
    const runs = await textRuns(fixture.referencePdf);
    const entry = runs.find((run) => run.text.startsWith('[1] The footnote'));
    expect(entry, 'the reference sets the footnote entry').toBeDefined();
    if (entry === undefined) return;

    // Every row between the last body text and the first footnote entry, asked for its longest
    // CONTIGUOUS run of ink. A rule is one long run; a line of text is many short ones, so counting
    // inked pixels would have called the entries' own words a rule.
    const raster = rasters[entry.page - 1];
    const pageHeightPt = (raster.heightPx * 72) / raster.dpi;
    let above = pageHeightPt;
    for (const run of runs) {
      if (run.page === entry.page && run.yPt > entry.yPt) above = Math.min(above, run.yPt);
    }
    const rowAt = (yPt: number): number => Math.round(((pageHeightPt - yPt) * raster.dpi) / 72);
    // Clear of the descenders of the line above and of the ascenders of the entry below.
    const from = rowAt(above) + Math.round((raster.dpi * 4) / 72);
    const to = rowAt(entry.yPt) - Math.round((raster.dpi * entry.fontSizePt * 1.2) / 72);
    expect(to, 'there is a band of page between the two to look at').toBeGreaterThan(from);
    let longest = 0;
    for (let y = from; y < to; y += 1) {
      let run = 0;
      for (let x = 0; x < raster.widthPx; x += 1) {
        const [r, g, b] = raster.colourAt(x, y);
        run = r < 240 || g < 240 || b < 240 ? run + 1 : 0;
        longest = Math.max(longest, run);
      }
    }
    // A rule spans the text column; a stray mark cannot be mistaken for one at a tenth of the page.
    expect(
      longest,
      `the reference's longest unbroken mark above the entries is ${longest} pixels`,
    ).toBeLessThan(Math.round(raster.widthPx * 0.1));

    const drawn = await page.evaluate(() => {
      const list = document.querySelector('[data-testid="page"] #footnotes');
      const inside = list?.querySelector('hr') ?? null;
      const authored = document.querySelector('[data-testid="page"] .sect1 hr');
      return {
        found: list !== null,
        borderTop: list === null ? '' : getComputedStyle(list).borderTopWidth,
        furnitureHeight: inside === null ? -1 : inside.getBoundingClientRect().height,
        authoredHeight: authored === null ? -1 : authored.getBoundingClientRect().height,
      };
    });

    expect(drawn.found, 'the preview draws the footnote list').toBe(true);
    expect(drawn.borderTop, 'and no rule of its own above it').toBe('0px');
    expect(drawn.furnitureHeight, "and nothing for the backend's own `<hr>`").toBe(0);
    expect(drawn.authoredHeight, 'while a thematic break an author wrote is still drawn').toBeGreaterThan(0);
  });

  test('a quotation and a footnote are set at the alignment body text is set at', async ({ page }) => {
    // Neither construct has an alignment of its own: `theme_font` reads family, size, colour, style and
    // leading and never touches `@base_text_align`, and the gem has no `quote.text-align` key at all.
    // The `left` this style used to fall back to was a value no theme had asked for, and alignment is
    // not a detail — it decides where every line of the block breaks.
    const fixture = readFixture(FIXTURE);
    const prepared = await preparePrintPage(page, fixture);
    expect(prepared.cssProperties['--print-base-text-align'], "the fixture's theme justifies body text").toBe(
      'justify',
    );

    const aligned = await page.evaluate(() => {
      const quote = document.querySelector('[data-testid="page"] .quoteblock');
      const footnotes = document.querySelector('[data-testid="page"] #footnotes');
      return {
        quote: quote === null ? null : getComputedStyle(quote).textAlign,
        footnotes: footnotes === null ? null : getComputedStyle(footnotes).textAlign,
      };
    });
    expect(aligned.quote).toBe('justify');
    expect(aligned.footnotes).toBe('justify');

    // And the consequence, which is the part worth holding: a justified line ends at the measure. The
    // reference's own quotation runs to the right edge of the text column on every line but the last.
    const runs = await textRuns(fixture.referencePdf);
    const quoted = runs.filter((run) => run.text.startsWith('The Analytical Engine'));
    expect(quoted.length, 'the reference sets the quotation').toBeGreaterThan(0);
    const first = quoted[0];
    const sameLine = runs.filter((run) => run.page === first.page && run.yPt === first.yPt);
    const rightPt = Math.max(...sameLine.map((run) => run.xPt + run.widthPt));

    const previewRightPt = await page.evaluate((perPoint) => {
      const column = document.querySelector('[data-testid="page"]');
      const quote = document.querySelector('[data-testid="page"] .quoteblock blockquote');
      if (column === null || quote === null) return null;
      const origin = column.getBoundingClientRect();
      const range = document.createRange();
      range.selectNodeContents(quote);
      const rects = [...range.getClientRects()].filter((rect) => rect.height > 0);
      return rects.length === 0 ? null : (rects[0].right - origin.left) / perPoint;
    }, PIXELS_PER_POINT);

    expect(previewRightPt, 'the preview sets the quotation').not.toBeNull();
    if (previewRightPt === null) return;
    expect(
      Math.abs(previewRightPt - (rightPt)),
      `preview ends the quotation's first line at ${previewRightPt.toFixed(2)}pt, page ${(
        rightPt
      ).toFixed(2)}pt`,
    ).toBeLessThanOrEqual(PRINT_FIDELITY_TOLERANCE.geometryPt);
  });
});
