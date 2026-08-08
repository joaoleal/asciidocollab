/* @jest-environment jsdom */

// Tests for render-math.ts.
//
// render-math loads MathJax via a real self-hosted `<script>` tag (`/vendor/mathjax/tex-mml-chtml.js`)
// — not an ES import — because the package's `es5/*` files are browser IIFE bundles whose deferred
// startup never runs when webpack imports them as modules in the browser. So here we intercept the
// script injection: when render-math appends its `<script>` to the head, we install a fake MathJax
// (mirroring how the real bundle reads `window.MathJax` config then attaches the convert helpers +
// startup document) and synchronously fire the script's `load` event.
//
// The renderer does NOT use MathJax's auto delimiter-scan (`typesetPromise`) — that mishandles
// Asciidoctor's `\$…\$` asciimath delimiters and leaves a stray `$`. Instead it finds each delimited
// expression itself, strips the delimiters, and converts the raw expression with the explicit convert
// API (`tex2chtmlPromise` / `asciimath2chtmlPromise`), replacing the delimited text/content node with
// the produced container. These tests assert that contract: lazy single load, dual-notation config,
// the right convert call per expression with delimiters stripped, the produced node replacing the
// delimited source (so NO `$`/`\$` survives), INCREMENTAL re-render (an already-typeset expression
// keeps the very node it had), and graceful failure.

import { renderMath, resetMathJaxForTest } from '@/components/math/render-math';

interface ConvertCall {
  math: string;
  display: boolean;
}

// Records every convert call so tests can assert the stripped expression + display flag passed in.
const texCalls: ConvertCall[] = [];
const asciimathCalls: ConvertCall[] = [];

// The produced container holds rendered glyphs, NOT the source string — mirror that here (a real
// `mjx-container` never echoes the raw expression text), so "delimiters/source gone" assertions on
// the container's textContent are meaningful rather than passing trivially.
const tex2chtmlPromiseMock = jest.fn((math: string, options: { display: boolean }) => {
  texCalls.push({ math, display: options.display });
  return Promise.resolve(makeMjxContainer('⟦tex⟧'));
});
const asciimath2chtmlPromiseMock = jest.fn((math: string, options: { display: boolean }) => {
  asciimathCalls.push({ math, display: options.display });
  return Promise.resolve(makeMjxContainer('⟦am⟧'));
});
// MathML-output helpers (`*2mmlPromise`) return a serialized MathML STRING (not a node) — exactly as
// the real `tex-mml-chtml` bundle does. The returned `<math>` deliberately does NOT echo the raw
// expression, so "source/delimiters gone" assertions stay meaningful; the stripped expression is
// asserted via `mmlCalls` instead.
const mmlCalls: Array<ConvertCall & { notation: 'tex' | 'asciimath' }> = [];
const tex2mmlPromiseMock = jest.fn((math: string, options: { display: boolean }) => {
  mmlCalls.push({ notation: 'tex', math, display: options.display });
  return Promise.resolve('<math xmlns="http://www.w3.org/1998/Math/MathML"><mi>T</mi></math>');
});
const asciimath2mmlPromiseMock = jest.fn((math: string, options: { display: boolean }) => {
  mmlCalls.push({ notation: 'asciimath', math, display: options.display });
  return Promise.resolve('<math xmlns="http://www.w3.org/1998/Math/MathML"><mn>4</mn></math>');
});
const documentClearMock = jest.fn();
const documentUpdateMock = jest.fn();

/** A stand-in for a real MathJax `mjx-container` output node. */
function makeMjxContainer(label: string): HTMLElement {
  const element = realCreateElement('mjx-container');
  element.textContent = label;
  return element;
}

/** What the faked MathJax bundle attaches to `window.MathJax` when the script "loads". */
type BundleArmer = () => void;

/** Reproduce the real bundle's side effect: augment the installed config with the convert API. */
function defaultBundle(): void {
  const existing = (globalThis as unknown as { MathJax?: Record<string, unknown> }).MathJax ?? {};
  (globalThis as unknown as { MathJax: Record<string, unknown> }).MathJax = {
    ...existing,
    tex2chtmlPromise: tex2chtmlPromiseMock,
    asciimath2chtmlPromise: asciimath2chtmlPromiseMock,
    tex2mmlPromise: tex2mmlPromiseMock,
    asciimath2mmlPromise: asciimath2mmlPromiseMock,
    startup: {
      ...(existing.startup as object),
      promise: Promise.resolve(),
      document: { clear: documentClearMock, updateDocument: documentUpdateMock },
    },
  };
}

// The next script-load handler installs whatever `armBundle` is set to. Tests swap it to simulate a
// minimal bundle, a load failure, etc. `loadCount` proves the singleton only injects one script.
let armBundle: BundleArmer = defaultBundle;
// When true, the next script injection fires `error` (asset unreachable) instead of `load`.
let failNextLoad = false;
let loadCount = 0;
// The unconditional `createElement` overload is flagged deprecated by the typed lint rule, but it is
// exactly the real factory we delegate to when our spy sees a non-script tag — keep a typed handle.
// eslint-disable-next-line @typescript-eslint/no-deprecated
let realCreateElement: typeof document.createElement;

beforeEach(() => {
  tex2chtmlPromiseMock.mockClear();
  asciimath2chtmlPromiseMock.mockClear();
  tex2mmlPromiseMock.mockClear();
  asciimath2mmlPromiseMock.mockClear();
  documentClearMock.mockClear();
  documentUpdateMock.mockClear();
  texCalls.length = 0;
  asciimathCalls.length = 0;
  mmlCalls.length = 0;
  delete (globalThis as unknown as { MathJax?: unknown }).MathJax;
  resetMathJaxForTest();
  armBundle = defaultBundle;
  failNextLoad = false;
  loadCount = 0;

  // Intercept `<script>` creation so appending it doesn't actually fetch — instead, on append we run
  // the armed bundle (installing the fake MathJax onto the config render-math just set) and fire the
  // script's `load` event, exactly as the browser would once the real bundle executes.
  // eslint-disable-next-line @typescript-eslint/no-deprecated
  realCreateElement = document.createElement.bind(document);
  jest.spyOn(document, 'createElement').mockImplementation((tagName: string, options?: ElementCreationOptions) => {
    const element = realCreateElement(tagName, options);
    if (tagName.toLowerCase() === 'script') {
      const script = element as HTMLScriptElement;
      // Patch the method render-math uses to add the script to the DOM (`head.append`). On append we
      // run the armed bundle and fire `load` (or `error`), as the browser would once the script runs.
      const originalAppend = document.head.append.bind(document.head);
      jest.spyOn(document.head, 'append').mockImplementationOnce((...nodes: (Node | string)[]): void => {
        originalAppend(...nodes);
        if (nodes.includes(script)) {
          loadCount += 1;
          if (failNextLoad) {
            failNextLoad = false;
            script.dispatchEvent(new Event('error'));
          } else {
            armBundle();
            script.dispatchEvent(new Event('load'));
          }
        }
      });
    }
    return element;
  });
});

afterEach(() => {
  jest.restoreAllMocks();
});

function makeContainer(html: string): HTMLElement {
  const element = realCreateElement('div');
  element.className = 'asciidoc-preview-content';
  element.innerHTML = html;
  document.body.append(element);
  return element;
}

describe('renderMath', () => {
  it('configures BOTH TeX and AsciiMath input notations (and the asciimath loader) before loading', async () => {
    await renderMath(makeContainer(String.raw`<p>\$sqrt(4)\$</p>`));

    const config = (globalThis as unknown as { MathJax: Record<string, unknown> }).MathJax;
    // TeX delimiters (latexmath) — inline `\(…\)` and display `\[…\]`.
    expect(config.tex).toEqual({ inlineMath: [[String.raw`\(`, String.raw`\)`]], displayMath: [[String.raw`\[`, String.raw`\]`]] });
    // AsciiMath delimiters — Asciidoctor wraps asciimath in `\$…\$`.
    expect(config.asciimath).toEqual({ delimiters: [[String.raw`\$`, String.raw`\$`]] });
    // tex-mml-chtml does not bundle the AsciiMath input jax — it must be requested from the loader so
    // MathJax fetches it same-origin from the self-hosted base.
    expect(config.loader).toEqual({
      load: ['input/asciimath'],
      paths: { fonts: '/vendor/mathjax/fonts' },
    });
  });

  it('serves fonts from our own origin, never MathJax 4\'s default CDN', async () => {
    // MathJax 4 moved the fonts into a separate package and defaults `loader.paths.fonts` to
    // `https://cdn.jsdelivr.net/npm/@mathjax`. Every URL the engine can be told about must therefore be
    // pinned at the self-hosted copy, or rendering an equation reaches out to a third party.
    await renderMath(makeContainer(String.raw`<p>\$sqrt(4)\$</p>`));

    const config = (globalThis as unknown as {
      MathJax: { loader?: { paths?: Record<string, string> }; chtml?: Record<string, string> };
    }).MathJax;

    for (const url of [
      config.loader?.paths?.fonts,
      config.chtml?.fontURL,
      config.chtml?.dynamicPrefix,
    ]) {
      expect(url).toBeDefined();
      expect(url).toMatch(/^\/vendor\/mathjax\//);
    }
  });

  it('leaves MathJax 4\'s speech, braille and enrichment extensions off', async () => {
    // MathJax 3 loaded no accessibility extension, so these defaulting to ON in v4 would be new
    // behaviour: extra work on every expression, and enrichment rewriting the MathML with explicit
    // invisible-times operators. Screen readers are served by the native MathML this module prefers.
    //
    // Asserted as `menuOptions.settings` deliberately: the document-level `enableEnrichment` flag is
    // silently ineffective in 4.1.3, so a test written against that shape would pass while enrichment
    // kept running.
    await renderMath(makeContainer(String.raw`<p>\$sqrt(4)\$</p>`));

    const config = (globalThis as unknown as {
      MathJax: { options?: { menuOptions?: { settings?: Record<string, boolean> } } };
    }).MathJax;

    expect(config.options?.menuOptions?.settings).toMatchObject({
      enrich: false,
      speech: false,
      braille: false,
    });
  });

  it('converts inline asciimath via asciimath2chtmlPromise with delimiters stripped, leaving NO `$`', async () => {
    const container = makeContainer(String.raw`<p>Inline \$sqrt(4) = 2\$ here.</p>`);
    await renderMath(container);

    // The asciimath body is converted with its `\$…\$` delimiters removed (no stray `$`).
    expect(asciimathCalls).toEqual([{ math: 'sqrt(4) = 2', display: false }]);
    expect(tex2chtmlPromiseMock).not.toHaveBeenCalled();
    // The produced container replaced the delimited source: a real mjx-container is present and the
    // raw `\$`/`$`/source are gone — this is the stray-`$` regression guard.
    expect(container.querySelectorAll('mjx-container').length).toBe(1);
    expect(container.textContent ?? '').not.toContain('$');
    expect(container.textContent ?? '').not.toContain('sqrt(4) = 2');
    // Surrounding prose is preserved.
    expect(container.textContent ?? '').toContain('Inline');
    expect(container.textContent ?? '').toContain('here.');
  });

  it('converts inline latexmath `\\(…\\)` via tex2chtmlPromise (inline) and display `\\[…\\]` (display)', async () => {
    const container = makeContainer(String.raw`<p>\(a^2\) and \[\sum i\]</p>`);
    await renderMath(container);

    expect(texCalls).toEqual([
      { math: 'a^2', display: false },
      { math: String.raw`\sum i`, display: true },
    ]);
    expect(asciimath2chtmlPromiseMock).not.toHaveBeenCalled();
    expect(container.querySelectorAll('mjx-container').length).toBe(2);
    expect(container.textContent ?? '').not.toContain(String.raw`\(`);
    expect(container.textContent ?? '').not.toContain(String.raw`\[`);
  });

  it('converts a `<div class="stemblock">` body (asciimath) as a display expression', async () => {
    const container = makeContainer(
      String.raw`<div class="stemblock"><div class="content">\$sum_(i=1)^n i = (n(n+1))/2\$</div></div>`,
    );
    await renderMath(container);

    expect(asciimathCalls).toEqual([{ math: 'sum_(i=1)^n i = (n(n+1))/2', display: true }]);
    const content = container.querySelector('.stemblock .content');
    expect(content?.querySelector('mjx-container')).not.toBeNull();
    expect(container.textContent ?? '').not.toContain('$');
  });

  it('does NOT typeset delimiter look-alikes inside a code/listing block (regex backslashes are not math)', async () => {
    // Asciidoctor emits literal `\[`/`\(` for backslash/regex content in verbatim blocks. That is
    // NOT math — typesetting it would rip the sequence out of the rendered code and corrupt it. The
    // scan must skip `<pre>`/`<code>` subtrees exactly as it skips `.stemblock` and `mjx-container`.
    const container = makeContainer(
      String.raw`<div class="listingblock"><div class="content"><pre class="highlight"><code>const re = /\[0-9\]+/; f\(x\)</code></pre></div></div>`,
    );
    await renderMath(container);

    expect(tex2chtmlPromiseMock).not.toHaveBeenCalled();
    expect(asciimath2chtmlPromiseMock).not.toHaveBeenCalled();
    expect(container.querySelectorAll('mjx-container').length).toBe(0);
    // The verbatim code is preserved exactly — no delimiter was stripped out of it.
    expect(container.textContent ?? '').toContain(String.raw`/\[0-9\]+/`);
  });

  it('does NOT typeset delimiter look-alikes inside inline `<code>`', async () => {
    const container = makeContainer(String.raw`<p>Use <code>\[0-9\]</code> for digits.</p>`);
    await renderMath(container);

    expect(tex2chtmlPromiseMock).not.toHaveBeenCalled();
    expect(container.querySelectorAll('mjx-container').length).toBe(0);
    expect(container.textContent ?? '').toContain(String.raw`\[0-9\]`);
  });

  // ── MathML output when the browser supports it (prefer native MathML over CHTML) ──────────────
  // When the browser exposes the MathML interface, render-math converts each expression to NATIVE
  // MathML (`tex2mmlPromise`/`asciimath2mmlPromise` → a `<math>` element) instead of CHTML, so the
  // browser's own MathML engine renders it. Without MathML support it falls back to CHTML.
  describe('MathML output (browser supports MathML)', () => {
    beforeEach(() => {
      (globalThis as unknown as { MathMLElement?: unknown }).MathMLElement = class {};
    });
    afterEach(() => {
      delete (globalThis as unknown as { MathMLElement?: unknown }).MathMLElement;
    });

    it('converts inline asciimath to a native `<math>` element (not CHTML)', async () => {
      const container = makeContainer(String.raw`<p>Inline \$sqrt(4) = 2\$ here.</p>`);
      await renderMath(container);

      expect(mmlCalls).toEqual([{ notation: 'asciimath', math: 'sqrt(4) = 2', display: false }]);
      expect(asciimath2chtmlPromiseMock).not.toHaveBeenCalled();
      // A real <math> element replaced the delimited source; no CHTML container, no stray `$`.
      expect(container.querySelectorAll('math').length).toBe(1);
      expect(container.querySelector('mjx-container')).toBeNull();
      expect(container.textContent ?? '').not.toContain('$');
      expect(container.textContent ?? '').not.toContain('sqrt(4) = 2');
      // Surrounding prose preserved.
      expect(container.textContent ?? '').toContain('Inline');
    });

    it('converts inline latexmath via tex2mmlPromise to a `<math>` element', async () => {
      const container = makeContainer(String.raw`<p>\(x^2\)</p>`);
      await renderMath(container);

      expect(mmlCalls).toEqual([{ notation: 'tex', math: 'x^2', display: false }]);
      expect(tex2chtmlPromiseMock).not.toHaveBeenCalled();
      expect(container.querySelectorAll('math').length).toBe(1);
    });

    it('converts a `[stem]` block body to a `<math display="block">` element', async () => {
      const container = makeContainer(
        String.raw`<div class="stemblock"><div class="content">\$sqrt(4) = 2\$</div></div>`,
      );
      await renderMath(container);

      expect(mmlCalls).toEqual([{ notation: 'asciimath', math: 'sqrt(4) = 2', display: true }]);
      const math = container.querySelector('.stemblock .content math');
      expect(math).not.toBeNull();
      // Native block layout: a display equation carries `display="block"` on the <math> element.
      expect(math?.getAttribute('display')).toBe('block');
      expect(container.querySelector('mjx-container')).toBeNull();
    });

    it('falls back to CHTML when the browser does NOT support MathML', async () => {
      delete (globalThis as unknown as { MathMLElement?: unknown }).MathMLElement;
      const container = makeContainer(String.raw`<p>\$sqrt(4)\$</p>`);
      await renderMath(container);

      expect(asciimath2chtmlPromiseMock).toHaveBeenCalledTimes(1);
      expect(asciimath2mmlPromiseMock).not.toHaveBeenCalled();
      expect(container.querySelectorAll('mjx-container').length).toBe(1);
      expect(container.querySelector('math')).toBeNull();
    });

    it('falls back to CHTML when the loaded bundle exposes no MathML convert helper', async () => {
      // MathML is supported by the browser, but the bundle did not provide `*2mmlPromise` — render
      // must still produce CHTML rather than leaving the math unrendered.
      armBundle = () => {
        defaultBundle();
        const mj = (globalThis as unknown as { MathJax: Record<string, unknown> }).MathJax;
        delete mj.tex2mmlPromise;
        delete mj.asciimath2mmlPromise;
      };
      const container = makeContainer(String.raw`<p>\$sqrt(4)\$</p>`);
      await renderMath(container);

      expect(asciimath2chtmlPromiseMock).toHaveBeenCalledTimes(1);
      expect(container.querySelectorAll('mjx-container').length).toBe(1);
      expect(container.querySelector('math')).toBeNull();
    });

    it('falls back to CHTML when the MathML markup does not parse to a <math> element', async () => {
      asciimath2mmlPromiseMock.mockResolvedValueOnce('<span>not math</span>');
      const container = makeContainer(String.raw`<p>\$sqrt(4)\$</p>`);
      await renderMath(container);

      expect(asciimath2mmlPromiseMock).toHaveBeenCalledTimes(1); // MathML attempted first…
      expect(asciimath2chtmlPromiseMock).toHaveBeenCalledTimes(1); // …then fell back to CHTML
      expect(container.querySelectorAll('mjx-container').length).toBe(1);
      expect(container.querySelector('math')).toBeNull();
    });
  });

  it('handles a mixed container (inline asciimath + inline tex + block) in one pass, leaving no delimiters', async () => {
    const container = makeContainer(
      String.raw`<p>\$sqrt(4)\$ and \(x^2\)</p><div class="stemblock"><div class="content">\[y=1\]</div></div>`,
    );
    await renderMath(container);

    // Both inline TeX (`x^2`) and the block TeX (`y=1`, display) are converted; conversion order
    // between block and inline sites is an internal detail, so assert on membership not sequence.
    expect(asciimathCalls).toEqual([{ math: 'sqrt(4)', display: false }]);
    expect(texCalls).toEqual(
      expect.arrayContaining([
        { math: 'x^2', display: false },
        { math: 'y=1', display: true },
      ]),
    );
    expect(texCalls).toHaveLength(2);
    expect(container.querySelectorAll('mjx-container').length).toBe(3);
    const text = container.textContent ?? '';
    expect(text).not.toContain('$');
    expect(text).not.toContain(String.raw`\(`);
    expect(text).not.toContain(String.raw`\[`);
  });

  it('attaches CHTML styles after conversion via startup.document.clear + updateDocument', async () => {
    await renderMath(makeContainer(String.raw`<p>\$sqrt(4)\$</p>`));
    expect(documentClearMock).toHaveBeenCalledTimes(1);
    expect(documentUpdateMock).toHaveBeenCalledTimes(1);
  });

  it('loads MathJax only once across multiple renders (singleton cache)', async () => {
    await renderMath(makeContainer(String.raw`<p>\(a\)</p>`));
    await renderMath(makeContainer(String.raw`<p>\(b\)</p>`));

    expect(loadCount).toBe(1);
    expect(tex2chtmlPromiseMock).toHaveBeenCalledTimes(2);
  });

  it('leaves an already-typeset expression alone — the same node, and no second conversion', async () => {
    // This pass runs after every refresh, and a refresh reaches the container as a PATCH: an
    // expression still typeset here is one whose source the patch left alone, because putting a
    // typeset expression back to its delimiters is precisely what the patch does when the source
    // changed. Converting it again would spend MathJax's time to arrive at the same output while
    // discarding the node on screen — and with it anything the browser hangs off that node.
    const container = makeContainer(String.raw`<p>\$sqrt(4)\$</p>`);
    await renderMath(container);
    const typeset = container.querySelector('mjx-container');
    await renderMath(container);

    expect(asciimath2chtmlPromiseMock).toHaveBeenCalledTimes(1);
    expect(container.querySelectorAll('mjx-container').length).toBe(1);
    expect(container.textContent ?? '').not.toContain('$');
    // Identity, not equality: an identical replacement would still have been a re-typeset.
    expect(container.querySelector('mjx-container')).toBe(typeset);
  });

  it('typesets an expression the patch has put back to its delimited source', async () => {
    // The counterpart to the check above: leaving typeset expressions alone must not become a way of
    // never noticing a changed one. An edited expression arrives as delimited text again, exactly as
    // it did on the first pass, and is converted afresh.
    const container = makeContainer(String.raw`<p>\$sqrt(4)\$</p>`);
    await renderMath(container);
    container.innerHTML = String.raw`<p>\$sqrt(9)\$</p>`; // what patching an edited expression leaves
    await renderMath(container);

    expect(asciimath2chtmlPromiseMock).toHaveBeenCalledTimes(2);
    expect(asciimath2chtmlPromiseMock).toHaveBeenLastCalledWith('sqrt(9)', { display: false });
    expect(container.querySelectorAll('mjx-container').length).toBe(1);
  });

  it('leaves a malformed expression in place without throwing (conversion rejects)', async () => {
    asciimath2chtmlPromiseMock.mockRejectedValueOnce(new Error('bad expression'));
    const container = makeContainer(String.raw`<p>\$bad\$ and \$sqrt(4)\$</p>`);
    // Must resolve (never reject) so a malformed expression can never break the preview.
    await expect(renderMath(container)).resolves.toBeUndefined();
    // The good expression still renders; the bad one is left as its source (one container only).
    expect(container.querySelectorAll('mjx-container').length).toBe(1);
  });

  it('swallows a load failure and resets the cache so a later render retries', async () => {
    // First load: the bundle's startup handshake rejects → loadMathJax rejects (transient load error).
    armBundle = () => {
      defaultBundle();
      const mathJax = (globalThis as unknown as { MathJax: { startup: { promise: Promise<unknown> } } }).MathJax;
      mathJax.startup.promise = Promise.reject(new Error('startup failed'));
    };

    const container = makeContainer(String.raw`<p>\(x\)</p>`);
    await expect(renderMath(container)).resolves.toBeUndefined();
    expect(tex2chtmlPromiseMock).not.toHaveBeenCalled();

    // The cache was dropped on failure, so a later render re-injects and now succeeds.
    armBundle = defaultBundle;
    await renderMath(container);
    expect(loadCount).toBe(2);
    expect(tex2chtmlPromiseMock).toHaveBeenCalled();
  });

  it('rejects (and resets) when the MathJax script fails to load, never throwing to the caller', async () => {
    // Simulate the asset being unreachable: the first injection fires `error` instead of `load`.
    failNextLoad = true;

    const container = makeContainer(String.raw`<p>\(x\)</p>`);
    await expect(renderMath(container)).resolves.toBeUndefined();
    expect(tex2chtmlPromiseMock).not.toHaveBeenCalled();

    // The cache was dropped on the load error, so a later render re-injects and now succeeds.
    await renderMath(container);
    expect(loadCount).toBe(2);
    expect(tex2chtmlPromiseMock).toHaveBeenCalled();
  });

  it('safely no-ops when MathJax exposes no convert helpers (engine unavailable)', async () => {
    armBundle = () => {
      (globalThis as unknown as { MathJax: Record<string, unknown> }).MathJax = {}; // no convert API
    };

    const container = makeContainer(String.raw`<p>\(x\)</p>`);
    const before = container.innerHTML;
    await expect(renderMath(container)).resolves.toBeUndefined();
    // No conversion attempted; the source delimiters remain untouched.
    expect(container.innerHTML).toBe(before);
  });

  it('does not convert text already inside a produced mjx-container', async () => {
    // A produced container whose label happens to contain delimiter-like text must be skipped on a
    // re-scan (the walker rejects text inside mjx-container), so a second pass finds nothing to do.
    const container = makeContainer(String.raw`<p>\(x\)</p>`);
    await renderMath(container);
    tex2chtmlPromiseMock.mockClear();
    await renderMath(container);
    expect(tex2chtmlPromiseMock).not.toHaveBeenCalled();
  });
});
