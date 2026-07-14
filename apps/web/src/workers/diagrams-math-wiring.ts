/**
 * @file Testable wiring for the worker's diagram/math pre-processing.
 *
 * The PDF Web Worker entry uses two composition helpers to run the `diagrams-math` stage. One builds the
 * diagram/math rendering shims the pipeline resolves those blocks through; the other pre-seeds assets the
 * main thread already rendered into the content-addressed cache. They live here — not inline in the worker
 * entry — because a `*.worker.ts` module runs in worker-global scope and the jest runtime cannot load it,
 * so extracting the composition keeps it unit-testable with injected engine seams. The citation shim stays
 * composed in the worker entry because its `@citation-js/core` dependency is ESM the jest runtime cannot
 * parse.
 */

import type { AssetCachePort, GeneratedAsset, RenderShim } from '@asciidocollab/asciidoc-pdf';
import { createGraphvizShim, type GraphvizRenderer } from './shims/graphviz';
import { createMathJaxShim, type MathSvgConverter } from './shims/mathjax';
import { createMermaidShim, type MermaidRenderer } from './shims/mermaid';
import { createVegaShim, type VegaEngine } from './shims/vega';

/**
 * Engine seams a caller may substitute for the browser/WASM-bound diagram engines. The worker leaves
 * them unset (every shim drives its real engine); unit tests inject in-memory fakes so the wiring is
 * exercisable without loading WebAssembly or a DOM.
 */
export interface PdfRenderShimSeams {
  /** Replaces the WASM Graphviz engine. */
  readonly graphvizRenderer?: GraphvizRenderer;
  /** Replaces the Vega/Vega-Lite engine. */
  readonly vegaEngine?: VegaEngine;
  /** Replaces the DOM-bound mermaid engine (never invoked in the worker for pre-seeded blocks). */
  readonly mermaidRenderer?: MermaidRenderer;
  /** Replaces the MathJax SVG converter. */
  readonly mathConverter?: MathSvgConverter;
}

/**
 * The diagram/math shim set the worker's `diagrams-math` stage renders through. The graphviz/vega diagram
 * engines and MathJax all render headlessly in-worker (no DOM). The mermaid shim is included so its blocks
 * resolve, but the main-thread pre-pass pre-seeds mermaid assets (see {@link seedGeneratedAssets}) so the
 * DOM-bound mermaid engine is never actually invoked here.
 *
 * @param seams - Optional engine substitutions; every unset seam uses its real engine.
 * @returns The diagram/math shims to register for the pipeline.
 */
export function createDiagramsMathShims(seams: PdfRenderShimSeams = {}): RenderShim[] {
  return [
    createGraphvizShim(seams.graphvizRenderer),
    createVegaShim(seams.vegaEngine),
    createMermaidShim(seams.mermaidRenderer),
    createMathJaxShim(seams.mathConverter === undefined ? undefined : { converter: seams.mathConverter }),
  ];
}

/**
 * Pre-seed assets already rendered on the main thread (such as mermaid diagrams the worker's DOM-bound
 * shim cannot produce headlessly) into the content-addressed cache before the diagrams-math stage runs,
 * so each matching block resolves as a cache hit and its shim is never invoked in the worker. Idempotent
 * and order-independent — the cache is keyed by {@link GeneratedAsset.sourceHash}.
 *
 * @param cache - The content-addressed generated-asset cache.
 * @param assets - The pre-rendered assets to seed; absent when a request carries none.
 */
export function seedGeneratedAssets(
  cache: AssetCachePort,
  assets: readonly GeneratedAsset[] = [],
): void {
  for (const asset of assets) {
    cache.set(asset);
  }
}
