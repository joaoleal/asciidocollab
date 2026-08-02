/**
 * Regression gate: today's in-app web-format render against the output captured from the engine as it
 * behaved before this feature touched it.
 *
 * It answers one question — *did the upgrade change anything?* — and it is the only gate that can. The
 * canonical-reference gate compares against external truth and so can pass both before and after an
 * upgrade that quietly altered something its enumerated normalisation happens to cover; the
 * page-format parity suite never loads this engine at all. Being a comparison of the app against its
 * own earlier self, this gate cannot in turn establish that the render is *correct* — see the README
 * for which gate discharges what.
 *
 * The comparison ignores how the markup was laid out and the order attributes were written in, and
 * compares everything else — attribute values, structure, text, and in particular every `id` and every
 * source-provenance marker, which carry behaviour rather than appearance. {@link canonicaliseRenderedHtml}
 * holds the rules.
 *
 * Run it with:
 *   pnpm --filter `@asciidocollab/web` exec playwright test web-format-equivalence \
 *     --config playwright.render-equivalence.config.ts
 */

import { test, expect } from '@playwright/test';
import { corpusDocuments, readFixture, renderCorpusDocument, fixturePath } from './harness/capture';
import { canonicaliseRenderedHtml, describeRenderDifference } from './harness/dom-equivalence';

const documents = corpusDocuments();

test.describe('web-format render equivalence with the previous engine', () => {
  test('the corpus and its captured fixtures are both present', () => {
    // A gate with nothing to compare passes vacuously, so the absence of either side is a failure in
    // its own right rather than something the per-document checks quietly skip.
    expect(documents.length, 'the corpus is empty, so the gate would compare nothing').toBeGreaterThan(0);

    // An EMPTY fixture file counts as no fixture: it exists, so `readFixture` returns a string rather
    // than null, and the per-document comparison would reduce both sides of a truncated fixture to
    // nothing and report agreement.
    const uncaptured = documents
      .filter((document) => (readFixture(document.name) ?? '').trim().length === 0)
      .map((document) => fixturePath(document.name));
    expect(
      uncaptured,
      'these corpus documents have no captured fixture, or their fixture file is empty. They can only ' +
        'be captured from the engine as it was BEFORE this feature changed it — see ' +
        'capture-previous-engine.spec.ts.',
    ).toEqual([]);
  });

  test('the comparison ignores layout and attribute order, and nothing else', async ({ page }) => {
    // The gate is only as good as what its normalisation refuses to forgive, and that is not visible
    // from a passing corpus run: a normalisation widened until everything matches would look exactly
    // the same. So the rules are pinned here directly, against markup small enough to read.
    const baseline =
      '<div class="sect1" id="chapter"><h2 id="intro" data-source-line="4" data-source-file="a.adoc">Intro</h2>' +
      '<pre><code>  indented\n  lines</code></pre></div>';

    const equivalent = new Map<string, string>([
      [
        'reflowed markup',
        '<div class="sect1" id="chapter">\n  <h2 id="intro" data-source-line="4" data-source-file="a.adoc">\n    Intro\n  </h2>\n  <pre><code>  indented\n  lines</code></pre>\n</div>',
      ],
      [
        'attributes written in a different order',
        '<div id="chapter" class="sect1"><h2 data-source-file="a.adoc" data-source-line="4" id="intro">Intro</h2>' +
          '<pre><code>  indented\n  lines</code></pre></div>',
      ],
    ]);

    const different = new Map<string, string>([
      ['a renamed identifier', baseline.replace('id="intro"', 'id="introduction"')],
      ['a moved source line', baseline.replace('data-source-line="4"', 'data-source-line="5"')],
      ['a changed source file', baseline.replace('data-source-file="a.adoc"', 'data-source-file="b.adoc"')],
      ['a changed attribute value', baseline.replace('class="sect1"', 'class="sect2"')],
      ['changed text', baseline.replace('Intro', 'Introduction')],
      ['a lost identifier', baseline.replace(' id="intro"', '')],
      ['re-indented code', baseline.replace('  indented', '    indented')],
      ['a changed element name', baseline.replace('<h2 ', '<h3 ').replace('</h2>', '</h3>')],
    ]);

    const canonicalBaseline = await page.evaluate(canonicaliseRenderedHtml, baseline);
    for (const [what, markup] of equivalent) {
      const canonical = await page.evaluate(canonicaliseRenderedHtml, markup);
      expect(
        describeRenderDifference(what, canonicalBaseline, canonical),
        `the comparison should forgive ${what}`,
      ).toBeNull();
    }
    for (const [what, markup] of different) {
      const canonical = await page.evaluate(canonicaliseRenderedHtml, markup);
      expect(
        describeRenderDifference(what, canonicalBaseline, canonical),
        `the comparison must not forgive ${what}`,
      ).not.toBeNull();
    }

    // A leading passthrough `<style>` or `<meta>` is content the render emitted, but the HTML parser
    // hoists it out of a fragment's body and into `<head>`. Compared like everything else, so a
    // changed one fails rather than falling outside the comparison.
    const hoisted = '<style>.admonitionblock{color:red}</style><p>Body.</p>';
    const canonicalHoisted = await page.evaluate(canonicaliseRenderedHtml, hoisted);
    const canonicalHoistedChanged = await page.evaluate(
      canonicaliseRenderedHtml,
      hoisted.replace('red', 'blue'),
    );
    expect(
      canonicalHoisted.lines.some((line) => line.includes('style')),
      'markup the parser hoists into <head> is part of the comparison',
    ).toBe(true);
    expect(
      describeRenderDifference('a changed hoisted style', canonicalHoisted, canonicalHoistedChanged),
      'the comparison must not forgive a change to markup the parser hoists into <head>',
    ).not.toBeNull();

    // "No difference" is not on its own evidence that anything was compared: two empty documents
    // agree, and so would two sides a broken canonicalisation had emptied. The per-document
    // comparison below therefore asserts that each side reduced to something, and this is the case
    // that would otherwise sail through it.
    const canonicalEmpty = await page.evaluate(canonicaliseRenderedHtml, '');
    expect(canonicalEmpty.lines).toEqual([]);
    expect(
      describeRenderDifference('two empty documents', canonicalEmpty, canonicalEmpty),
      'an empty document agrees with an empty document, which is why emptiness is checked separately',
    ).toBeNull();
  });

  for (const [index, document] of documents.entries()) {
    test(`${document.name} renders as the previous engine rendered it`, async ({ page }) => {
      const fixture = readFixture(document.name);
      if (fixture === null) {
        throw new Error(
          `${fixturePath(document.name)} is missing, so there is nothing to compare "${document.name}" against.`,
        );
      }
      const current = await renderCorpusDocument(document, index + 1);

      // Both sides go through the same real HTML parser, in a real browser, so the verdict is about
      // what the markup MEANS rather than about how either side was serialised.
      const canonicalFixture = await page.evaluate(canonicaliseRenderedHtml, fixture);
      const canonicalCurrent = await page.evaluate(canonicaliseRenderedHtml, current);

      // Agreement between two empty sequences is agreement about nothing: a truncated fixture, or a
      // canonicalisation that emptied both sides symmetrically, would otherwise report that the
      // render is unchanged while comparing no markup at all.
      expect(
        canonicalFixture.lines.length,
        `the captured fixture for "${document.name}" reduced to nothing`,
      ).toBeGreaterThan(0);
      expect(
        canonicalCurrent.lines.length,
        `today's render of "${document.name}" reduced to nothing`,
      ).toBeGreaterThan(0);

      // The report goes in the assertion's message rather than its value: a failing `toBeNull` would
      // echo the whole report back as an escaped one-line string, and the point of the report is that
      // it can be read.
      const difference = describeRenderDifference(document.name, canonicalFixture, canonicalCurrent);
      expect(difference === null, difference ?? undefined).toBe(true);
    });
  }
});
