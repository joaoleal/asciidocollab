/**
 * Cross-format agreement: the web-formatted preview and the page-formatted preview of the SAME
 * document, compared on what both media can express.
 *
 * The two previews are produced by two engines that share no code — the JS Asciidoctor package in the
 * render worker, and Asciidoctor-PDF vendored into ruby.wasm. Nothing else in the repository compares
 * them, so until this gate existed the requirement that the two formats agree had no vehicle at all:
 * the web-format gates compare the preview with an HTML oracle and with its own earlier self, and the
 * page-format parity suite compares the PDF with a reference PDF. Both could pass while the two
 * previews said different things about the same source.
 *
 * Three dimensions are compared and no others — rendered text in document order, heading hierarchy
 * and numbering, and the cross-reference target set. Fonts, spacing, colour, page breaks and layout
 * are page-format concerns with no web-format counterpart, and they belong to the page-format
 * reference-parity suite, which is the right oracle for them.
 *
 * Every way in which the two media legitimately draw the same content differently is a named
 * reconciliation in `harness/cross-format.ts`, and this file pins each one directly, against markup
 * small enough to read. That is deliberate: a corpus that passes looks exactly the same whether the
 * reconciliation is precise or whether it has been widened until nothing can fail. The corpus says
 * the two formats agree; only the pinning test says the agreement was worth anything.
 *
 * Stack-free, and it skips cleanly when the page-format engine has not been built, the way the
 * neighbouring suites do. A skipped run is not a passing run: if this reports skipped in a sweep that
 * was supposed to establish that the formats agree, the sweep did not establish it.
 *
 * Run it with:
 *   pnpm --filter `@asciidocollab/web` exec playwright test cross-format-agreement \
 *     --config playwright.render-equivalence.config.ts
 */

import { test, expect } from '@playwright/test';
import { createParityEngine, type ParityEngine } from '../pdf-parity/harness/engine';
import { renderOurs } from '../pdf-parity/harness/pipeline';
import { nodeShims } from '../pdf-parity/harness/shims';
import { corpusDocuments, renderCorpusDocument } from './harness/capture';
import { describeSequenceDifference } from './harness/dom-equivalence';
import {
  describeTextDifference,
  EXCLUDED_FROM_CROSS_FORMAT,
  extractPageFormatDocument,
  extractWebFormatDocument,
  pageFormatEngineAvailable,
  pageFormatSnapshot,
  reconcilePageFormatText,
  WASM_ENGINE_PATH,
  type CrossFormatDocument,
} from './harness/cross-format';

/** The whole corpus, so the exclusion list can be checked against something real. */
const corpus = corpusDocuments();

/** The page format's side, reconciled and reduced exactly as the corpus comparison reduces it. */
function reducePageFormatText(text: string): string {
  return reconcilePageFormatText(text).replaceAll(/\s+/gu, '');
}

/** The documents both formats are asked to render — the corpus minus the named exclusions. */
const sharedDocuments = corpus.filter((document) => !EXCLUDED_FROM_CROSS_FORMAT.has(document.name));

/**
 * Describe how the two formats disagree about one document, or `null` when they agree.
 *
 * @param documentName - The corpus document being compared, so the report names it.
 * @param web - The web format's reduction.
 * @param pageFormat - The page format's reduction.
 * @returns A human-readable report, or `null`.
 */
function describeDisagreement(
  documentName: string,
  web: CrossFormatDocument,
  pageFormat: CrossFormatDocument,
): string | null {
  const reports = [
    describeTextDifference(web.text, pageFormat.text),
    describeSequenceDifference(
      'heading hierarchy and numbering (`-` is the web format, `+` the page format; the level is ' +
        "the leading number, and a section number is part of the heading's text)",
      web.headings,
      pageFormat.headings,
    ),
    describeSequenceDifference(
      'cross-reference targets (`-` is the web format, `+` the page format; sorted, so a target ' +
        'reported on one side only is a reference that exists in one format and not the other, and ' +
        '"(unresolved)" is a target that resolves to nothing in its own document)',
      web.references,
      pageFormat.references,
    ),
  ].filter((report) => report !== null);

  if (reports.length === 0) return null;
  return [
    `"${documentName}" does not say the same thing in both preview formats.`,
    'Every difference the two media legitimately draw differently is a named reconciliation in ' +
      'harness/cross-format.ts. Anything reported here is either an unaccounted-for difference or a ' +
      'rendering defect — do not widen a reconciliation to make it go away.',
    ...reports,
  ].join('\n\n');
}

test.describe('cross-format agreement between the two preview formats', () => {
  let engine: ParityEngine;

  test.beforeAll(async () => {
    test.skip(
      !pageFormatEngineAvailable(),
      `the page-format engine is not built at ${WASM_ENGINE_PATH}; build it (pnpm wasm) to enable this gate.`,
    );
    engine = await createParityEngine(WASM_ENGINE_PATH);
  });

  test.afterAll(() => {
    engine?.dispose();
  });

  test('the shared document set yields comparison cases', () => {
    // A gate with nothing to compare passes vacuously, which is indistinguishable from a gate that
    // compared everything and found nothing wrong.
    expect(sharedDocuments.length, 'documents compared across the two formats').toBeGreaterThan(0);
    // An exclusion that names nothing is coverage that quietly disappeared when a document was
    // renamed: the filter above would keep excluding a name no corpus document has.
    for (const [name] of EXCLUDED_FROM_CROSS_FORMAT) {
      expect(
        corpus.some((document) => document.name === name),
        `the excluded document "${name}" is in the corpus`,
      ).toBe(true);
    }
    // The cross-reference dimension is exercised only by documents that HAVE cross-references. Two
    // of the corpus documents do — one written by hand, one produced by footnote round-trips — and
    // without them the run would still report three dimensions while comparing two, which is the
    // failure this dimension was added to prevent.
    for (const name of ['anchors-xrefs', 'tables-lists']) {
      expect(
        sharedDocuments.some((document) => document.name === name),
        `"${name}" is compared, so the cross-reference dimension is exercised`,
      ).toBe(true);
    }
  });

  test('the reconciliation forgives what the two media draw differently, and nothing else', async ({ page }) => {
    // The same content as each format renders it: a bullet and a task in a checklist, a nested
    // ordered list, a callout beside its code and in its callout list, an admonition drawn with an
    // icon, an attributed quotation, and a footnote definition. Every construct here is one where
    // the two media legitimately differ.
    const webSide =
      '<div class="ulist checklist"><ul class="checklist">' +
      '<li><p>A bullet</p></li>' +
      '<li><p><i class="fa fa-square-o"></i> A task</p></li>' +
      '</ul></div>' +
      '<div class="olist arabic"><ol class="arabic">' +
      '<li><p>First step</p></li>' +
      '<li><p>Second step</p><div class="olist loweralpha"><ol class="loweralpha" type="a">' +
      '<li><p>Nested step</p></li></ol></div></li>' +
      '</ol></div>' +
      '<pre class="highlight"><code data-lang="ruby">require \'json\' ' +
      '<i class="conum" data-value="1"></i><b>(1)</b></code></pre>' +
      '<div class="colist arabic"><table><tr>' +
      '<td><i class="conum" data-value="1"></i><b>1</b></td><td>The callout.</td>' +
      '</tr></table></div>' +
      '<div class="admonitionblock note"><table><tr>' +
      '<td class="icon"><i class="fa icon-note" title="Note"></i></td>' +
      '<td class="content">An admonition.</td>' +
      '</tr></table></div>' +
      '<div class="quoteblock"><blockquote><div class="paragraph"><p>Quoted.</p></div></blockquote>' +
      '<div class="attribution">&#8212; A. Author<br><cite>A Source</cite></div></div>' +
      '<div id="footnotes"><hr>' +
      '<div class="footnote" id="_footnotedef_1"><a href="#_footnoteref_1">1</a>. The footnote.</div>' +
      '</div>';

    // The same content as the page format's text layer carries it: bullets and checkboxes drawn as
    // glyphs, ordered markers written out, callouts as circled digits, the note's icon at its
    // private-use slot in the icon font (U+F05A, exactly as the engine emits it), the attribution on
    // one line, and the footnote definition labelled `[1]`.
    const pageSide = [
      '• A bullet',
      '☐ A task',
      '1. First step',
      '2. Second step',
      'a. Nested step',
      "require 'json' ①",
      '① The callout.',
      '\u{F05A} An admonition.',
      'Quoted.',
      '— A. Author, A Source',
      '[1] The footnote.',
    ].join('\n');

    /** The web format's side, reduced by the real extractor in a real browser. */
    const webDocument = async (html: string): Promise<CrossFormatDocument> =>
      page.evaluate(extractWebFormatDocument, html);

    const expectedText = reducePageFormatText(pageSide);
    const agreeing = await webDocument(webSide);
    expect(
      describeTextDifference(agreeing.text, expectedText),
      'the two media may draw markers, callouts, icons, attributions and footnote labels differently',
    ).toBeNull();

    // Each of these is a difference that would matter, stated as a mutation of the web format's side.
    // If any of them stops being reported, a reconciliation has been widened past what it exists for.
    const refused = new Map<string, string>([
      ['changed prose', webSide.replace('The callout.', 'A different callout.')],
      ['a lost list item', webSide.replace('<li><p>A bullet</p></li>', '')],
      ['a renumbered ordered list', webSide.replace('<ol class="arabic">', '<ol class="arabic" start="4">')],
      ['a re-styled ordered list', webSide.replace('<ol class="loweralpha" type="a">', '<ol class="lowerroman" type="i">')],
      ['a changed callout number beside the code', webSide.replace('data-value="1"></i><b>(1)</b>', 'data-value="2"></i><b>(2)</b>')],
      ['a changed callout number in the callout list', webSide.replace('data-value="1"></i><b>1</b>', 'data-value="3"></i><b>3</b>')],
      ['a changed footnote number', webSide.replace('<a href="#_footnoteref_1">1</a>', '<a href="#_footnoteref_1">2</a>')],
      ['a lost citation', webSide.replace('<cite>A Source</cite>', '')],
      ['a changed attribution', webSide.replace('A. Author', 'B. Author')],
      ['reordered blocks', webSide.replace('<td>The callout.</td>', '<td>Quoted.</td>').replace('<p>Quoted.</p>', '<p>The callout.</p>')],
      ['code that lost a character', webSide.replace("require 'json'", "require 'jsn'")],
    ]);
    for (const [what, markup] of refused) {
      const mutated = await webDocument(markup);
      expect(
        describeTextDifference(mutated.text, expectedText),
        `the comparison must not forgive ${what}`,
      ).not.toBeNull();
    }

    // The other two dimensions, on the same terms: a heading carries its level and its section
    // number, and a cross-reference carries the identifier it resolves to — or the fact that it
    // resolves to nothing, which is the defect the dimension exists to catch.
    const headingSide = await webDocument(
      '<h1 id="t">A Title</h1><h2 id="s">1. A Section</h2><h3 id="u">1.1. A Subsection</h3>' +
        '<p><a href="#s">here</a> and <a href="#gone">nowhere</a></p>',
    );
    expect(headingSide.headings).toEqual(['1 A Title', '2 1. A Section', '3 1.1. A Subsection']);
    expect(headingSide.references).toEqual(['gone (unresolved)', 's']);
  });

  for (const [index, document] of sharedDocuments.entries()) {
    test(`${document.name} says the same thing in both preview formats`, async ({ page }) => {
      const { pdfBytes, diagnostics } = await renderOurs(
        pageFormatSnapshot(document),
        nodeShims(),
        engine,
      );
      expect(diagnostics, `page-format render diagnostics: ${JSON.stringify(diagnostics)}`).toHaveLength(0);

      const pageFormat = await extractPageFormatDocument(pdfBytes);
      const webFormat: CrossFormatDocument = await page.evaluate(
        extractWebFormatDocument,
        await renderCorpusDocument(document, index + 1),
      );

      // A reduction bug that emptied one side would make the comparison below pass while comparing
      // nothing at all.
      expect(webFormat.text.length, `the web format reduced "${document.name}" to nothing`).toBeGreaterThan(0);
      expect(pageFormat.text.length, `the page format reduced "${document.name}" to nothing`).toBeGreaterThan(0);
      // Every corpus document has a title and sections, so an empty heading list is a reduction that
      // stopped reading one side rather than two documents that happen to agree about having none.
      expect(
        webFormat.headings.length,
        `the web format found no headings in "${document.name}"`,
      ).toBeGreaterThan(0);
      expect(
        pageFormat.headings.length,
        `the page format found no headings in "${document.name}"`,
      ).toBeGreaterThan(0);

      // The report goes in the assertion's message rather than its value: a failing `toBeNull` would
      // echo the whole report back as an escaped one-line string, and the point of it is to be read.
      const difference = describeDisagreement(document.name, webFormat, pageFormat);
      expect(difference === null, difference ?? undefined).toBe(true);
    });
  }
});
