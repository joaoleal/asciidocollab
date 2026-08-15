/**
 * @file The marks the text formatter paints AROUND a run of inline text, and where it puts them.
 *
 * Everything measured here is drawn by `TextBackgroundAndBorderRenderer` or placed by
 * `Prawn::Text::Formatted::Fragment`, and both of them work from one thing: the fragment's own inked
 * extent, `baseline + ascender` down to `baseline - descender`, in the face the run is set in. A
 * browser paints an inline element's background over its content area instead, which is the same idea
 * measured off a different reading of the same font file — and the two readings disagree by a third
 * of an em on the gem's own mono face.
 *
 * That is why none of these could be caught by the anchors beside them. A codespan's tint, a key
 * cap's box and a highlight all had the right colour, the right left edge and the right width while
 * standing several points too deep; a superscript sat a point low with the right glyph at the right
 * size; a chord read as one word because the air the theme puts around its separator never reached
 * the page. Every one of them is a comparison against a box or a baseline, and there was none.
 *
 * The reference is the real gem over the fixture beside this file. Boxes come from the operator
 * stream rather than from a raster, because these are grown from their glyphs by offsets of a point
 * or less and a raster cannot place an edge to better than the pixel it falls in.
 */

import { expect, test, type Page } from '@playwright/test';
import {
  PRINT_FIDELITY_TOLERANCE,
  drawnRuns,
  paintedBoxes,
  sameColour,
  textRuns,
  type PaintedBox,
  type TextRun,
} from '../harness/pdftools';
import {
  PIXELS_PER_POINT,
  baselinesOf,
  colourOf,
  preparePrintDocument,
  preparePrintPage,
  readFixture,
  renderWithWorker,
} from './harness';
// Prawn's own line box for each of the fourteen built-in fonts, which is what the export measures a
// base-14 face with — the stand-in FILE's own vertical metrics are its designer's and are not read
// by anything here. Verified against the AFMs by `packages/asciidoc-pdf/tests/fonts`.
import base14 from '@asciidocollab/asciidoc-pdf/assets/base14-fonts/browser.json';
import { metricFamilyOf } from '@/lib/print-preview/font-faces';

/** The fixture this file is about. */
const FIXTURE = 'inline-marks';


/**
 * The colours the fixture's theme sets, named once.
 *
 * Read from this file rather than from the theme document because they are the SUBJECT: a test that
 * discovered them from the same place the preview does could not tell a value that arrived from a
 * value that was never read.
 */
const THEME = {
  baseFontColour: '#23303B',
  linkFontColour: '#0B7285',
  footnotesFontColour: '#445566',
  citeFontColour: '#5C6672',
  codespanBackground: '#F4F6F8',
  kbdBackground: '#EFEFEF',
  markBackground: '#FFF3A0',
} as const;

/** One box the preview draws, in points, with its edges relative to the page rather than the viewport. */
interface PreviewBox {
  readonly leftPt: number;
  readonly rightPt: number;
  readonly topPt: number;
  readonly widthPt: number;
  readonly heightPt: number;
  /**
   * The fill the preview paints, as the computed style reports it.
   *
   * Carried because two of the tests below are NAMED for a tint and measured only a rectangle. They
   * located the reference's box by its fill and then compared geometry, so the fill was a selector
   * and never an expectation: deleting `background-color: var(--print-mark-background-color,
   * #ffff00)` from `print-preview.css:999` left "a highlight's tint is as deep as the fragment it is
   * painted behind" green on a page that painted no highlight at all. Whatever the reference filled
   * its box with is now also asserted of the preview's.
   */
  readonly background: string;
}

/**
 * The box of the first element matching a selector, in points.
 *
 * @param page - The browser page.
 * @param selector - A selector inside the page column.
 * @returns Its box, or null when nothing matched.
 */
async function boxOf(page: Page, selector: string): Promise<PreviewBox | null> {
  return page.evaluate(
    ({ css, perPoint }) => {
      const element = document.querySelector(`[data-testid="page"] ${css}`);
      if (element === null) return null;
      const rect = element.getBoundingClientRect();
      return {
        leftPt: rect.left / perPoint,
        rightPt: rect.right / perPoint,
        topPt: rect.top / perPoint,
        widthPt: rect.width / perPoint,
        heightPt: rect.height / perPoint,
        background: getComputedStyle(element).backgroundColor,
      };
    },
    { css: selector, perPoint: PIXELS_PER_POINT },
  );
}

/**
 * How far the baseline INSIDE an element sits above the baseline of the line it is on, in points.
 *
 * Measured with two zero-sized inline-blocks, whose own baseline is their bottom edge: one put inside
 * the element, which is therefore carried by whatever `vertical-align` does to it, and one put beside
 * it, which is not. Reading the glyphs' rectangles instead would measure the ink rather than the
 * baseline, and a superscript's ink starts wherever its own ascender happens to.
 *
 * @param page - The browser page.
 * @param selector - A selector for the raised or lowered element.
 * @returns The displacement — positive is raised — or null when nothing matched.
 */
async function baselineOffsetOf(page: Page, selector: string): Promise<number | null> {
  return page.evaluate(
    ({ css, perPoint }) => {
      const element = document.querySelector(`[data-testid="page"] ${css}`);
      if (element === null || element.parentElement === null) return null;
      const inside = document.createElement('span');
      const beside = document.createElement('span');
      for (const probe of [inside, beside]) {
        probe.style.cssText = 'display:inline-block;width:0;height:0;overflow:hidden';
      }
      element.append(inside);
      element.after(beside);
      const raised = beside.getBoundingClientRect().bottom - inside.getBoundingClientRect().bottom;
      inside.remove();
      beside.remove();
      return raised / perPoint;
    },
    { css: selector, perPoint: PIXELS_PER_POINT },
  );
}

/** The boxes the reference fills in one colour, left to right. */
function filledIn(boxes: readonly PaintedBox[], colour: string): PaintedBox[] {
  return boxes
    .filter((box) => box.filled && sameColour(box.colour, colourOf(colour)))
    .toSorted((a, b) => a.leftPt - b.leftPt);
}

/** The reference's text runs on the same line as a given baseline, in drawing order. */
function runsOnLineOf(runs: readonly TextRun[], baselinePt: number): TextRun[] {
  return runs.filter((run) => Math.abs(run.yPt - baselinePt) < 0.01);
}

/**
 * The page, dressed exactly as the application dresses it, from the SHIPPING render worker's markup.
 *
 * Through the worker, because the chord separator is markup the worker names: Asciidoctor writes the
 * sign between two key caps as a bare text node, and no stylesheet can reach one.
 *
 * The custom properties the page was dressed with come back too. A comparison that only looks at
 * where a mark landed cannot tell a property the projection emitted from one it never emitted at all
 * — see the superscript test below, whose whole subject is a ratio the projection has to supply.
 *
 * @param page - The browser page.
 * @returns The fixture, for the reference PDF beside it, and what the page was dressed with.
 */
async function open(
  page: Page,
): Promise<{ fixture: ReturnType<typeof readFixture>; prepared: Awaited<ReturnType<typeof preparePrintPage>> }> {
  const fixture = readFixture(FIXTURE);
  const markup = await renderWithWorker(fixture);
  const prepared = await preparePrintPage(page, fixture, markup);
  return { fixture, prepared };
}

test.describe('the marks the renderer paints around a run of inline text', () => {
  test.describe.configure({ mode: 'parallel' });

  test('a quotation is inked in body text\'s colour, not in a grey of the preview\'s own', async ({
    page,
  }) => {
    // `theme_font` assigns `@font_color` only `if color`, and no theme in the gem's chain sets
    // `quote.font_color` — so the colour already in force stands, which for a quotation in the body
    // of a document is `base.font_color`. The stylesheet used to carry a literal grey here, and every
    // quotation in every document came out in it.
    const { fixture } = await open(page);
    const runs = await drawnRuns(fixture.referencePdf);
    const inked = runs.find((run) => run.text.startsWith('Premature optimization'));
    expect(inked, 'the reference PDF inks the quotation').toBeDefined();
    if (inked === undefined) return;
    expect(sameColour(inked.colour, colourOf(THEME.baseFontColour))).toBe(true);

    const previewed = await page.evaluate(() => {
      const paragraph = document.querySelector('[data-testid="page"] .quoteblock blockquote p');
      return paragraph === null ? null : getComputedStyle(paragraph).color;
    });
    expect(previewed).not.toBeNull();
    expect(sameColour(colourOf(previewed ?? undefined, 'the quotation’s colour in the preview'), inked.colour)).toBe(true);
  });

  test('an attribution is one upright line, with the citation title after a comma', async ({
    page,
  }) => {
    // `convert_quote_or_verse` inks `%(#{EmDash} #{attribution_parts.join ', '})` — one string, one
    // `ink_prose`, one face. Asciidoctor's HTML gives the same two parts as `— Name<br><cite>Title
    // </cite>`, which is a hard break where the page has a comma and a `<cite>` the browser slants.
    const { fixture } = await open(page);
    const runs = await textRuns(fixture.referencePdf);
    const attributions = runs.filter((run) => run.text.startsWith('—'));
    expect(attributions, 'the reference PDF inks the attribution as one run').toHaveLength(1);
    const reference = attributions[0];
    expect(reference.text).toBe('— Donald Knuth, The Art of Computer Programming');

    const previewed = await page.evaluate((perPoint) => {
      const attribution = document.querySelector('[data-testid="page"] .attribution');
      const cite = attribution?.querySelector('cite');
      if (attribution === null || cite === null || cite === undefined) return null;
      // The inked extent, not the box: the element fills the measure, and what is being compared is
      // how far the words themselves run.
      const range = document.createRange();
      range.selectNodeContents(attribution);
      const rects = [...range.getClientRects()].filter((rect) => rect.width > 0 && rect.height > 0);
      // How many LINE BOXES the text occupies, by merging the rectangles that overlap vertically.
      // `attribution.getClientRects().length` was what this asked, and on a block box that is always
      // one however many lines the text inside it runs to — so the claim in this test's name could
      // not fail. The range's rectangles are per text node and per inline element instead, so a
      // single line reports two of them here (the em dash and the name, then the `<cite>`); two
      // rectangles on one line overlap vertically and two on different lines cannot, which is what
      // makes the merge the line count rather than the fragment count.
      let lines = 0;
      let bottom = Number.NEGATIVE_INFINITY;
      for (const rect of rects.toSorted((a, b) => a.top - b.top)) {
        if (rect.top >= bottom) lines += 1;
        bottom = Math.max(bottom, rect.bottom);
      }
      return {
        lines,
        text: (attribution.textContent ?? '').replaceAll(/\s+/g, ' ').trim(),
        citeSlant: getComputedStyle(cite).fontStyle,
        widthPt:
          (Math.max(...rects.map((rect) => rect.right)) - Math.min(...rects.map((rect) => rect.left))) /
          perPoint,
      };
    }, PIXELS_PER_POINT);
    expect(previewed).not.toBeNull();
    expect(previewed?.lines, 'the preview sets the attribution on one line').toBe(1);
    expect(previewed?.citeSlant).toBe('normal');
    // And it is as wide as the page's one string. The two checks below cannot see a stray SPACE:
    // the comma is generated content so it is absent from `textContent`, and one rectangle is still
    // one line however much air is inside it. The whitespace Asciidoctor writes around the hidden
    // `<br>` collapsed into a full word space in front of the comma, and the only measurement that
    // shows it is the width of the whole thing against the width of the run the renderer inks.
    expect(
      Math.abs((previewed?.widthPt ?? 0) - reference.widthPt),
      `preview sets the attribution ${(previewed?.widthPt ?? 0).toFixed(2)}pt wide, page ${reference.widthPt.toFixed(2)}pt`,
    ).toBeLessThanOrEqual(PRINT_FIDELITY_TOLERANCE.geometryPt);
    // The comma is generated content, so it is not in `textContent`; what the element carries has to
    // read as the same line with the same two parts in the same order.
    expect(previewed?.text).toBe('— Donald Knuth The Art of Computer Programming');
    expect(
      await page.evaluate(
        () =>
          getComputedStyle(
            document.querySelector('[data-testid="page"] .attribution cite') as Element,
            '::before',
          ).content,
      ),
    ).toBe('", "');
  });

  test('a footnote marker\'s number takes the link colour and its brackets do not', async ({
    page,
  }) => {
    // Both markers are `<a>` elements in the renderer's own markup, and `transform.rb`'s `when :a`
    // branch applies `@theme_settings[:link]` — which carries `theme.link_font_color` — to every one
    // of them except the invisible `<a id=…>` destination marker. The brackets sit OUTSIDE the
    // element in the string `ink_footnotes` writes, so they keep the footnote's own colour.
    const { fixture } = await open(page);
    const runs = await drawnRuns(fixture.referencePdf);
    const digits = runs.filter((run) => run.text === '1');
    expect(digits.length, 'the reference PDF inks a reference marker and an entry marker').toBe(3);
    // Two markers and the page number; the markers are the two the link colour reached.
    const markers = digits.filter((run) => sameColour(run.colour, colourOf(THEME.linkFontColour)));
    expect(markers).toHaveLength(2);

    const brackets = runs.filter((run) => run.text === '[');
    expect(brackets).toHaveLength(2);
    expect(sameColour(brackets[0].colour, colourOf(THEME.baseFontColour))).toBe(true);
    expect(sameColour(brackets[1].colour, colourOf(THEME.footnotesFontColour))).toBe(true);

    const previewed = await page.evaluate(() => {
      const entry = document.querySelector('[data-testid="page"] #footnotes .footnote > a');
      const reference = document.querySelector('[data-testid="page"] sup.footnote > a');
      if (entry === null || reference === null) return null;
      return {
        entry: getComputedStyle(entry).color,
        entryBracket: getComputedStyle(entry, '::before').color,
        reference: getComputedStyle(reference).color,
        referenceBracket: getComputedStyle(reference.parentElement as Element).color,
      };
    });
    expect(previewed).not.toBeNull();
    expect(sameColour(colourOf(previewed?.entry, 'the entry marker’s colour'), colourOf(THEME.linkFontColour))).toBe(true);
    expect(sameColour(colourOf(previewed?.reference, 'the reference marker’s colour'), colourOf(THEME.linkFontColour))).toBe(true);
    expect(
      sameColour(colourOf(previewed?.entryBracket, 'the entry bracket’s colour'), colourOf(THEME.footnotesFontColour)),
    ).toBe(true);
    expect(
      sameColour(colourOf(previewed?.referenceBracket, 'the reference bracket’s colour'), colourOf(THEME.baseFontColour)),
    ).toBe(true);
  });

  test('a codespan\'s tint is the text fragment\'s own extent, grown by the theme\'s offset', async ({
    page,
  }) => {
    // `render_behind` paints from `fragment.top + border_offset` down `fragment.height +
    // border_offset * 2`, and `fragment.height` is the FACE's ascender plus its descender at the
    // codespan's size — 1.0em for the gem's mono face. A browser reads that face's `hhea` instead of
    // its OS/2 typographic values and makes the same box 1.395em deep, so the tint stood most of a
    // third of an em too tall with the right colour, the right width and the right left edge.
    const { fixture } = await open(page);
    const reference = filledIn(await paintedBoxes(fixture.referencePdf), THEME.codespanBackground);
    expect(reference, 'the reference PDF paints one codespan chip').toHaveLength(1);

    const previewed = await boxOf(page, ':not(pre) > code');
    expect(previewed).not.toBeNull();
    if (previewed === null) return;
    // The tint itself, before its shape. `filledIn` above used the colour to FIND the reference's
    // box, which makes the colour a selector rather than an expectation — so this test, whose title
    // is about a tint, could not see a preview that painted none. The expected value is the fill the
    // reference box carries, not `THEME.codespanBackground`: the theme constant is what the fixture
    // asked for, and what the page did with it is the only thing worth comparing against.
    expect(
      sameColour(colourOf(previewed.background, 'the preview chip’s fill'), reference[0].colour),
      `preview chips the codespan ${previewed.background}, the page ${reference[0].colour.join(',')}`,
    ).toBe(true);
    expect(
      Math.abs(previewed.heightPt - reference[0].heightPt),
      `preview chip ${previewed.heightPt.toFixed(2)}pt tall, page ${reference[0].heightPt.toFixed(2)}pt`,
    ).toBeLessThanOrEqual(PRINT_FIDELITY_TOLERANCE.geometryPt);
    // The offset takes room in the line as well as around the glyphs: `Fragment#width` adds
    // `border_offset * 2` to the advance and `InlineTextAligner` draws the glyphs one offset in.
    expect(
      Math.abs(previewed.widthPt - reference[0].widthPt),
      `preview chip ${previewed.widthPt.toFixed(2)}pt wide, page ${reference[0].widthPt.toFixed(2)}pt`,
    ).toBeLessThanOrEqual(PRINT_FIDELITY_TOLERANCE.geometryPt);
  });

  test('a highlight\'s tint is as deep as the fragment it is painted behind', async ({ page }) => {
    // The same box as a codespan's, with no border to complicate it, and set in the surrounding face
    // rather than a mono one. It was short at both edges for as long as the offset reached only the
    // sides: `border_offset` grows the box on every side, not on two of them.
    const { fixture } = await open(page);
    const reference = filledIn(await paintedBoxes(fixture.referencePdf), THEME.markBackground);
    expect(reference, 'the reference PDF paints one highlight').toHaveLength(1);

    const previewed = await boxOf(page, 'mark');
    expect(previewed).not.toBeNull();
    if (previewed === null) return;
    // The tint, read off the reference's own box rather than restated. Without this the test could
    // not fail for the one mutation its title describes: deleting `background-color:
    // var(--print-mark-background-color, #ffff00)` at `print-preview.css:999` leaves a `mark` whose
    // box is exactly the same rectangle, because the rectangle is the inline box either way.
    expect(
      sameColour(colourOf(previewed.background, 'the preview highlight’s fill'), reference[0].colour),
      `preview fills the highlight ${previewed.background}, the page ${reference[0].colour.join(',')}`,
    ).toBe(true);
    expect(
      Math.abs(previewed.heightPt - reference[0].heightPt),
      `preview highlight ${previewed.heightPt.toFixed(2)}pt tall, page ${reference[0].heightPt.toFixed(2)}pt`,
    ).toBeLessThanOrEqual(PRINT_FIDELITY_TOLERANCE.geometryPt);
    expect(
      Math.abs(previewed.widthPt - reference[0].widthPt),
      `preview highlight ${previewed.widthPt.toFixed(2)}pt wide, page ${reference[0].widthPt.toFixed(2)}pt`,
    ).toBeLessThanOrEqual(PRINT_FIDELITY_TOLERANCE.geometryPt);
  });

  test('the air between two key caps is the theme\'s separator, not the bare sign', async ({
    page,
  }) => {
    // `convert_inline_kbd` joins the caps with `theme.kbd_separator`, whose default is a plus sign
    // with a narrow no-break space either side; Asciidoctor's HTML backend joins them with a bare
    // `+`. Two thirds of the gap a reader sees was therefore never on the page — and the stylesheet
    // then took more of it away, by cancelling an offset that the renderer really does spend on the
    // line.
    const { fixture } = await open(page);
    const reference = filledIn(await paintedBoxes(fixture.referencePdf), THEME.kbdBackground);
    expect(reference, 'the reference PDF paints two key caps').toHaveLength(2);
    const referenceGap = reference[1].leftPt - reference[0].rightPt;

    const previewed = await page.evaluate((perPoint) => {
      const caps = [...document.querySelectorAll('[data-testid="page"] .keyseq kbd')];
      if (caps.length !== 2) return null;
      const first = caps[0].getBoundingClientRect();
      const second = caps[1].getBoundingClientRect();
      return {
        gapPt: (second.left - first.right) / perPoint,
        firstWidthPt: first.width / perPoint,
        firstHeightPt: first.height / perPoint,
      };
    }, PIXELS_PER_POINT);
    expect(previewed, 'the preview draws a chord of two caps').not.toBeNull();
    if (previewed === null) return;

    expect(
      Math.abs(previewed.gapPt - referenceGap),
      `preview gap ${previewed.gapPt.toFixed(2)}pt between caps, page ${referenceGap.toFixed(2)}pt`,
    ).toBeLessThanOrEqual(PRINT_FIDELITY_TOLERANCE.geometryPt);

    // And the cap's own box, which is the same box a codespan's is with a rule around it. The rule is
    // drawn as a shadow's spread rather than as a border precisely so that this stays true: a border
    // would be floored to a whole CSS pixel and would grow the box it is on, where the renderer
    // strokes its rectangle on the fill's own edge and spends nothing on it.
    expect(
      Math.abs(previewed.firstWidthPt - reference[0].widthPt),
      `preview cap ${previewed.firstWidthPt.toFixed(2)}pt wide, page ${reference[0].widthPt.toFixed(2)}pt`,
    ).toBeLessThanOrEqual(PRINT_FIDELITY_TOLERANCE.geometryPt);
    expect(
      Math.abs(previewed.firstHeightPt - reference[0].heightPt),
      `preview cap ${previewed.firstHeightPt.toFixed(2)}pt tall, page ${reference[0].heightPt.toFixed(2)}pt`,
    ).toBeLessThanOrEqual(PRINT_FIDELITY_TOLERANCE.geometryPt);
  });

  test('a superscript and a subscript sit where the renderer\'s own arithmetic puts them', async ({
    page,
  }) => {
    // `Fragment#y_offset` raises a superscript by `0.85 * ascender` and drops a subscript by
    // `descender`, both taken from the fragment's own font — the surrounding face at 0.583 of the
    // surrounding size. Neither is a constant, and a browser's `super`/`sub` keyword is one: both sat
    // about a point low, which on a superscript is a quarter of its own height.
    const { fixture, prepared } = await open(page);
    const runs = await textRuns(fixture.referencePdf);
    const raised = runs.find((run) => run.text === '2' && run.fontSizePt < 8);
    expect(raised, 'the reference PDF draws a reduced-size digit').toBeDefined();
    if (raised === undefined) return;

    // The subscript and the superscript both draw a `2`; which is which is decided by whether the
    // digit sits above or below the baseline of the line it is on, never by the order they appear in.
    const reduced = runs.filter((run) => run.text === '2' && run.fontSizePt < 8);
    expect(reduced, 'one subscript and one superscript').toHaveLength(2);
    const displacements = reduced.map((digit) => {
      const line = runsOnLineOf(runs, digit.yPt);
      // The line the digit belongs to is the one whose full-size text is nearest above or below it.
      const body = runs
        .filter((run) => run.fontSizePt > 8 && Math.abs(run.yPt - digit.yPt) < 8)
        .toSorted((a, b) => Math.abs(a.yPt - digit.yPt) - Math.abs(b.yPt - digit.yPt))[0];
      expect(body, 'the digit shares a line with full-size text').toBeDefined();
      // The digit's baseline is its OWN, not the line's: `runsOnLineOf` always returns the digit
      // itself, so counting what it found says nothing. What does say something is that nothing
      // full-size is drawn on that baseline — which is what makes the difference below a real
      // displacement rather than a digit sitting on the body's line and this test measuring zero.
      expect(
        line.every((run) => run.fontSizePt < 8),
        'the reduced-size digit is drawn on a baseline of its own, off the body line',
      ).toBe(true);
      return digit.yPt - (body?.yPt ?? digit.yPt);
    });
    const referenceSuper = Math.max(...displacements);
    const referenceSub = Math.min(...displacements);
    expect(referenceSuper).toBeGreaterThan(0);
    expect(referenceSub).toBeLessThan(0);

    // The two ratios the raise and the drop are BUILT from, stated against the reference before the
    // preview is asked anything — and required of the projection rather than defaulted.
    //
    // `print-preview.css:1076` reads `calc(var(--face-ascender, 1.068) * 0.85em)` and `:1079-1080`
    // `calc(-1 * var(--face-descender, 0.292) * 1em)`, and `:79-80` fall the same two numbers back
    // to `1.068` and `0.292`. Those ARE Noto Serif's own metrics — the catalogue manifest gives it
    // 1.0688 and 0.2930 — and thirteen of the suite's fourteen anchors are set in Noto Serif, this
    // fixture among them. So a `faceRatio` that returned `undefined` and stopped emitting the two
    // properties altogether left the fallback standing in for the very value it was meant to
    // replace: measured here, the reference raises its superscript 5.55pt and 1.068 × 0.85 ×
    // 6.1215pt is 5.557pt, well inside the half-point this comparison allows. The geometry below
    // could not have failed for it. `print-highlighting.spec.ts:456-468` names this same trap for
    // the code family; these are the two remaining properties it applies to.
    //
    // Derived from the reference's own displacement rather than restated: `Fragment#y_offset` raises
    // by `0.85 * ascender` and drops by `descender`, both at the fragment's OWN size, so the two
    // ratios are the reference's numbers divided by that size. Tolerance is a thousandth, which is
    // the rounding the projection writes them at (three decimal places: `0.612`, `1.068`).
    const RATIO = 0.001;
    const reducedSizePt = reduced[0].fontSizePt;
    const referenceAscender = referenceSuper / (0.85 * reducedSizePt);
    const referenceDescender = -referenceSub / reducedSizePt;
    const ascenderProperty = prepared.cssProperties['--print-base-face-ascender'];
    const descenderProperty = prepared.cssProperties['--print-base-face-descender'];
    expect(
      ascenderProperty,
      'the projection resolves the ascender the superscript is raised by',
    ).toBeDefined();
    expect(
      descenderProperty,
      'the projection resolves the descender the subscript is dropped by',
    ).toBeDefined();
    expect(
      Math.abs(Number(ascenderProperty) - referenceAscender),
      `projection ascender ${String(ascenderProperty)}, the page raises by ${referenceSuper.toFixed(3)}pt at ${reducedSizePt.toFixed(4)}pt which is ${referenceAscender.toFixed(4)}`,
    ).toBeLessThanOrEqual(RATIO);
    expect(
      Math.abs(Number(descenderProperty) - referenceDescender),
      `projection descender ${String(descenderProperty)}, the page drops by ${(-referenceSub).toFixed(3)}pt at ${reducedSizePt.toFixed(4)}pt which is ${referenceDescender.toFixed(4)}`,
    ).toBeLessThanOrEqual(RATIO);

    const previewSuper = await baselineOffsetOf(page, 'sup:not(.footnote)');
    const previewSub = await baselineOffsetOf(page, 'sub');
    expect(previewSuper, 'the preview lays out a superscript').not.toBeNull();
    expect(previewSub, 'the preview lays out a subscript').not.toBeNull();

    expect(
      Math.abs((previewSuper ?? 0) - referenceSuper),
      `preview raises a superscript ${(previewSuper ?? 0).toFixed(2)}pt, page ${referenceSuper.toFixed(2)}pt`,
    ).toBeLessThanOrEqual(PRINT_FIDELITY_TOLERANCE.geometryPt);
    expect(
      Math.abs((previewSub ?? 0) - referenceSub),
      `preview drops a subscript ${(-(previewSub ?? 0)).toFixed(2)}pt, page ${(-referenceSub).toFixed(2)}pt`,
    ).toBeLessThanOrEqual(PRINT_FIDELITY_TOLERANCE.geometryPt);
  });

  test('a raised or lowered fragment does not open the line it sits on', async ({ page }) => {
    // The displacement above is applied at DRAW time — `Box#draw_fragment` does `y = @at[1] +
    // @baseline_y` and only then `y += fragment.y_offset` — while the line's advance was already
    // fixed by `move_baseline_down` as `@line_height + @leading`, where `@line_height` is the
    // arranger's `max_line_height`: the largest `font.height` among the line's fragments, each at its
    // OWN size. A superscript is the same face at 0.583 of the size, so it can never be that largest
    // one and the raise never reaches the line box.
    //
    // A browser has no such separation: `vertical-align` moves an inline box that already has a
    // height, and the line grows to hold it wherever it goes. That is a defect the two anchors above
    // cannot see — both measure a displacement, and the displacement was right while the line
    // carrying it stood half again as far from its neighbour as the page sets it.
    const { fixture } = await open(page);
    const runs = await textRuns(fixture.referencePdf);
    const first = runs.find((run) => run.text.startsWith('A paragraph carrying'));
    const second = runs.find((run) => run.text.startsWith('energy relation'));
    expect(first, 'the reference PDF sets the paragraph over two lines').toBeDefined();
    expect(second, 'the reference PDF sets the paragraph over two lines').toBeDefined();
    if (first === undefined || second === undefined) return;

    const referenceStepPt = first.yPt - second.yPt;

    // The check is only worth making if those two lines really are the ones carrying the marks: a
    // reduced-size run below the FIRST line's baseline (the subscript) and one above the SECOND's
    // (the superscript and the footnote reference).
    //
    // Which line a raised or lowered fragment belongs to is decided by which baseline it is nearest,
    // never by falling between the two — every one of them does that, so "below the first" and
    // "above the second" are the same predicate written two ways, and the subscript on its own
    // satisfied both. It is the half-step that separates them.
    const reduced = runs.filter((run) => run.fontSizePt < 8 && run.page === first.page);
    const belongsTo = (line: TextRun) => (run: TextRun): boolean =>
      Math.abs(run.yPt - line.yPt) < referenceStepPt / 2;
    expect(
      reduced.some((run) => belongsTo(first)(run) && run.yPt < first.yPt),
      'the first line carries a lowered fragment',
    ).toBe(true);
    expect(
      reduced.some((run) => belongsTo(second)(run) && run.yPt > second.yPt),
      'the second line carries a raised fragment',
    ).toBe(true);
    const baselines = await baselinesOf(page, '.paragraph p');
    expect(baselines, 'the preview lays the paragraph out over two lines').toHaveLength(2);
    const previewStepPt = baselines[1] - baselines[0];

    expect(
      Math.abs(previewStepPt - referenceStepPt),
      `preview steps ${previewStepPt.toFixed(2)}pt between the two lines, page ${referenceStepPt.toFixed(2)}pt`,
    ).toBeLessThanOrEqual(PRINT_FIDELITY_TOLERANCE.geometryPt);
  });
});

/**
 * The highlight's tint against a face that HAS a line gap, which no anchor's reference PDF has.
 *
 * The comparison above measures a highlight against the real gem, and it cannot see this: the gem's
 * own catalogue face is Noto Serif, whose line gap is zero, so the two readings of "how tall is a
 * fragment" produce the same box and the anchor is green either way. Every committed reference is
 * drawn in that catalogue or in a project face this repository chose, so no reference PDF in the
 * corpus witnesses the difference at all — and adding one would mean regenerating a reference through
 * the gem's Docker image, which is not what a check on the STYLESHEET's arithmetic needs.
 *
 * So the reference here is prawn's own numbers rather than a rendered page, and they come from the
 * committed base-14 manifest — which is the same evidence the export's own line box is built from,
 * verified against the AFM by `packages/asciidoc-pdf/tests/fonts/base14-fonts.test.ts`. What is
 * measured is the browser's, over the shipping stylesheet, dressed by the shipping projection.
 *
 * `Times-Roman` is chosen because its gap is the largest of the base fourteen relative to its body:
 * 216 units against an 900-unit fragment, so the wrong reading is a fifth of the tint too tall and no
 * pixel grid can hide it.
 */
test.describe('a highlight painted against a face whose designer asked for a line gap', () => {
  test.describe.configure({ mode: 'parallel' });

  /** The theme: a base-14 body face, and a highlight the theme actually asks to be painted. */
  const THEME_TEXT = [
    'extends: default',
    'base:',
    '  font-family: Times-Roman',
    '  font-size: 10.5',
    '  text-align: left',
    'mark:',
    '  background-color: FFF3A0',
    '  border-offset: 1.5',
    '',
  ].join('\n');

  const SOURCE = 'A paragraph carrying a #highlighted phrase# and nothing else of interest.\n';

  /** The size the theme sets body text at, which every ratio below is a multiple of. */
  const FONT_SIZE_PT = 10.5;

  /** The offset the theme grows the tint by on every side. */
  const BORDER_OFFSET_PT = 1.5;

  test('is as deep as prawn’s own fragment, and not a line gap deeper', async ({ page }) => {
    await preparePrintDocument(page, { source: SOURCE, themeText: THEME_TEXT });

    const measured = await page.evaluate((perPoint) => {
      const mark = document.querySelector('[data-testid="page"] mark');
      if (mark === null) return null;
      const rect = mark.getBoundingClientRect();
      return {
        heightPt: rect.height / perPoint,
        fontFamily: getComputedStyle(mark).fontFamily,
        background: getComputedStyle(mark).backgroundColor,
      };
    }, PIXELS_PER_POINT);
    expect(measured, 'the page carries a highlight').not.toBeNull();
    if (measured === null) return;

    // The tint is painted at all, and in the theme's colour. Without this the height comparison
    // below would pass on a `mark` that draws no tint — the box is the same rectangle either way.
    expect(colourOf(measured.background, 'the highlight’s fill')).toStrictEqual(colourOf('#FFF3A0'));

    // Prawn's own metrics for the face, out of the committed manifest: `Font#ascender` and
    // `Font#descender` are these over 1000, and `Fragment#height` is their sum. The line gap is
    // stated here as well because it is what the two readings differ by, and stating it is the point
    // of this anchor — if the numbers below ever move, the two expectations move with them.
    const metrics = base14.faces.find((face) => face.name === 'Times-Roman')?.metrics;
    expect(metrics, 'the manifest carries Times-Roman').toBeDefined();
    if (metrics === undefined) return;
    expect(metrics.lineGap, 'the face the anchor is built on has a line gap to lose').toBeGreaterThan(0);

    const em = (units: number): number => (units / metrics.unitsPerEm) * FONT_SIZE_PT;
    // `render_behind` paints from `fragment.top + border_offset` down `fragment.height +
    // border_offset * 2` (`text_background_and_border_renderer.rb:19-26`), and `fragment.height` is
    // `ascender + descender` with no gap in it.
    const paintedPt = em(metrics.ascender - metrics.descender) + BORDER_OFFSET_PT * 2;
    // What the registration the page's TEXT is laid out in would give instead: that one declares the
    // face's line gap as part of its ascent, because that is where prawn puts it when it places a
    // block's first baseline. Right for a line, a whole gap too tall for a box.
    const withGapPt = paintedPt + em(metrics.lineGap);

    // A whole CSS pixel of slack and no more. Chromium quantises a declared ascent and descent to
    // whole device pixels at each size drawn, so the content area cannot be asked for better than
    // that; the two readings are 2.27pt apart here, which is three pixels, so the allowance cannot
    // reach the wrong one.
    const PIXEL_PT = 1 / PIXELS_PER_POINT;
    expect(
      Math.abs(measured.heightPt - paintedPt),
      `preview tints ${measured.heightPt.toFixed(2)}pt; the export paints ${paintedPt.toFixed(2)}pt, ` +
        `and the text registration would give ${withGapPt.toFixed(2)}pt`,
    ).toBeLessThanOrEqual(PIXEL_PT);
    // Stated as its own expectation rather than left to the tolerance: this is the number the defect
    // produced, and a change that widened the allowance until both readings fitted would still fail.
    expect(
      Math.abs(measured.heightPt - withGapPt),
      `preview tints ${measured.heightPt.toFixed(2)}pt, which is the text registration's ${withGapPt.toFixed(2)}pt`,
    ).toBeGreaterThan(PIXEL_PT);

    // And it is drawn in the metric-bearing registration of the surrounding face — the same file, so
    // the same glyphs and the same advances, under the name that carries prawn's ascent and descent.
    expect(measured.fontFamily.split(',')[0].replaceAll('"', '').trim()).toBe(
      metricFamilyOf('Times-Roman'),
    );
  });

  test('breaks its line exactly where the surrounding face does, the second registration being the same file', async ({
    page,
  }) => {
    // The other half of the claim, and the one that would fail if the relay ever named a family the
    // page is not set in: the box registration overrides three vertical numbers and nothing else, so
    // a highlighted run has to advance exactly as the same words do outside one. Measured as the
    // width of the same text set both ways, at a thousand pixels, which is where the browser's own
    // rounding stops mattering.
    await preparePrintDocument(page, {
      source: 'Highlighted #Wavering Tally# and plain Wavering Tally in one paragraph.\n',
      themeText: THEME_TEXT,
    });

    const widths = await page.evaluate(() => {
      const mark = document.querySelector('[data-testid="page"] mark');
      const paragraph = document.querySelector('[data-testid="page"] .paragraph p');
      if (mark === null || paragraph === null) return null;
      const probe = document.createElement('span');
      probe.textContent = mark.textContent;
      probe.style.cssText = 'white-space:pre';
      paragraph.append(probe);
      const plain = probe.getBoundingClientRect().width;
      probe.remove();
      return { highlighted: mark.getBoundingClientRect().width, plain };
    });
    expect(widths).not.toBeNull();
    if (widths === null) return;

    // The tint's own offset is on both sides of the run and is the only difference there should be.
    const offsetPx = BORDER_OFFSET_PT * PIXELS_PER_POINT * 2;
    expect(
      Math.abs(widths.highlighted - offsetPx - widths.plain),
      `highlighted run ${widths.highlighted.toFixed(2)}px against ${widths.plain.toFixed(2)}px plain`,
    ).toBeLessThanOrEqual(0.5);
  });
});
