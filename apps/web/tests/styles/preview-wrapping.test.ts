/* @jest-environment jsdom */
import { readFileSync } from 'node:fs';
import path from 'node:path';

// Regression guard for the preview's horizontal-scrollbar bug: a `----` listing block holding one very
// long line did not wrap, so the code card (and, for an unbreakable token, the whole preview pane)
// scrolled sideways. The fix soft-wraps verbatim content by default — matching Asciidoctor's own
// `prewrap` default — while still honouring the author's `[%nowrap]` / `:prewrap!:` opt-out, and never
// hiding overflow.
//
// The assertions run against the REAL stylesheets in a jsdom document, so they exercise the actual
// cascade (specificity + source order) rather than the text of a rule. The HTML fragments are exactly
// what Asciidoctor 3.0 emits for each construct, verified against the converter.
//
// jsdom's getComputedStyle resolves matching rules but does NOT propagate inherited properties to
// children, so container-level inheritance is asserted on the container itself (inheritance is a CSS
// guarantee, the declaration is what we can regress on).
const BRAND = path.resolve(__dirname, '../../src/styles/asciidoc-preview.css');
const GENERATED = path.resolve(__dirname, '../../src/styles/asciidoctor-style.generated.css');

/** The preview's own markup: generated sheet first, then the brand sheet — as asciidoc-preview.tsx imports them. */
const STYLESHEETS = `${readFileSync(GENERATED, 'utf8')}\n${readFileSync(BRAND, 'utf8')}`;

/** One listing/literal/verse block per construct, as emitted by Asciidoctor for the sources in comments. */
const FRAGMENT = `
<div class="paragraph"><p id="paragraph">regular text</p></div>
<div class="listingblock"><div class="content"><pre id="listing">long line…</pre></div></div>
<div class="listingblock"><div class="content"><pre id="listing-nowrap" class="nowrap">long line…</pre></div></div>
<div class="listingblock"><div class="content"><pre id="source" class="highlight"><code class="language-js" data-lang="js">const x = 1;</code></pre></div></div>
<div class="listingblock"><div class="content"><pre id="source-nowrap" class="highlight nowrap"><code class="language-js" data-lang="js">const x = 1;</code></pre></div></div>
<div class="literalblock"><div class="content"><pre id="literal">long line…</pre></div></div>
<div class="verseblock"><pre id="verse" class="content">a verse</pre></div>
<div class="paragraph"><p><span id="role-nowrap" class="nowrap">keep on one line</span> <span id="role-nobreak" class="nobreak">keep words whole</span></p></div>
<table id="table" class="tableblock frame-all grid-all stretch"><colgroup><col style="width: 100%;"></colgroup><tbody><tr><td id="cell" class="tableblock halign-left valign-top"><p id="cell-text" class="tableblock">https://example.com/an-unbreakable-token</p></td></tr></tbody></table>
`;

/** Mount the fragment under a preview container in the given style and return a computed-style reader. */
function mountPreview(style: 'asciidocollab' | 'asciidoctor') {
  document.head.innerHTML = `<style>${STYLESHEETS}</style>`;
  const container = document.createElement('div');
  container.className = 'asciidoc-preview-content';
  container.dataset['previewStyle'] = style;
  container.innerHTML = FRAGMENT;
  document.body.replaceChildren(container);
  return {
    container,
    styleOf(id: string): CSSStyleDeclaration {
      const element = document.querySelector(`#${id}`);
      if (element === null) throw new Error(`fixture is missing #${id}`);
      return getComputedStyle(element);
    },
  };
}

describe('brand preview style: verbatim blocks soft-wrap by default', () => {
  // `----` with one long line was the reported bug: `white-space: pre` left it behind a horizontal
  // scrollbar. Asciidoctor sets the `prewrap` attribute out of the box, so wrapping is the default the
  // preview should have had all along.
  it.each([
    ['a listing block (`----`)', 'listing'],
    ['a source block (`[source]`)', 'source'],
    ['a literal block (`....`)', 'literal'],
    ['a verse block (`[verse]`)', 'verse'],
  ])('wraps %s', (_label, id) => {
    const { styleOf } = mountPreview('asciidocollab');
    expect(styleOf(id).whiteSpace).toBe('pre-wrap');
    // A lone over-long token (a URL, a base64 blob) has no wrap opportunity, so wrapping alone would
    // still let it widen the card and the pane.
    expect(styleOf(id).getPropertyValue('overflow-wrap')).toBe('anywhere');
  });

  it('never hides verbatim overflow, so an opted-out block scrolls instead of clipping its text', () => {
    const { styleOf } = mountPreview('asciidocollab');
    for (const id of ['listing', 'listing-nowrap']) {
      expect(styleOf(id).overflowX).toBe('auto');
      expect(styleOf(id).maxWidth).toBe('100%');
    }
  });

  it('breaks unbreakable tokens in prose, headings and table cells via the container', () => {
    // Long unbroken prose words / URLs spill out of their own box and drag the whole scroll container
    // sideways; the container declaration every text context inherits is what prevents it.
    const { container } = mountPreview('asciidocollab');
    expect(getComputedStyle(container).getPropertyValue('overflow-wrap')).toBe('anywhere');
  });
});

describe('brand preview style: the author can opt out of wrapping', () => {
  // `[%nowrap]` on the block, or `:prewrap!:` on the document, both become `class="nowrap"` on the
  // `pre`. Column alignment (ASCII diagrams, aligned output) then survives, at the cost of a scrollbar
  // that block explicitly asked for.
  it.each([
    ['a plain verbatim block', 'listing-nowrap'],
    ['a highlighted source block', 'source-nowrap'],
  ])('honours nowrap on %s', (_label, id) => {
    const { styleOf } = mountPreview('asciidocollab');
    // `pre`, NOT `nowrap`: the inline `.nowrap` role must not reach the `pre` and collapse every
    // newline in the block onto a single line.
    expect(styleOf(id).whiteSpace).toBe('pre');
    expect(styleOf(id).getPropertyValue('overflow-wrap')).toBe('normal');
  });

  it('keeps the inline nowrap/nobreak roles working on spans', () => {
    const { styleOf } = mountPreview('asciidocollab');
    expect(styleOf('role-nowrap').whiteSpace).toBe('nowrap');
    // `[.nobreak]` means "do not break inside a word" (it opts out of the container's `anywhere`), not
    // "never wrap" — the latter would itself make the pane scroll.
    expect(styleOf('role-nobreak').getPropertyValue('overflow-wrap')).toBe('normal');
    expect(styleOf('role-nobreak').whiteSpace).not.toBe('nowrap');
  });
});

describe('Asciidoctor preview style is unaffected', () => {
  // The faithful style already wrapped (`pre{white-space:pre-wrap}` + `pre.nowrap{white-space:pre}` in
  // the vendored sheet); this guards that the brand rules above stay out of it (Constitution VI).
  it('still wraps verbatim blocks and honours nowrap from its own vendored sheet', () => {
    const { styleOf } = mountPreview('asciidoctor');
    expect(styleOf('listing').whiteSpace).toBe('pre-wrap');
    expect(styleOf('listing-nowrap').whiteSpace).toBe('pre');
  });

  // The one place the vendored sheet cannot contain itself inside a pane. It resets `word-wrap: normal`
  // on `table`, so a cell holding a single unbreakable token has no wrap opportunity and the table's
  // min-content width drags the whole preview sideways — the pane scrolled by ~2300px on a 300-character
  // URL in a `|===` cell. The container's `anywhere` cannot help: the table's own reset overrides it for
  // everything inside.
  it('breaks an unbreakable token inside a table cell, which its own table reset would not', () => {
    const { styleOf } = mountPreview('asciidoctor');
    for (const id of ['cell', 'cell-text']) {
      expect(styleOf(id).getPropertyValue('overflow-wrap')).toBe('anywhere');
    }
  });

  it('clamps a table to the pane rather than letting it set the pane width', () => {
    expect(mountPreview('asciidoctor').styleOf('table').maxWidth).toBe('100%');
  });
});
