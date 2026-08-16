/**
 * @file What a description list leaves behind it, and what a `[horizontal]` one is laid out as.
 *
 * TWO defects, both of them silent, and neither reachable from any other anchor in this suite.
 *
 * The first is a full extra line under every description list in a document. `convert_dlist` inks
 * each description with `margin_bottom: ((next_enclosed_block desc, descend: true) ? nil : 0)`
 * (`converter.rb:1544`), and for the LAST description that lookup comes back nil: the space to
 * whatever follows the list is opened one line later by the list itself, `theme_margin :prose,
 * :bottom, (next_enclosed_block node)` (`converter.rb:1547`). The preview opened both — a bottom
 * margin on every `dd` AND one on the `.dlist` around them — so a list was followed by two prose
 * margins where the page gives it one. Measured on this fixture: the export leaves 28.36pt from the
 * last description's baseline to the next paragraph's, exactly what it leaves between two items, and
 * the preview left 37.36pt.
 *
 * The second is that nothing in the Print stylesheet mentioned a horizontal list at all, so what an
 * author saw was the browser's own table defaults against a layout the renderer computes explicitly
 * (`converter.rb:1460-1517`): a term column as wide as the widest term plus 20pt but never past half
 * the measure, both columns top-aligned from one `initial_y`, the description column running to the
 * measure less 10pt, and the term set in the description list's own type. A default table agrees
 * with none of those.
 *
 * HOW EVERY NUMBER HERE IS OBTAINED. Out of the committed reference PDF, at run time — the runs it
 * draws, where each one starts and ends, and which baseline each sits on. Nothing below restates a
 * theme value or an engine constant as a literal, so a change to either shows up as a changed
 * reference rather than as a spec that still passes against a number nobody re-derived. Each claim
 * also asserts what the REFERENCE says before it asks whether the preview agrees, so a test cannot
 * pass by comparing two numbers that are both wrong.
 */

import { expect, test, type Page } from '@playwright/test';
import { PRINT_FIDELITY_TOLERANCE, drawnRuns, textRuns } from '../harness/pdftools';
import { PIXELS_PER_POINT, preparePrintPage, readFixture } from './harness';

/** The fixture this file is about. */
const FIXTURE = 'description-lists';

const fixture = readFixture(FIXTURE);

/** One laid-out line of the reference, with what places it. */
interface ReferenceLine {
  /** The line's text, trimmed. */
  readonly text: string;
  /** 1-based page. */
  readonly page: number;
  /** Baseline in points from the page's BOTTOM, which is the coordinate system the file uses. */
  readonly baselinePt: number;
  /** Left edge in points from the page's left edge. */
  readonly leftPt: number;
  /** Right edge in points. */
  readonly rightPt: number;
}

/**
 * The reference's laid-out lines.
 *
 * One entry per run rather than per baseline: a horizontal list's term and its description share a
 * baseline, and folding them together would lose the very thing this file measures.
 *
 * @returns One entry per laid-out line, in page order.
 */
async function referenceLines(): Promise<ReferenceLine[]> {
  const runs = await textRuns(fixture.referencePdf);
  return runs
    .filter((run) => run.text.trim() !== '')
    .map((run) => ({
      text: run.text.trim(),
      page: run.page,
      baselinePt: run.yPt,
      leftPt: run.xPt,
      rightPt: run.xPt + run.widthPt,
    }));
}

/** The one reference line reading exactly `text`, failing loudly when it is not unique. */
function line(lines: readonly ReferenceLine[], text: string): ReferenceLine {
  const found = lines.filter((candidate) => candidate.text === text);
  expect(found, `the reference has exactly one line reading "${text}"`).toHaveLength(1);
  return found[0];
}

/**
 * How far apart two reference lines are, downward.
 *
 * The file's y grows upward, so a line drawn lower has the smaller baseline; the subtraction is the
 * other way round to give a distance that reads as "further down the page". The two lines are
 * required to be on the same page: a distance that crossed a page break would be a measurement of
 * the page's own height rather than of the space a construct opens.
 *
 * @param from - The upper line.
 * @param to - The lower line.
 * @returns The distance in points.
 */
function fallPt(from: ReferenceLine, to: ReferenceLine): number {
  expect(to.page, `"${from.text}" and "${to.text}" are on one page`).toBe(from.page);
  return from.baselinePt - to.baselinePt;
}

/**
 * Where the first line of the element whose whole text is `text` sits, in points from the top of the
 * page column.
 *
 * A baseline, measured rather than derived: a zero-sized inline-block placed at the very start of the
 * element takes its baseline from its own bottom margin edge, so it reports that line's baseline
 * exactly, whatever the face, the size or the browser's rounding did to the line box. Comparing an
 * ink-box top against the PDF's baseline would bias every comparison by an ascent.
 *
 * `<dd>` is not among the elements searched, because a simple description's `<dd>` and the `<p>`
 * inside it carry the same text and only one of them can be the answer.
 *
 * @param page - The browser page.
 * @param text - The element's whole text, whitespace collapsed.
 * @returns The first line's baseline in points.
 */
async function previewBaseline(page: Page, text: string): Promise<number> {
  return page.evaluate(
    ({ needle, perPoint }) => {
      const root = document.querySelector('[data-testid="page"]');
      if (!(root instanceof HTMLElement)) throw new Error('the page has no column');
      const found = [...root.querySelectorAll('p, dt, td.hdlist1, h1, h2, h3, h4')].filter(
        (candidate) => (candidate.textContent ?? '').replaceAll(/\s+/g, ' ').trim() === needle,
      );
      if (found.length !== 1) {
        throw new Error(`the preview has ${String(found.length)} elements reading "${needle}"`);
      }
      const probe = document.createElement('span');
      probe.style.cssText = 'display:inline-block;width:0;height:0;overflow:hidden';
      found[0].insertBefore(probe, found[0].firstChild);
      const baseline = probe.getBoundingClientRect().bottom - root.getBoundingClientRect().top;
      probe.remove();
      return baseline / perPoint;
    },
    { needle: text, perPoint: PIXELS_PER_POINT },
  );
}

/** One laid-out line of the preview: the two edges the browser can report the same way the PDF does. */
interface PreviewLine {
  /** Left edge in points, from the page column's own left edge. */
  readonly leftPt: number;
  /** Right edge in points. */
  readonly rightPt: number;
}

/**
 * The laid-out lines of the element whose whole text is `text`.
 *
 * Read from the line boxes the browser produced rather than from the text, because where a line
 * breaks is a consequence of the typeface, the size and the measure all at once — which is what makes
 * it the strongest single statement that a column is as wide as the page's.
 *
 * @param page - The browser page.
 * @param text - The element's whole text, whitespace collapsed.
 * @returns One entry per laid-out line, top to bottom.
 */
async function previewLines(page: Page, text: string): Promise<PreviewLine[]> {
  return page.evaluate(
    ({ needle, perPoint }) => {
      const root = document.querySelector('[data-testid="page"]');
      if (!(root instanceof HTMLElement)) throw new Error('the page has no column');
      const origin = root.getBoundingClientRect();
      const found = [...root.querySelectorAll('p, dt, td.hdlist1, h1, h2, h3, h4')].filter(
        (candidate) => (candidate.textContent ?? '').replaceAll(/\s+/g, ' ').trim() === needle,
      );
      if (found.length !== 1) {
        throw new Error(`the preview has ${String(found.length)} elements reading "${needle}"`);
      }
      const range = document.createRange();
      range.selectNodeContents(found[0]);
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
        if (current === undefined || rectangle.top - current.top > 1) {
          lines.push({ ...rectangle });
        } else {
          current.leftPt = Math.min(current.leftPt, rectangle.leftPt);
          current.rightPt = Math.max(current.rightPt, rectangle.rightPt);
        }
      }
      return lines.map(({ leftPt, rightPt }) => ({ leftPt, rightPt }));
    },
    { needle: text, perPoint: PIXELS_PER_POINT },
  );
}

/**
 * Assert that the preview and the reference report one quantity as the same number.
 *
 * @param what - What is being compared, for the failure message.
 * @param preview - The preview's measurement, in points.
 * @param reference - The reference's, in points.
 */
function agree(what: string, preview: number, reference: number): void {
  expect(
    Math.abs(preview - reference),
    `${what}: preview ${preview.toFixed(3)}pt, reference ${reference.toFixed(3)}pt`,
  ).toBeLessThanOrEqual(PRINT_FIDELITY_TOLERANCE.geometryPt);
}

test.describe('a description list opens the space after it once', () => {
  test('what follows a list sits where what follows an item sits', async ({ page }) => {
    const lines = await referenceLines();
    // The reference's own statement of the case, and the whole of what "once" means: the distance
    // from the LAST description to the block after the list is the same distance as from any other
    // description to the term after it. Both are one line plus one prose margin, because the last
    // description takes none of its own and the list supplies the one.
    const betweenItems = fallPt(line(lines, 'the first description'), line(lines, 'beta'));
    const afterList = fallPt(line(lines, 'the second description'), line(lines, 'closes-simple'));
    expect(
      Math.abs(afterList - betweenItems),
      'the reference leaves as much after the list as it leaves between its items',
    ).toBeLessThan(0.05);

    await preparePrintPage(page, fixture);
    const secondDescription = await previewBaseline(page, 'the second description');
    agree(
      'the space between two items',
      (await previewBaseline(page, 'beta')) - (await previewBaseline(page, 'the first description')),
      betweenItems,
    );
    agree(
      'the space after the list',
      (await previewBaseline(page, 'closes-simple')) - secondDescription,
      afterList,
    );
  });

  test('a description ending in a block of its own ends the list at that block', async ({ page }) => {
    const lines = await referenceLines();
    // `next_enclosed_block desc, descend: true` answers with the description's FIRST CHILD when it
    // has blocks, so the description's own text keeps the ordinary prose margin and it is the block
    // ending it that takes none. Both distances below are therefore the same distance.
    const beforeBlock = fallPt(line(lines, 'the fifth description'), line(lines, 'the block that ends the description'));
    const afterList = fallPt(line(lines, 'the block that ends the description'), line(lines, 'closes-compound'));
    expect(
      Math.abs(afterList - beforeBlock),
      'the reference spaces the block inside the description as it spaces what follows the list',
    ).toBeLessThan(0.05);

    await preparePrintPage(page, fixture);
    const description = await previewBaseline(page, 'the fifth description');
    const block = await previewBaseline(page, 'the block that ends the description');
    agree('the space above the description’s second block', block - description, beforeBlock);
    agree('the space after the compound list', (await previewBaseline(page, 'closes-compound')) - block, afterList);
  });

  test('a list inside a description opens no space of its own', async ({ page }) => {
    const lines = await referenceLines();
    // `convert_list` ends with `theme_margin :prose, :bottom, … unless node.nested?`, and
    // `List#nested?` is `Asciidoctor::ListItem === @parent` — which a `<dd>` is. So the nested list
    // adds nothing, the last description adds nothing, and the space after the whole construct is the
    // one margin the outer list opens.
    const betweenItems = fallPt(line(lines, 'the first description'), line(lines, 'beta'));
    // The reference draws a bullet list item as its marker and its text on one line, so the run
    // carries both; the preview draws the marker from a `::before`, so its element carries only the
    // text. The same line, spelled the way each medium spells it.
    const afterList = fallPt(line(lines, '• the second nested item'), line(lines, 'closes-nested'));
    expect(
      Math.abs(afterList - betweenItems),
      'the reference closes the nesting with one margin and no more',
    ).toBeLessThan(0.05);

    await preparePrintPage(page, fixture);
    agree(
      'the space after a list nested in a description',
      (await previewBaseline(page, 'closes-nested')) - (await previewBaseline(page, 'the second nested item')),
      afterList,
    );
  });

  test('terms of one item are spaced by the term spacing, and share the one closing margin', async ({
    page,
  }) => {
    const lines = await referenceLines();
    const betweenTerms = fallPt(line(lines, 'iota'), line(lines, 'kappa'));
    const toDescription = fallPt(line(lines, 'kappa'), line(lines, 'the description both terms share'));
    const afterList = fallPt(line(lines, 'the description both terms share'), line(lines, 'closes-shared'));
    // `ink_prose term_text, margin_top: (idx > 0 ? term_spacing : 0), margin_bottom: 0` opens the gap
    // between two terms, and `margin_bottom term_spacing` opens the one before the description: the
    // same value, twice, and neither of them the prose margin that closes the list.
    expect(
      Math.abs(betweenTerms - toDescription),
      'the reference spaces term-to-term as it spaces term-to-description',
    ).toBeLessThan(0.05);
    expect(
      afterList - betweenTerms,
      'and closes the list with a different, larger space',
    ).toBeGreaterThan(1);

    await preparePrintPage(page, fixture);
    const iota = await previewBaseline(page, 'iota');
    const kappa = await previewBaseline(page, 'kappa');
    const description = await previewBaseline(page, 'the description both terms share');
    agree('the space between two terms of one item', kappa - iota, betweenTerms);
    agree('the space between a term and its description', description - kappa, toDescription);
    agree(
      'the space after a shared description',
      (await previewBaseline(page, 'closes-shared')) - description,
      afterList,
    );
  });

  test('a list before a heading takes the block margin, and takes it once', async ({ page }) => {
    const lines = await referenceLines();
    // `theme_margin` swaps the category when what comes next is a section — `category = :block if
    // node != true && node.context == :section` — so a list is followed by `block.margin-bottom`
    // before a heading and `prose.margin-bottom` everywhere else. This fixture's theme sets the two
    // 6pt apart on purpose, so the reference can say which of them is in force.
    const beforeHeading = fallPt(line(lines, 'the fourth description'), line(lines, 'closes-heading'));
    const afterList = fallPt(line(lines, 'the second description'), line(lines, 'closes-simple'));
    expect(
      beforeHeading - afterList,
      'the reference opens more space before a heading than before a paragraph',
    ).toBeGreaterThan(1);

    await preparePrintPage(page, fixture);
    agree(
      'the space between a list and the heading after it',
      (await previewBaseline(page, 'closes-heading')) - (await previewBaseline(page, 'the fourth description')),
      beforeHeading,
    );
  });
});

test.describe('a horizontal list is the two-column layout the renderer computes', () => {
  test('its term and its description start on one baseline, in every row', async ({ page }) => {
    // Every row, because a middle-aligned cell is offset by HALF the difference between its own
    // height and the row's, and that difference is a different number in each of these three: a
    // description that wraps, one that does not, and the last one, whose description opens no bottom
    // margin. A single row would leave two of the three ways this can go wrong unmeasured.
    const rows = [
      ['lambda', 'the horizontal description, long enough that it has to break somewhere, which'],
      ['mu', 'shorter'],
      ['nu', 'shorter still'],
    ] as const;
    const previewText: Record<string, string> = {
      'the horizontal description, long enough that it has to break somewhere, which':
        'the horizontal description, long enough that it has to break somewhere, which is what says how wide the description column was allowed to be',
    };
    const lines = await referenceLines();
    for (const [term, description] of rows) {
      // The reference's own statement: the two are inked from one `initial_y`, so however tall
      // either column runs, both open on the same baseline.
      expect(
        line(lines, description).baselinePt,
        `the reference opens both columns of the "${term}" row on one baseline`,
      ).toBeCloseTo(line(lines, term).baselinePt, 1);
    }

    await preparePrintPage(page, fixture);
    for (const [term, description] of rows) {
      const previewTerm = await previewBaseline(page, term);
      const previewDescription = await previewBaseline(page, previewText[description] ?? description);
      agree(`the "${term}" row’s term and description open together`, previewDescription - previewTerm, 0);
    }
  });

  test('its term is set in the description list’s own type, and so is a vertical one', async ({ page }) => {
    // The term is inked inside `theme_font :description_list_term` (`converter.rb:1493` for a
    // horizontal list, `:1531` for every other kind) — one theme category, two constructs — so
    // `description-list.term-font-style` reaches both. The stylesheet needs two rules to say it,
    // because Asciidoctor writes the two as different markup: a `<dt>` for the vertical form
    // (`print-preview.css:649-655`) and a `td.hdlist1` for the horizontal one (`:719-726`).
    //
    // BOTH are measured here, and the reason is that only one of them used to be. This check read
    // the horizontal cell alone while claiming the key "reaches both", so deleting `font-style` from
    // the `<dt>` rule at `print-preview.css:650` — an author's italic term rendered upright in every
    // ordinary description list in the document — reddened nothing anywhere in this suite.
    //
    // The reference names the FILE it embedded for each run, and the renderer picks that file from
    // the theme's `font-style`, so the slant is read off the reference rather than restated here.
    const drawn = await drawnRuns(fixture.referencePdf);
    const horizontalTerm = drawn.find((run) => run.text.trim() === 'lambda');
    const verticalTerm = drawn.find((run) => run.text.trim() === 'alpha');
    const description = drawn.find((run) => run.text.trim() === 'shorter still');
    expect(horizontalTerm, 'the reference draws the horizontal term').toBeDefined();
    expect(verticalTerm, 'the reference draws a vertical term').toBeDefined();
    expect(description, 'the reference draws a horizontal description').toBeDefined();
    if (horizontalTerm === undefined || verticalTerm === undefined || description === undefined) return;
    // The theme sets the term in a slant the body is not set in, so a term that fell back to body
    // type could not pass by inheriting the right answer. Measured on this fixture: both terms are
    // drawn in `NotoSerif-Italic` and every description in `NotoSerif`.
    expect(horizontalTerm.fontFamily).not.toBe(description.fontFamily);
    expect(verticalTerm.fontFamily, 'the reference sets both kinds of term in one face').toBe(
      horizontalTerm.fontFamily,
    );

    await preparePrintPage(page, fixture);
    // `td.hdlist1` is the horizontal list's term cell and `dl dt` an ordinary list's term. They are
    // read in one pass so a page that lays out only one of the two fails here rather than leaving
    // the missing one uncompared.
    const measured = await page.evaluate(() =>
      Object.fromEntries(
        (
          [
            ['horizontal', 'td.hdlist1'],
            ['vertical', 'dl dt'],
          ] as const
        ).map(([kind, selector]) => {
          const element = document.querySelector(`[data-testid="page"] ${selector}`);
          if (element === null) throw new Error(`the preview has no ${kind} term (${selector})`);
          const style = getComputedStyle(element);
          return [kind, { style: style.fontStyle, weight: style.fontWeight }];
        }),
      ),
    );

    const expected = {
      style: horizontalTerm.fontFamily.toLowerCase().includes('italic') ? 'italic' : 'normal',
      weight: horizontalTerm.fontFamily.toLowerCase().includes('bold') ? '700' : '400',
    };
    expect(measured.horizontal, "the horizontal list's term").toEqual(expected);
    expect(measured.vertical, "an ordinary description list's term").toEqual(expected);
  });

  test('its columns are where the widest term puts them', async ({ page }) => {
    const lines = await referenceLines();
    const term = line(lines, 'lambda');
    const description = line(
      lines,
      'the horizontal description, long enough that it has to break somewhere, which',
    );
    const secondLine = line(lines, 'is what says how wide the description column was allowed to be');
    // The reference sets the description column from the WIDEST of the three terms rather than from
    // this row's, which is the whole of `max_term_width`: `lambda` is the widest, so its own line
    // ends short of the column edge the description starts at.
    expect(term.rightPt, 'the widest term still ends inside the term column').toBeLessThan(description.leftPt);

    await preparePrintPage(page, fixture);
    const previewTermLines = await previewLines(page, 'lambda');
    const previewTerm = previewTermLines[0];
    const previewDescription = await previewLines(
      page,
      'the horizontal description, long enough that it has to break somewhere, which is what says how wide the description column was allowed to be',
    );
    agree('the term’s own left edge', previewTerm.leftPt, term.leftPt);
    agree('the description column’s left edge', previewDescription[0].leftPt, description.leftPt);
    // Where the first line ENDS is the description column's far edge — the line is justified to it —
    // and where the second line ends is the strongest single check that the column is the page's
    // width rather than one that merely starts in the right place.
    expect(previewDescription, 'the preview breaks the description where the reference breaks it').toHaveLength(2);
    agree('the description column’s right edge', previewDescription[0].rightPt, description.rightPt);
    agree('where the description’s second line ends', previewDescription[1].rightPt, secondLine.rightPt);
  });

  test('its rows are as tall as the taller column, and it closes once like any other list', async ({
    page,
  }) => {
    const lines = await referenceLines();
    const wrapping = fallPt(line(lines, 'lambda'), line(lines, 'mu'));
    const flat = fallPt(line(lines, 'mu'), line(lines, 'nu'));
    const afterList = fallPt(line(lines, 'nu'), line(lines, 'closes-horizontal'));
    // The reference's own statement: the row whose description wraps is taller than the row whose
    // description does not, by the line the wrap added.
    expect(wrapping, 'the reference makes the wrapping row the taller one').toBeGreaterThan(flat + 1);
    // And the list closes the way every other description list closes: once.
    expect(
      Math.abs(afterList - flat),
      'the reference leaves as much after the list as it leaves between its rows',
    ).toBeLessThan(0.05);

    await preparePrintPage(page, fixture);
    const lambda = await previewBaseline(page, 'lambda');
    const mu = await previewBaseline(page, 'mu');
    const nu = await previewBaseline(page, 'nu');
    agree('the pitch of a row whose description wraps', mu - lambda, wrapping);
    agree('the pitch of a row whose description does not', nu - mu, flat);
    agree('the space after a horizontal list', (await previewBaseline(page, 'closes-horizontal')) - nu, afterList);
  });

  test('a term wider than half the measure caps its column and wraps inside it', async ({ page }) => {
    const lines = await referenceLines();
    const first = line(lines, 'a term long enough that no half of the');
    const second = line(lines, 'measure could ever hold it and the');
    const third = line(lines, 'renderer has to cap the column it is set in');
    const description = line(lines, 'the description beside the capped column');
    // What "capped" means, stated by the reference rather than by this file: the term does not fit
    // the column it was given and is broken across three lines, all starting at one left edge.
    expect([first, second, third].every((run) => run.leftPt === first.leftPt)).toBe(true);

    // …and the half of it a line count cannot state, which is where those lines are allowed to END.
    // `max_term_width` is the widest term plus BOTH of the term's 10pt side paddings
    // (`converter.rb:1469, 1486`), but the term is then inked in a box that runs from the column's
    // left padding edge all the way to the column's far edge — `indent term_left, (bounds.width -
    // term_column_width)` (`:1493`) gives it no padding on the right at all. So a term that wraps
    // may use the ten points its own column's right padding would otherwise have taken, and a term
    // column built like an ordinary padded table cell breaks a word earlier than the page does.
    //
    // That overhang is measured rather than restated. In the UNCAPPED list above, the column IS
    // sized from its term, so the distance from the widest term's own ink to where the description
    // column starts is exactly the pair of paddings the renderer added — one subtraction, no
    // constant, and it comes to 20.000pt on this reference. Subtracting it from where the CAPPED
    // list's description starts gives the right edge a padded cell would have stopped the term at;
    // the widest term line runs 1.77pt past it.
    //
    // An earlier version of this wrote that 20pt as `TERM_GUTTER_PT = 20` and called the result "the
    // term column's own right edge", in a file whose header promises no engine constant is restated.
    // It was neither: the column's real right edge is one 10pt padding further right again
    // (`description.leftPt - desc_padding[3]`, 277.64pt here), so the claim that the term "runs past
    // its column" was false — it stops 8.23pt inside it. The distance below is the one this document
    // can actually state, and it is the one the comparisons underneath depend on.
    const uncappedTerm = line(lines, 'lambda');
    const uncappedDescription = line(
      lines,
      'the horizontal description, long enough that it has to break somewhere, which',
    );
    // The subtraction is only the two paddings if `lambda` really is the term that sized that
    // column. All three of its terms are inked at one left edge, so the widest is simply the one
    // whose line ends furthest right.
    for (const other of ['mu', 'nu']) {
      expect(
        line(lines, other).rightPt,
        `the uncapped list's column is sized from "lambda", so "${other}" cannot be the wider term`,
      ).toBeLessThan(uncappedTerm.rightPt);
    }
    const sidePaddingPt = uncappedDescription.leftPt - uncappedTerm.rightPt;
    const paddedEdgePt = description.leftPt - sidePaddingPt;
    expect(
      third.rightPt,
      `the reference lets the widest term line run into the padding its column does not spend: it ` +
        `ends at ${third.rightPt.toFixed(2)}pt, a padded cell would have stopped it at ` +
        `${paddedEdgePt.toFixed(2)}pt (both side paddings measure ${sidePaddingPt.toFixed(3)}pt)`,
    ).toBeGreaterThan(paddedEdgePt);

    await preparePrintPage(page, fixture);
    // The line count and the three line endings are what carry the overhang across to the preview,
    // and they are tight: with `td.hdlist1`'s `width: calc(100% + 10pt)`
    // (`print-preview.css:719-722`) reduced to a plain `width: 100%` — the padded-cell layout the
    // paragraph above describes — the term breaks onto FOUR lines here instead of three, and the
    // third of them ends at 256.68pt against the reference's 269.41pt.
    const previewTerm = await previewLines(
      page,
      'a term long enough that no half of the measure could ever hold it and the renderer has to cap the column it is set in',
    );
    expect(previewTerm, 'the preview breaks the term onto three lines as well').toHaveLength(3);
    for (const [index, reference] of [first, second, third].entries()) {
      agree(`where line ${String(index + 1)} of the capped term ends`, previewTerm[index].rightPt, reference.rightPt);
    }
    const previewDescription = await previewLines(page, 'the description beside the capped column');
    agree('the capped description column’s left edge', previewDescription[0].leftPt, description.leftPt);
  });
});
