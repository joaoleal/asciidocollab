/**
 * @file What an inline construct takes from the block it sits in, and what it does not.
 *
 * A codespan names a font of its own, and prawn re-selects the face for any fragment that does:
 * `@document.font(font || family, style: font_style(styles))`
 * (prawn-2.4.0/lib/prawn/text/formatted/arranger.rb:181-189). `styles` is the fragment's OWN set, so
 * whatever face `theme_font :caption` or prawn-table's header cell put in force is REPLACED rather
 * than added to — a codespan in an italic caption is upright, and one in a bold header column is not
 * bold. Both were wrong here, and neither is visible to any other comparison in this suite: the
 * family, the size, the colour and the chip were all already right.
 *
 * What does reach the fragment is what put something in that set, and there are exactly two things.
 * Emphasis MARKUP: `build_fragment` reads the tag — `when :strong then styles << :bold`, `when :em
 * then styles << :italic` (transform.rb:271-276) — and `update_fragment` merges the codespan
 * category's own styles into the inherited set rather than replacing it (transform.rb:412-427). And a
 * HEADING, alone among blocks, which passes the ambient style in as inherited fragment styles:
 * `apply_text_decoration font_styles, :heading, h_level` (converter.rb:3337), where a caption passes
 * an empty array (converter.rb:3219) and a toc entry an empty set (converter.rb:4021).
 *
 * So a stylesheet cannot answer this with one rule about "styled containers", and the whole point of
 * the two fixtures is that they draw all of it. Nothing here is asserted against a value written in
 * this file: the REFERENCE says which face each run is set in, and the preview is held to that.
 */

import { expect, test, type Page } from '@playwright/test';
import {
  PRINT_FIDELITY_TOLERANCE,
  paintedBoxes,
  sameColour,
  textRuns,
  type Rgb,
} from '../harness/pdftools';
import {
  PIXELS_PER_POINT,
  preparePrintDocument,
  preparePrintPage,
  readFixture,
  renderWithWorker,
} from './harness';

/** The two axes CSS keeps apart, as one face names them together. */
interface StyleAxes {
  /** CSS `font-weight`, as a number. */
  readonly weight: number;
  /** Whether the face is a slanted one. */
  readonly italic: boolean;
}

/**
 * Read the two axes out of an embedded font's own name.
 *
 * The name is the strongest statement either side can make about weight and slant: the PDF carries no
 * "bold" property, only the face the run was drawn in, and `mplus1mn-bold_italic` is a different file
 * from `mplus1mn-regular`. So both sides are measured as "which of the family's four faces is this",
 * the preview's through the computed weight and slant the browser would pick a face by.
 *
 * @param name - The embedded font's base name, subset prefix already stripped.
 * @returns The axes it names.
 */
function axesOfFace(name: string): StyleAxes {
  const suffix = name.slice(name.indexOf('-') + 1).toLowerCase();
  return {
    weight: suffix.startsWith('bold') ? 700 : 400,
    italic: suffix.endsWith('italic'),
  };
}

/** One inline construct as the browser resolved it. */
interface MeasuredInline extends StyleAxes {
  /** The used background colour, or null when nothing is painted behind it. */
  readonly background: Rgb | null;
  /** The element's own width in points, which is the chip's width where one is painted. */
  readonly widthPt: number;
}

/**
 * Every codespan on the prepared page, by its text.
 *
 * By text rather than by selector, so the comparison below can be exhaustive: every `<code>` the
 * preview lays out must be accounted for by a run in the reference, which is what stops a fixture
 * from drifting into carrying a construct nothing checks.
 *
 * @param page - The browser page.
 * @returns One entry per codespan, keyed on its text.
 */
async function codespansOf(page: Page): Promise<Record<string, MeasuredInline>> {
  return page.evaluate((perPoint) => {
    const out: Record<string, MeasuredInline> = {};
    for (const element of document.querySelectorAll('[data-testid="page"] code')) {
      const style = getComputedStyle(element);
      const match = /rgba?\(\s*([\d.]+)[,\s]+([\d.]+)[,\s]+([\d.]+)(?:[,/\s]+([\d.]+))?/.exec(
        style.backgroundColor,
      );
      const opaque = match !== null && (match[4] === undefined || Number(match[4]) > 0);
      out[element.textContent ?? ''] = {
        weight: Number.parseInt(style.fontWeight, 10),
        italic: style.fontStyle === 'italic',
        background: opaque ? [Number(match[1]), Number(match[2]), Number(match[3])] : null,
        widthPt: element.getBoundingClientRect().width / perPoint,
      };
    }
    return out;
  }, PIXELS_PER_POINT);
}

/**
 * Hold every codespan on the page to the face the reference drew it in.
 *
 * @param page - The browser page.
 * @param name - The fixture to compare.
 * @returns What was measured on each side, so a caller can go on to ask about the chips.
 */
async function compareFaces(
  page: Page,
  name: string,
): Promise<{ preview: Record<string, MeasuredInline>; reference: Record<string, StyleAxes> }> {
  const fixture = readFixture(name);
  // Through the render worker, because one of the subjects is a cell the worker NAMES: Asciidoctor's
  // HTML says the same thing for a monospaced column and for a codespan filling a cell, and the
  // stylesheet can only tell them apart by the mark the worker writes.
  await preparePrintPage(page, fixture, await renderWithWorker(fixture));

  const preview = await codespansOf(page);
  const runs = await textRuns(fixture.referencePdf);
  const reference: Record<string, StyleAxes> = {};
  for (const text of Object.keys(preview)) {
    const run = runs.find((candidate) => candidate.text === text);
    expect(run, `the reference draws a run reading ${JSON.stringify(text)}`).toBeDefined();
    if (run !== undefined) reference[text] = axesOfFace(run.fontFamily);
  }

  expect(Object.keys(preview).length, 'the fixture lays out several codespans').toBeGreaterThan(4);
  for (const [text, measured] of Object.entries(preview)) {
    expect(
      { text, ...({ weight: measured.weight, italic: measured.italic } as StyleAxes) },
      `the codespan reading ${JSON.stringify(text)}`,
    ).toEqual({ text, ...reference[text] });
  }
  return { preview, reference };
}

test.describe('an inline construct takes its face from its own fragment, not from the block around it', () => {
  test('every codespan is set in the face the reference drew it in', async ({ page }) => {
    // The anchor is deliberately theme-less: with the renderer's own default theme the codespan
    // category names no font style at all, so every answer below comes from the block or the markup
    // around the construct and from nothing else.
    //
    //   - in the caption, upright, where the caption's own face is italic
    //   - in the header column, regular, where the header cell's own face is bold
    //   - in the `m` column and in a plain cell, regular
    //   - inside `_…_`, italic — the markup's, which does travel in
    //   - inside `*…*`, bold — likewise
    //   - in the heading, bold, because `ink_heading` is the one block that passes its style in
    await compareFaces(page, 'inline-context');
  });

  test("a theme's codespan style forces the axis it names and leaves the other to the markup", async ({
    page,
  }) => {
    // `to_styles` turns `bold` into a one-element set and `update_fragment` MERGES it, so the theme
    // decides the weight everywhere and the slant is still the markup's: the codespan inside `_…_` is
    // drawn in the mono face's bold_italic, which is the face a projection writing both axes could
    // never have produced. The reference is what says so.
    const { preview } = await compareFaces(page, 'inline-context-styled');

    // And the `m` column takes neither. `convert_table`'s `:monospaced` branch opens with
    // `cell_data.delete :font_style` and then reads only `[:family]` and `[:size]` out of `font_info`
    // (converter.rb:2165-2173) — so under this theme the cell is regular while the codespan an author
    // wrote beside it is bold. That is the one arrangement in which the two can be told apart at all.
    expect(preview['Ctrl+D']?.weight, 'the monospaced column ignores the theme it is set by').toBe(400);
    expect(preview['d']?.weight, 'and a codespan an author wrote does not').toBe(700);
  });

  test('the chip is painted behind what the reference paints one behind, and nowhere else', async ({
    page,
  }) => {
    // The other half of the reported defect, and the half that turns out to be right: the cells of a
    // header column carry codespans an AUTHOR wrote, which are ordinary inline fragments, so
    // `TextBackgroundAndBorderRenderer` really does paint the theme's tint behind them. A cell the
    // `m` column made monospaced has no fragment of its own and gets nothing.
    const fixture = readFixture('inline-context-styled');
    await preparePrintPage(page, fixture, await renderWithWorker(fixture));
    const preview = await codespansOf(page);

    // `toBeDefined` before `not.toBeNull`, and in that order, because the second passes on `undefined`:
    // a `preview` with no entry under this key satisfied it, and the `return` under it then skipped the
    // chip count, every width below and the `not.toContain` at the end without a word. The entry has to
    // exist AND carry a colour before any of that is worth comparing.
    expect(preview['d'], 'the fixture lays out the codespan the theme chips').toBeDefined();
    const chip = preview['d']?.background ?? null;
    expect(chip, 'the theme gives the codespan a chip').not.toBeNull();
    // Unreachable — `expect` throws — and present only so the type narrows past it.
    if (chip === null) return;

    const boxes = await paintedBoxes(fixture.referencePdf);
    const painted = boxes.filter((box) => box.filled && sameColour(box.colour, chip));
    const chipped = Object.entries(preview).filter(([, measured]) => measured.background !== null);

    // Same number of chips on both sides, and each one the same width. Width rather than position,
    // because the two pages set the same text in the same face at the same size: a chip that ended up
    // behind a different construct would be a different run's width.
    expect(chipped.length, 'the preview chips as many constructs as the page does').toBe(painted.length);
    const previewWidths = chipped.map(([, measured]) => measured.widthPt).toSorted((a, b) => a - b);
    const pageWidths = painted.map((box) => box.widthPt).toSorted((a, b) => a - b);
    for (const [index, width] of previewWidths.entries()) {
      expect(
        Math.abs(width - pageWidths[index]),
        `chip ${index}: preview ${width.toFixed(2)}pt, page ${pageWidths[index].toFixed(2)}pt`,
      ).toBeLessThanOrEqual(PRINT_FIDELITY_TOLERANCE.geometryPt);
    }
    expect(
      chipped.map(([text]) => text),
      'and the monospaced cell is not one of them',
    ).not.toContain('Ctrl+D');
  });

  test('every block that styles its own title leaves a codespan inside it alone — except a heading', async ({
    page,
  }) => {
    // The anchors above measure a TABLE caption and a header cell, because those are the two the
    // reference documents put a codespan in. The rule is not about tables: `convert_caption` is the
    // one path a figure, an example and a listing title all take, and a sidebar title and a
    // description-list term are ordinary `theme_font` blocks. None of them is in the three places that
    // pass styles into the formatter — `apply_text_decoration` is called exactly three times in the
    // converter, for a caption with `[]`, a heading with `font_styles`, and a toc entry with an empty
    // set — so a codespan in any of them is upright and regular, and the heading beside them is the
    // one that is not.
    //
    // No reference PDF, and that is the same division the construct checks in this suite already
    // make: what the anchors establish is the RULE, measured against a real render; what this asks is
    // whether the rule reached the other containers the stylesheet has to carry it to. Each container
    // is checked to really be styled first, so a stylesheet that stopped italicising captions
    // altogether could not make this pass.
    await preparePrintDocument(page, {
      source: [
        '= Doc',
        '',
        '.A figure title with `figure-code`',
        'image::diagram.svg[A diagram]',
        '',
        '.An example title with `example-code`',
        '====',
        'Example content.',
        '====',
        '',
        '.A listing title with `listing-code`',
        '----',
        'listing content',
        '----',
        '',
        '.A sidebar title with `sidebar-code`',
        '****',
        'Sidebar content.',
        '****',
        '',
        'A `term-code` term::',
        'Its description.',
        '',
        '== A heading with `heading-code`',
        '',
        'Closing text.',
        '',
      ].join('\n'),
    });

    const measured = await page.evaluate(() =>
      Object.fromEntries(
        (
          [
            ['figure', '.imageblock > .title'],
            ['example', '.exampleblock > .title'],
            ['listing', '.listingblock > .title'],
            ['sidebar', '.sidebarblock .title'],
            ['term', 'dl > dt'],
            ['heading', 'h2'],
          ] as const
        ).map(([which, selector]) => {
          const container = document.querySelector(`[data-testid="page"] ${selector}`);
          // The container and the codespan inside it, read the same way, so the pair below is one
          // measurement rather than two spellings of one.
          const [outer, inner] = [container, container?.querySelector('code') ?? null].map(
            (element) => {
              if (element === null) return null;
              const style = getComputedStyle(element);
              return {
                weight: Number.parseInt(style.fontWeight, 10),
                italic: style.fontStyle === 'italic',
              };
            },
          );
          return [which, { container: outer, code: inner }];
        }),
      ),
    );

    for (const [which, pair] of Object.entries(measured)) {
      expect(pair.container, `the preview lays out the ${which}`).not.toBeNull();
      expect(pair.code, `and a codespan inside the ${which}`).not.toBeNull();
      // The container really does carry a style of its own — otherwise there is nothing to not
      // inherit, and the assertion below would hold on a page that styles nothing at all.
      expect(
        pair.container?.weight !== 400 || pair.container.italic,
        `the ${which} is set in a face of its own`,
      ).toBe(true);
    }

    // A caption is italic and a sidebar title, a term and a heading are bold; the codespan inside each
    // is regular and upright — except the heading's, which the renderer hands its own styles to.
    for (const which of ['figure', 'example', 'listing', 'sidebar', 'term']) {
      expect(measured[which].code, `the codespan in the ${which}`).toEqual({
        weight: 400,
        italic: false,
      });
    }
    expect(measured['heading'].code, 'and the one in the heading takes the heading’s weight').toEqual({
      weight: 700,
      italic: false,
    });
  });
});
