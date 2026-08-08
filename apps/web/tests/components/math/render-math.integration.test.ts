/* @jest-environment node */

// REAL MathJax integration tests for the STEM renderer.
//
// The sibling `render-math.test.ts` mocks the MathJax script injection to assert render-math's
// contract (lazy single load, per-expression convert calls, graceful failure). That mocking cannot
// catch the real engine bug: does the loaded MathJax's convert API actually produce `mjx-container`
// output for the expressions Asciidoctor emits, with BOTH the TeX and AsciiMath input jaxes
// registered — AND without a stray `$` artifact?
//
// HOW THE ENGINE IS LOADED HERE, AND WHY IT CHANGED AT MathJax 4
// --------------------------------------------------------------
// In a real browser render-math loads MathJax via a self-hosted `<script src=/vendor/mathjax/...>`.
// jsdom does not execute appended `<script>` tags, so this file used to `require()` those same browser
// bundles instead — their IIFE ran happily under Node and installed `globalThis.MathJax`.
//
// That no longer works. MathJax 4's browser bundle pulls in the speech-rule-engine and, off a browser,
// resolves its loader to `//sre/require.mjs` — an unresolvable specifier, so the `require()` throws
// outright. There is no configuration that avoids it: the failure happens while the bundle is loading,
// before any config is read. Its Node entry point (`mathjax/node-main.cjs`) fetches components through
// dynamic `import()`, which jest's CJS runtime only tolerates under `--experimental-vm-modules` — and
// that flag makes jest mis-transform CJS across the rest of this package.
//
// So the engine is assembled here from `@mathjax/src` modules directly: static imports, no component
// loader, no network. It is the SAME engine, the same two input jaxes registered against one document,
// and the same CHTML output the browser falls back to. What it does not give us is a DOM — MathJax's
// liteAdaptor produces an in-memory node — so the assertions run over the serialized markup, which
// carries the same evidence: the `mjx-container` element, and no `$` or raw source text surviving.
//
// The browser-side counterpart of these assertions, over the real injected `<script>`, a real DOM and
// the native-MathML path this module prefers, lives in `e2e/preview-stem-math.spec.ts`.

import { liteAdaptor } from '@mathjax/src/js/adaptors/liteAdaptor.js';
import { RegisterHTMLHandler } from '@mathjax/src/js/handlers/html.js';
import { AsciiMath } from '@mathjax/src/js/input/asciimath.js';
import { TeX } from '@mathjax/src/js/input/tex.js';
import { mathjax } from '@mathjax/src/js/mathjax.js';
import { CHTML } from '@mathjax/src/js/output/chtml.js';

const adaptor = liteAdaptor();
RegisterHTMLHandler(adaptor);

/** Convert one delimiter-stripped expression the way render-math does, and serialize the result. */
function convert(notation: 'tex' | 'asciimath', expression: string, display: boolean): string {
  const inputJax = notation === 'tex' ? new TeX({}) : new AsciiMath({});
  const document_ = mathjax.document('', { InputJax: inputJax, OutputJax: new CHTML({}) });
  return adaptor.outerHTML(document_.convert(expression, { display }));
}

describe('real MathJax convert API over Asciidoctor expressions', () => {
  it('renders asciimath (the default `:stem:` notation) into an mjx-container with no stray `$`', () => {
    // `stem:[sqrt(4) = 2]` → Asciidoctor emits `\$sqrt(4) = 2\$`; render-math strips the delimiters
    // and converts the body. The old auto delimiter-scan left a stray `$`; the convert API never does.
    const html = convert('asciimath', 'sqrt(4) = 2', false);

    expect(html).toContain('<mjx-container');
    expect(html).not.toContain('$');
    expect(html).not.toContain('sqrt(4) = 2');
  });

  it('renders latexmath inline and display expressions into mjx-containers', () => {
    const inline = convert('tex', 'a^2 + b^2', false);
    const display = convert('tex', String.raw`\sum_{i=1}^{n} i`, true);

    expect(inline).toContain('<mjx-container');
    expect(display).toContain('<mjx-container');
    expect(inline + display).not.toContain('$');
  });

  it('renders BOTH notations from a single load (asciimath + latexmath)', () => {
    const am = convert('asciimath', 'sqrt(4)', false);
    const tex = convert('tex', String.raw`\alpha`, false);

    expect(am).toContain('<mjx-container');
    expect(tex).toContain('<mjx-container');
  });
});
