/**
 * Canonical reference build: today's in-app web-format render against a pinned, external Asciidoctor
 * toolchain converting the same document with the same attributes.
 *
 * This is the only gate that can say the preview is RIGHT. The previous-engine regression gate
 * compares the app with its own earlier self, so it cannot see a defect that has always been there;
 * the page-format parity suite never loads this engine at all. What is compared here is conversion
 * output, and every way in which the app's output legitimately differs from the reference's is a
 * NAMED pass in `harness/reference-build.ts` — never a comparison loosened until the corpus passes.
 *
 * That last point is why this file also pins the passes directly, against markup small enough to
 * read: a corpus that passes looks exactly the same whether the normalisation is precise or whether
 * it has been widened until nothing can fail. The corpus says the render agrees with Asciidoctor;
 * only the pinning test says the agreement was worth anything.
 *
 * Needs Docker, and skips cleanly without it, the way the page-format tooling does. A skipped run is
 * not a passing run: if this reports skipped in a sweep that was supposed to establish fidelity, the
 * sweep did not establish it.
 *
 * Run it with:
 *   pnpm --filter `@asciidocollab/web` exec playwright test web-format-reference \
 *     --config playwright.render-equivalence.config.ts
 */

import { test, expect, type Page } from '@playwright/test';
import { corpusDocuments, renderCorpusDocument, CAPTURE_IMAGES_DIR } from './harness/capture';
import { canonicaliseRenderedHtml, describeSequenceDifference } from './harness/dom-equivalence';
import {
  buildReferenceRenders,
  dockerAvailable,
  normaliseForReferenceComparison,
  referenceDiagrams,
  type ReferenceDiagram,
  type ReferenceNormalisationInput,
  type ReferenceRender,
} from './harness/reference-build';

const documents = corpusDocuments();

/** The reference toolchain's conversions, built once for the whole run. */
let references: Map<string, ReferenceRender> = new Map();

/**
 * Normalise and canonicalise one side of the comparison.
 *
 * Both sides go through the same normalisation and the same real HTML parser, in a real browser, so
 * the verdict is about what the markup MEANS rather than how either toolchain happened to serialise
 * it.
 */
async function canonicalise(
  page: Page,
  input: ReferenceNormalisationInput,
): Promise<{ lines: readonly string[]; identifiers: readonly string[] }> {
  const normalised = await page.evaluate(normaliseForReferenceComparison, input);
  return page.evaluate(canonicaliseRenderedHtml, normalised);
}

/** The reference toolchain's side: its diagram styles arrive beside its HTML, and it maps no images. */
async function canonicaliseReferenceSide(
  page: Page,
  html: string,
  diagrams: readonly ReferenceDiagram[],
): Promise<{ lines: readonly string[]; identifiers: readonly string[] }> {
  return canonicalise(page, {
    html,
    imageEndpointBase: CAPTURE_IMAGES_DIR,
    diagrams,
    mapsImagesToEndpoint: false,
  });
}

/** The app's side: its diagrams are marked in its own markup, and its image targets are mapped. */
async function canonicaliseAppSide(
  page: Page,
  html: string,
): Promise<{ lines: readonly string[]; identifiers: readonly string[] }> {
  return canonicalise(page, {
    html,
    imageEndpointBase: CAPTURE_IMAGES_DIR,
    diagrams: [],
    mapsImagesToEndpoint: true,
  });
}

/**
 * Describe how the app's render differs from the reference toolchain's, or `null` when they agree.
 *
 * @param label - What is being compared, so the report names it.
 * @param reference - The reference toolchain's canonical form.
 * @param app - The app's canonical form.
 * @returns A human-readable report, or `null`.
 */
function describeDifference(
  label: string,
  reference: { lines: readonly string[]; identifiers: readonly string[] },
  app: { lines: readonly string[]; identifiers: readonly string[] },
): string | null {
  const reports = [
    describeSequenceDifference(
      'identifiers (`id` attributes — a difference here is a cross-reference that resolves ' +
        'differently in the app than it does in Asciidoctor)',
      reference.identifiers,
      app.identifiers,
    ),
    describeSequenceDifference(
      'element tree (`-` is the reference toolchain, `+` is the app; attribute order and ' +
        'inter-element whitespace already normalised away)',
      reference.lines,
      app.lines,
    ),
  ].filter((report) => report !== null);

  if (reports.length === 0) return null;
  return [
    `${label} does not render the way the canonical Asciidoctor toolchain renders it.`,
    'Every legitimate difference is a named pass in harness/reference-build.ts. Anything reported ' +
      'here is either an unaccounted-for difference or a rendering defect — do not widen a pass to ' +
      'make it go away.',
    ...reports,
  ].join('\n\n');
}

test.describe('web-format render against the canonical reference build', () => {
  test.skip(
    !dockerAvailable(),
    'Docker is not available, so the pinned reference toolchain cannot be built or run.',
  );

  test.beforeAll(async () => {
    references = await buildReferenceRenders(documents);
  });

  test('the corpus yields comparison cases', () => {
    // A gate with nothing to compare passes vacuously, which is indistinguishable from a gate that
    // compared everything and found nothing wrong. Fidelity is not established by an empty run.
    expect(documents.length, 'corpus documents to compare').toBeGreaterThan(0);
    expect(references.size, 'documents converted by the reference toolchain').toBe(documents.length);
  });

  test('the normalisation undoes what the app adds, and nothing else', async ({ page }) => {
    // The same block of content as each toolchain emits it: a passthrough `<style>` the HTML parser
    // hoists out of the body, a highlighted source block, an image, a diagram, and an ordinary
    // paragraph carrying an author's own identifier.
    const referenceSide =
      '<style>.note{color:red}</style>' +
      '<div class="listingblock"><div class="content">' +
      '<pre class="rouge highlight"><code data-lang="ruby">a = 1</code></pre></div></div>' +
      '<div class="imageblock"><div class="content"><img src="assets/x.png" alt="x"></div></div>' +
      '<div class="listingblock"><div class="content"><pre>graph TD;\n  A --&gt; B;</pre></div></div>' +
      '<div class="paragraph"><p id="author-anchor">Prose.</p></div>' +
      '<div id="footnotes"><hr>' +
      '<div class="footnote" id="_footnotedef_1"><a href="#_footnoteref_1">1</a>. The note itself.</div></div>';
    // The diagram is the second verbatim block of the reference side; its declared style does not
    // survive conversion, so it arrives beside the HTML.
    const referenceDiagramBlocks: readonly ReferenceDiagram[] = [{ blockIndex: 1, type: 'mermaid' }];

    const appSide =
      '<style>.note{color:red}</style>' +
      '<div id="__src_listing_3" data-source-line="3" data-source-file="a.adoc" class="listingblock">' +
      '<div class="content"><pre class="highlight hljs"><code class="language-ruby" data-lang="ruby">' +
      '<span class="hljs-variable">a</span> = <span class="hljs-number">1</span></code></pre></div></div>' +
      '<div id="__src_image_5" data-source-line="5" class="imageblock"><div class="content">' +
      `<img src="${CAPTURE_IMAGES_DIR}/assets/x.png" alt="x"></div></div>` +
      '<div class="adc-diagram" data-diagram-engine="mermaid" data-source-line="7">graph TD;\n  A --&gt; B;</div>' +
      '<div class="paragraph"><p id="author-anchor">Prose.</p></div>' +
      '<div id="footnotes"><hr>' +
      '<div class="footnote" id="_footnotedef_1"><a href="#_footnoteref_1">1</a>' +
      '<span class="footnote-separator">. </span>The note itself.</div></div>';

    // Each of these is a difference the app is ENTITLED to, and the reason the corresponding pass
    // exists. Together they are the whole of what the comparison forgives.
    const forgiven = new Map<string, string>([
      [
        'everything the app adds at once — token spans, synthetic ids, provenance, the image endpoint, ' +
          'the diagram placeholder and the named footnote separator',
        appSide,
      ],
      ['the app naming its own highlighter', appSide.replace('highlight hljs', 'hljs highlight')],
      [
        'a diagram placeholder that also records which file it came from',
        appSide.replace('data-source-line="7"', 'data-source-line="7" data-source-file="a.adoc"'),
      ],
    ]);

    // Each of these is a difference that would matter, stated as a mutation of the app's side. If any
    // of them stops being reported, a pass has been widened past what it exists for.
    //
    // A pass may catch a mutation by refusing the input outright instead of reporting a difference —
    // the image pass does, because it undoes the app's rewrite and so cannot see the rewrite missing.
    // Such a case names the refusal it expects, because "some error was thrown" is what a normalisation
    // that had stopped working at all would also produce, and then every case here would pass on it.
    const refused = new Map<string, { readonly markup: string; readonly refusal?: RegExp }>([
      ['a changed character in the code', { markup: appSide.replace('= <span class="hljs-number">1', '= <span class="hljs-number">2') }],
      [
        're-indented code',
        { markup: appSide.replace('<code class="language-ruby" data-lang="ruby">', '<code class="language-ruby" data-lang="ruby">  ') },
      ],
      ['a re-indented diagram source', { markup: appSide.replace('  A --&gt; B;', '    A --&gt; B;') }],
      ['a changed code language', { markup: appSide.replace('data-lang="ruby"', 'data-lang="python"') }],
      ['a dropped code element', { markup: appSide.replace('<code class="language-ruby" data-lang="ruby">', '').replace('</code>', '') }],
      ['an unexpected extra class on a highlighted block', { markup: appSide.replace('highlight hljs', 'highlight hljs sneaky') }],
      ['a renamed author identifier', { markup: appSide.replace('id="author-anchor"', 'id="renamed-anchor"') }],
      ['a changed image target', { markup: appSide.replace('assets/x.png', 'assets/y.png') }],
      // The separator's span is unwrapped, not deleted — so what it holds is still compared.
      [
        'a changed footnote separator',
        { markup: appSide.replace('<span class="footnote-separator">. </span>', '<span class="footnote-separator">, </span>') },
      ],
      ['a renamed footnote back-link', { markup: appSide.replace('href="#_footnoteref_1"', 'href="#_footnoteref_2"') }],
      [
        'an image no longer served from the endpoint',
        {
          markup: appSide.replace(`${CAPTURE_IMAGES_DIR}/assets`, 'assets'),
          refusal: /leaves the project-relative image target "assets\/x\.png" unmapped/,
        },
      ],
      ['a changed diagram type', { markup: appSide.replace('data-diagram-engine="mermaid"', 'data-diagram-engine="graphviz"') }],
      ['a changed diagram source', { markup: appSide.replace('A --&gt; B;', 'A --&gt; C;') }],
      ['a diagram left as a listing block', { markup: appSide.replace('class="adc-diagram"', 'class="listingblock"') }],
      ['changed prose', { markup: appSide.replace('Prose.', 'Different prose.') }],
      // The parser puts this one in `<head>`, so it is only compared because both sides are read
      // whole rather than from the body down.
      ['a changed passthrough style', { markup: appSide.replace('color:red', 'color:blue') }],
      ['a lost element', { markup: appSide.replace('<div class="paragraph"><p id="author-anchor">Prose.</p></div>', '') }],
    ]);

    const reference = await canonicaliseReferenceSide(page, referenceSide, referenceDiagramBlocks);
    for (const [what, markup] of forgiven) {
      const app = await canonicaliseAppSide(page, markup);
      expect(describeDifference(what, reference, app), `the comparison should forgive ${what}`).toBeNull();
    }
    for (const [what, { markup, refusal }] of refused) {
      const outcome = await canonicaliseAppSide(page, markup).then(
        (app) => ({ report: describeDifference(what, reference, app), refusedWith: null }),
        (error: unknown) => ({
          report: null,
          refusedWith: error instanceof Error ? error.message : String(error),
        }),
      );
      if (refusal === undefined) {
        expect(
          outcome.refusedWith,
          `${what} should be reported as a difference, not thrown as an error`,
        ).toBeNull();
        expect(outcome.report, `the comparison must not forgive ${what}`).not.toBeNull();
      } else {
        expect(outcome.refusedWith, `the comparison must refuse ${what}, and say why`).toMatch(refusal);
      }
    }
  });

  for (const [index, document] of documents.entries()) {
    test(`${document.name} renders as the canonical toolchain renders it`, async ({ page }) => {
      const reference = references.get(document.name);
      if (reference === undefined) {
        throw new Error(`the reference toolchain produced no conversion for "${document.name}".`);
      }

      const canonicalReference = await canonicaliseReferenceSide(
        page,
        reference.html,
        referenceDiagrams(reference),
      );
      const canonicalApp = await canonicaliseAppSide(page, await renderCorpusDocument(document, index + 1));

      // A normalisation bug that emptied one side would make every later assertion pass while
      // comparing nothing at all.
      expect(
        canonicalReference.lines.length,
        `the reference toolchain's conversion of "${document.name}" reduced to nothing`,
      ).toBeGreaterThan(0);

      // The report goes in the assertion's message rather than its value: a failing `toBeNull` would
      // echo the whole report back as an escaped one-line string, and the point of it is to be read.
      const difference = describeDifference(`"${document.name}"`, canonicalReference, canonicalApp);
      expect(difference === null, difference ?? undefined).toBe(true);
    });
  }
});
