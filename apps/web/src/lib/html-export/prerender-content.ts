/**
 * @file Renders the parts of a document that the preview only completes in the browser.
 *
 * The render worker returns HTML with diagram blocks reduced to inert placeholders and stem markup
 * left as delimited text — both are finished on the main thread, against a live DOM, because mermaid
 * needs to measure text and MathJax needs to lay glyphs out. A file saved straight from the worker's
 * output would therefore contain placeholder markup where its diagrams should be and raw `\\(…\\)`
 * where its equations should be.
 *
 * So the export runs the SAME two renderers the preview runs, over a detached copy of the document,
 * and serializes the result. Reusing them rather than reimplementing is the point: a diagram in the
 * exported file is the same SVG the panel showed, not a second engine's interpretation of it.
 *
 * MathJax's CHTML output also depends on a stylesheet it injects into the page at typeset time. That
 * has to travel with the export too, or every equation arrives as unpositioned fragments.
 */

import { renderDiagrams } from '@/components/diagrams/render-diagrams';
import { renderMath } from '@/components/math/render-math';
import { EXPORT_CONTENT_CLASS } from './build-standalone-html';
import { extractDiagramSvgs } from './diagram-assets';
import type { ExportAsset } from './inline-assets';

/** The id MathJax gives the `<style>` element it injects when it first typesets CHTML output. */
const MATHJAX_STYLE_ID = 'MJX-CHTML-styles';

/** The renderers and DOM reads this step depends on, injected so the step is testable without them. */
export interface PrerenderDeps {
  /**
   * Replaces diagram placeholders with rendered SVG, in place.
   *
   * @param container - The element holding the placeholders.
   */
  readonly renderDiagrams: (container: HTMLElement) => Promise<unknown>;
  /**
   * Typesets stem markup, in place.
   *
   * @param container - The element holding the maths.
   */
  readonly renderMath: (container: HTMLElement) => Promise<void>;
  /** The stylesheet MathJax injected, or an empty string when it has not typeset anything. */
  readonly readMathStyles: () => string;
}

/**
 * What the document actually needs, alongside the injectable renderer seams.
 *
 * Both engines are heavy and lazily loaded, so a document with no diagrams and no maths should never
 * pay for either. The caller knows: the render worker reports whether it emitted diagram placeholders
 * and whether `:stem:` resolved to something in effect. Unset means "render it" — the safe default,
 * since an unnecessary pass costs time while a skipped necessary one costs content.
 */
export interface PrerenderOptions extends Partial<PrerenderDeps> {
  /** Whether the body carries diagram placeholders. `false` skips loading the diagram engines. */
  readonly diagrams?: boolean;
  /** Whether the body carries in-effect stem math. `false` skips loading MathJax. */
  readonly math?: boolean;
  /**
   * Where a rendered diagram ends up: `inline` leaves its `<svg>` in the document, `extract` writes it
   * as a file and references it. The same decision the document's images and fonts already take from
   * the packaging, so a zip carries its diagrams the way it carries everything else and a single-file
   * export keeps them embedded because it has nowhere else to put them. Defaults to `inline`.
   */
  readonly diagramPackaging?: 'inline' | 'extract';
}

const DEFAULT_DEPS: PrerenderDeps = {
  renderDiagrams: (container) => renderDiagrams(container),
  renderMath,
  readMathStyles: () => document.querySelector(`#${MATHJAX_STYLE_ID}`)?.textContent ?? '',
};

/** The finished document body, plus any stylesheet its rendered content needs. */
export interface PrerenderedContent {
  /** The body HTML with diagrams and equations rendered. */
  readonly html: string;
  /** Stylesheet text the rendered output depends on; empty when it needs none. */
  readonly extraCss: string;
  /** Files the body now references — the extracted diagrams; empty unless they were extracted. */
  readonly assets: readonly ExportAsset[];
}

/**
 * Finish a worker-rendered body the way the preview finishes it, and hand back a serializable result.
 *
 * The work happens in a container attached to the document but visually removed. It cannot be fully
 * detached: mermaid measures text and MathJax resolves font metrics, and neither can do that in a
 * fragment that has never been laid out — a detached container silently yields zero-sized diagrams
 * and mispositioned glyphs. It is hidden with `visibility` and moved off-screen rather than with
 * `display: none`, because `display: none` suppresses layout as thoroughly as being detached does.
 *
 * Failures here are deliberately not fatal: a diagram engine that cannot render one block should cost
 * that block, not the whole export.
 *
 * @param bodyHtml - The sanitized body HTML the render worker produced.
 * @param style - The export's visual style, applied so measurement happens under the real CSS.
 * @param options - What the document needs, plus injectable renderer seams; omissions use the real ones.
 * @returns The rendered body and any stylesheet it needs.
 */
export async function prerenderContent(
  bodyHtml: string,
  style: string,
  options: PrerenderOptions = {},
): Promise<PrerenderedContent> {
  const resolved: PrerenderDeps = { ...DEFAULT_DEPS, ...options };

  const container = document.createElement('div');
  container.className = EXPORT_CONTENT_CLASS;
  container.dataset.previewStyle = style;
  // Out of sight but still laid out — see the note above on why `display: none` will not do.
  container.style.cssText =
    'position:absolute;left:-99999px;top:0;width:46rem;visibility:hidden;pointer-events:none';
  container.innerHTML = bodyHtml;
  document.body.append(container);

  if (options.diagrams !== false) {
    try {
      await resolved.renderDiagrams(container);
    } catch {
      // A diagram that will not render leaves its placeholder behind; the rest of the document is fine.
    }
  }
  if (options.math !== false) {
    try {
      await resolved.renderMath(container);
    } catch {
      // Untypeset maths stays as its source delimiters, which is still readable.
    }
  }

  // After both renderers, so what gets extracted is the finished diagram, and while the container is
  // still a DOM — the alternative, re-parsing the serialized HTML to find the `<svg>`s, would put the
  // whole document through a round-trip for the sake of a handful of elements.
  const assets = options.diagramPackaging === 'extract' ? extractDiagramSvgs(container) : [];

  const html = container.innerHTML;
  container.remove();

  return { html, extraCss: resolved.readMathStyles(), assets };
}
