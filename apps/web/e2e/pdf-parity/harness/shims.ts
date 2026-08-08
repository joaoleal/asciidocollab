/**
 * Builds the real rendering shims for the parity harness. The citations, Graphviz and Vega shims run
 * natively in Node (no DOM), so they are used exactly as production composes them. Mermaid and MathJax
 * need a browser: their shims take an injected renderer/converter seam (designed for precisely this),
 * so the harness supplies a Playwright-page-backed seam that drives the real mermaid / MathJax engines
 * in a real browser and returns the SVG — the shim wrapper logic itself is unchanged.
 */

import type { Page } from '@playwright/test';
import type { MermaidConfig } from 'mermaid';
import type { RenderShim } from '@asciidocollab/asciidoc-pdf';
import { createCitationJsShim } from '../../../src/workers/shims/citation-js';
import { createGraphvizShim } from '../../../src/workers/shims/graphviz';
import { createVegaShim } from '../../../src/workers/shims/vega';
import { createMermaidShim, type MermaidRenderer } from '../../../src/workers/shims/mermaid';
import { createMathJaxShim, type MathSvgConverter } from '../../../src/workers/shims/mathjax';

/** The shims that run headlessly in Node — all this fixture family needs for citations/code. */
export function nodeShims(): RenderShim[] {
  return [createCitationJsShim(), createGraphvizShim(), createVegaShim()];
}

/** Locations of the self-hosted engine bundles used to drive the browser shims in-page. */
export interface BrowserEngineBundles {
  /** Absolute path to the single-file mermaid UMD bundle (loaded inline via addScriptTag). */
  readonly mermaidBundlePath: string;
  /** Loopback base URL serving the MathJax bundle dir, so its AsciiMath component loads offline. */
  readonly mathjaxBaseUrl: string;
  /**
   * Loopback base URL serving `node_modules/@mathjax`, so the font component resolves offline.
   *
   * MathJax 4 moved the fonts into their own package and defaults `loader.paths.fonts` to
   * `https://cdn.jsdelivr.net/npm/@mathjax`. Without this the harness would silently render against a
   * CDN-fetched font — or hang when the network is unavailable.
   */
  readonly mathjaxFontsBaseUrl: string;
}

/** A mermaid renderer that runs the real mermaid engine inside a Playwright page. */
function pageMermaidRenderer(page: Page, mermaidBundlePath: string): MermaidRenderer {
  return async (config, source) => {
    await page.setContent('<!doctype html><html><head></head><body></body></html>');
    await page.addScriptTag({ path: mermaidBundlePath });
    return page.evaluate(
      async (payload: { cfg: MermaidConfig; src: string }) => {
        // The single interop crossing into the browser-injected, untyped mermaid engine global.
        const engine = (globalThis as unknown as { mermaid: {
          initialize(c: unknown): void;
          render(id: string, s: string): Promise<{ svg: string }>;
        } }).mermaid;
        engine.initialize({ ...payload.cfg, startOnLoad: false });
        const { svg } = await engine.render('parity-mermaid', payload.src);
        return svg;
      },
      { cfg: config, src: source },
    );
  };
}

/** A MathJax SVG converter that runs the real MathJax engine inside a Playwright page. */
function pageMathConverter(page: Page, mathjaxBaseUrl: string, mathjaxFontsBaseUrl: string): MathSvgConverter {
  return {
    async toSvg({ expression, notation, display }) {
      // Configure MathJax (SVG output, local font cache, AsciiMath input jax) and load the bundle from
      // the served origin so component loading resolves offline; then convert in-page.
      const html =
        '<!doctype html><html><head>' +
        `<script>window.MathJax={loader:{load:['input/asciimath'],` +
        `paths:{mathjax:'${mathjaxBaseUrl}',fonts:'${mathjaxFontsBaseUrl}'}},` +
        "startup:{typeset:false},svg:{fontCache:'local'}," +
        // Match render-math's production config, so parity is measured against the engine that ships
        // rather than a differently-configured one.
        //
        // It has to be `menuOptions.settings`: the document-level `enableEnrichment` / `enableSpeech`
        // flags are silently ineffective in MathJax 4's browser bundle (measured — enrichment still ran
        // and inserted invisible-times operators, which is what broke the worker/browser parity guard).
        // Enrichment must be off here because the DOM-free PDF worker has no speech-rule engine, so
        // leaving it on compares an enriched reference against unenriched production output.
        "options:{menuOptions:{settings:{enrich:false,speech:false,braille:false}}}};</script>" +
        `<script src="${mathjaxBaseUrl}/tex-mml-svg.js"></script>` +
        '</head><body></body></html>';
      await page.setContent(html, { waitUntil: 'load' });
      await page.waitForFunction(() => {
        const mj = (globalThis as unknown as { MathJax?: { startup?: { promise?: Promise<unknown> } } }).MathJax;
        return mj?.startup?.promise !== undefined;
      });
      return page.evaluate(
        async (payload: { expr: string; asciimath: boolean; display: boolean }) => {
          // The single interop crossing into the browser-injected, untyped MathJax engine global.
          const mj = (globalThis as unknown as {
            MathJax: {
              startup: { promise: Promise<unknown> };
              tex2svgPromise(expression: string, options: { display: boolean }): Promise<Element>;
              asciimath2svgPromise(expression: string, options: { display: boolean }): Promise<Element>;
            };
          }).MathJax;
          await mj.startup.promise;
          const convert = payload.asciimath ? mj.asciimath2svgPromise : mj.tex2svgPromise;
          const container = await convert.call(mj, payload.expr, { display: payload.display });
          const svg = container.querySelector('svg');
          if (svg === null) {
            throw new Error('MathJax produced no SVG element');
          }
          return new XMLSerializer().serializeToString(svg);
        },
        { expr: expression, asciimath: notation === 'asciimath', display },
      );
    },
  };
}

/** The full shim set including the browser-backed mermaid + MathJax, for the diagram/math fixtures. */
export function browserShims(page: Page, bundles: BrowserEngineBundles): RenderShim[] {
  return [
    createGraphvizShim(),
    createVegaShim(),
    createMermaidShim(pageMermaidRenderer(page, bundles.mermaidBundlePath)),
    createMathJaxShim({
      converter: pageMathConverter(page, bundles.mathjaxBaseUrl, bundles.mathjaxFontsBaseUrl),
    }),
  ];
}
