// Client-side native rendering for the AsciiDoc preview's diagram blocks.
//
// The render worker emits one INERT placeholder per native diagram block and never draws the diagram
// itself:
//   <div class="adc-diagram" data-diagram-engine="mermaid|graphviz|vega|vegalite"
//        data-source-line="N">…escaped source text…</div>
// The shared `html`-profile preview sanitizer keeps that placeholder (plain `div`/`class`/`data-*` +
// escaped text). This module runs on the main thread AFTER sanitize: it locates each placeholder,
// reads the engine + the inert source, drives that engine's native on-screen renderer to an SVG
// string, sanitizes the SVG through a SEPARATE svg-profile DOMPurify pass (never the shared
// `html`-profile call), and injects it into the placeholder idempotently.
//
// Constraints mirrored from render-math:
// - Zero source/URL egress: the diagram source is inert DATA — never executed, never sent anywhere.
//   A spec that references a remote data url is SKIPPED WITH A WARNING (no fetch), not loaded. The
//   Vega engine seam also carries a remote-blocking loader as defence in depth.
// - Scoped: we only ever walk/replace inside the passed container.
// - Fail-soft: a malformed/unsupported diagram becomes a warning; the others still render, and this
//   function never throws.
// - Incremental: the inert source is kept (as a hidden child) alongside the drawing, so a placeholder
//   that is already drawn is left exactly as it is — the same node, no second engine run — and only
//   the ones the preview's DOM patch put back to bare source are drawn again.
// - Injectable engine seams: the real mermaid/vega/graphviz renderers are DOM/WASM-bound and hard to
//   drive deterministically under jsdom, so they sit behind a `deps` seam; the default wires the real
//   engines (only exercisable in a real browser/worker, verified by e2e).

import DOMPurify from 'dompurify';

import { buildPreviewMermaidConfig } from '@/workers/shims/mermaid';
import { createVegaShim } from '@/workers/shims/vega';
import { createGraphvizShim } from '@/workers/shims/graphviz';
import type { RenderShim } from '@asciidocollab/asciidoc-pdf';

/** The worker-emitted placeholder element for a native diagram block. */
export const PLACEHOLDER_CLASS = 'adc-diagram';
/** Hidden child holding the inert source verbatim, so a re-render re-derives from it (idempotent). */
export const SOURCE_CLASS = 'adc-diagram-source';
/** Child holding the sanitized, rendered SVG — its presence is what marks a placeholder as drawn. */
export const OUTPUT_CLASS = 'adc-diagram-output';
/**
 * Attribute recording that a placeholder holds NO drawing, and why (a {@link DiagramWarningCode}).
 *
 * "Its source has not changed" and "it was successfully drawn" are different conditions, and a reader
 * of the DOM alone cannot tell them apart: a placeholder that failed still carries exactly the source
 * it was asked to draw. Anything that decides whether to leave a diagram alone across a refresh — the
 * preview's DOM patcher above all — needs the difference stated explicitly, or a diagram that failed
 * once would be frozen on screen forever: its source would go on matching, so it would go on being
 * left alone, and it would never be offered to the renderer again.
 */
export const FAILED_ATTRIBUTE = 'data-diagram-failed';

/** The worker-emitted placeholder for a native diagram block. */
const PLACEHOLDER_SELECTOR = `.${PLACEHOLDER_CLASS}`;

/** Why a single diagram could not be rendered natively; every code is non-fatal (skip + warn). */
export type DiagramWarningCode = 'remote-resource-blocked' | 'render-failed' | 'unsupported-engine';

/** A per-diagram non-fatal warning surfaced to the caller (the render itself never aborts). */
export interface DiagramWarning {
  /** The `data-diagram-engine` value of the offending placeholder. */
  engine: string;
  /** The block's 1-based source line (`data-source-line`), or null when absent/unparseable. */
  sourceLine: number | null;
  /** The reason the diagram was skipped. */
  code: DiagramWarningCode;
  /** A human-readable explanation (stays in the browser — never sent anywhere). */
  message: string;
}

/** The outcome of one render-diagrams pass over a container. */
export interface RenderDiagramsResult {
  /** How many diagrams produced an injected SVG this pass. */
  rendered: number;
  /**
   * How many were left exactly as they were because they already held a drawing of their current
   * source. Every one of these is an engine run that did not have to happen, and a node on screen
   * that kept its identity.
   */
  preserved: number;
  /** Non-fatal per-diagram warnings (unsupported engine, remote resource, render failure). */
  warnings: DiagramWarning[];
}

/** A native on-screen renderer for one engine: inert source string → SVG markup string. */
export type DiagramRenderer = (source: string) => Promise<string>;

/**
 * The injectable engine seams. Each renderer turns an inert source string into an SVG string; the
 * SVG sanitizer strips anything the svg profile does not allow. Tests inject fakes; the default wires
 * the real engines and the svg-profile DOMPurify pass.
 */
export interface DiagramRenderDeps {
  /** Renders a mermaid diagram source to SVG (native preview config: strict, deterministic). */
  renderMermaid: DiagramRenderer;
  /** Renders a Vega / Vega-Lite spec to SVG with remote/file data loading blocked. */
  renderVega: DiagramRenderer;
  /** Renders a Graphviz DOT source to SVG via the WASM engine. */
  renderGraphviz: DiagramRenderer;
  /**
   * Sanitizes rendered SVG markup through a SEPARATE svg-profile pass (not the shared html one).
   *
   * @param svg - The rendered SVG markup to sanitize.
   * @returns The sanitized SVG markup.
   */
  sanitizeSvg: (svg: string) => string;
}

/** Decode a shim's SVG asset bytes back to a string, rejecting a non-SVG or failed output. */
async function svgFromShim(shim: RenderShim, source: string): Promise<string> {
  const output = await shim.render({ source, params: {}, preferredFormat: 'svg' });
  if (!output.ok) throw new Error(output.diagnostic.message);
  if (output.asset.format !== 'svg') throw new Error('diagram engine did not produce SVG output');
  return new TextDecoder().decode(output.asset.bytes);
}

/** Fixed base id mermaid renders into; a per-call suffix keeps ids unique/deterministic within a pass. */
const MERMAID_RENDER_ID = 'adc-diagram-mermaid-render';
let mermaidRenderSequence = 0;

/** Drives the real mermaid engine with the native preview config; only runnable in a browser/worker. */
const defaultRenderMermaid: DiagramRenderer = async (source) => {
  const mermaidModule = await import('mermaid');
  const mermaid = mermaidModule.default;
  mermaid.initialize(buildPreviewMermaidConfig());
  mermaidRenderSequence += 1;
  const { svg } = await mermaid.render(`${MERMAID_RENDER_ID}-${mermaidRenderSequence}`, source);
  return svg;
};

/** Drives the real Vega engine (via its remote-blocking shim); only runnable in a browser/worker. */
const defaultRenderVega: DiagramRenderer = (source) => svgFromShim(createVegaShim(), source);

/** Drives the real Graphviz WASM engine (via its shim); only runnable in a browser/worker. */
const defaultRenderGraphviz: DiagramRenderer = (source) => svgFromShim(createGraphvizShim(), source);

/**
 * Sanitize rendered SVG markup with a SEPARATE svg-profile DOMPurify pass. This is deliberately its
 * own call, distinct from the shared `html`-profile sanitizer in the preview hook — that one is not
 * touched, weakened, or widened here. The svg + svgFilters profiles keep vector markup while dropping
 * scripts, event handlers, and any HTML the engines should never emit.
 */
function defaultSanitizeSvg(svg: string): string {
  return DOMPurify.sanitize(svg, { USE_PROFILES: { svg: true, svgFilters: true } });
}

const DEFAULT_DEPS: DiagramRenderDeps = {
  renderMermaid: defaultRenderMermaid,
  renderVega: defaultRenderVega,
  renderGraphviz: defaultRenderGraphviz,
  sanitizeSvg: defaultSanitizeSvg,
};

/** The renderer for a normalized `data-diagram-engine` value, or null when the engine is unsupported. */
function rendererForEngine(engine: string, deps: DiagramRenderDeps): DiagramRenderer | null {
  switch (engine) {
    case 'mermaid': {
      return deps.renderMermaid;
    }
    case 'graphviz': {
      return deps.renderGraphviz;
    }
    case 'vega':
    case 'vegalite': {
      return deps.renderVega;
    }
    default: {
      return null;
    }
  }
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * Whether a URL string points at a remote (network) resource. Protocol-relative (`//host`) and any
 * `scheme://` URL count as remote; inline `data:` URIs do not (they carry no network reference).
 */
function isRemoteUrl(url: string): boolean {
  const trimmed = url.trim();
  if (/^data:/i.test(trimmed)) return false;
  return /^[a-z][a-z0-9+.-]*:\/\//i.test(trimmed) || trimmed.startsWith('//');
}

/**
 * Find the first remote `url` reference anywhere in a parsed Vega/Vega-Lite spec (`data.url`, image
 * mark `url`, tile `url`, …). Only the `url` key — the data-loading vector — is inspected, so a label
 * or tooltip that merely contains a URL string is not mistaken for a remote fetch.
 */
function findRemoteUrl(value: unknown): string | null {
  if (Array.isArray(value)) {
    for (const item of value) {
      const found = findRemoteUrl(item);
      if (found) return found;
    }
    return null;
  }
  if (isPlainObject(value)) {
    const url = value.url;
    if (typeof url === 'string' && isRemoteUrl(url)) return url;
    for (const nested of Object.values(value)) {
      const found = findRemoteUrl(nested);
      if (found) return found;
    }
  }
  return null;
}

/**
 * The remote resource a diagram references, or null when it is fully self-contained. Only Vega /
 * Vega-Lite specs can drive a data fetch, so only those are inspected (parsed as JSON — inert data,
 * never evaluated). Mermaid and Graphviz do not perform network I/O in their configured modes. A spec
 * that is not valid JSON is left for the engine to reject (a render-failed warning), not treated as
 * remote.
 */
function remoteResourceOf(engine: string, source: string): string | null {
  if (engine !== 'vega' && engine !== 'vegalite') return null;
  let spec: unknown;
  try {
    spec = JSON.parse(source);
  } catch {
    return null;
  }
  return findRemoteUrl(spec);
}

/**
 * Whether a placeholder already holds a drawing of the source it is currently showing.
 *
 * A drawn placeholder keeps the engine's output AND the inert source it was produced from, and the
 * two can never drift apart: the only thing that puts a drawn placeholder back to bare source is the
 * preview's DOM patch, and it does that precisely when the source changed. So a placeholder that
 * still has its drawing is a placeholder whose drawing is still current, and running the engine over
 * it again would spend the same seconds to arrive at the same picture — while discarding the node the
 * reader is looking at.
 *
 * A placeholder recorded as having FAILED holds no drawing however intact its source looks, so it is
 * offered to the engine again: without that, one transient failure would be frozen on screen for the
 * rest of the session.
 *
 * @param placeholder - The placeholder to inspect.
 * @returns True when there is nothing left to draw.
 */
function alreadyDrawn(placeholder: HTMLElement): boolean {
  if (placeholder.hasAttribute(FAILED_ATTRIBUTE)) return false;
  return placeholder.querySelector(`.${OUTPUT_CLASS}`) !== null;
}

/** Read the inert source for a placeholder — from the preserved hidden child, or (first pass) its text. */
function readSource(placeholder: HTMLElement): string {
  const preserved = placeholder.querySelector(`.${SOURCE_CLASS}`);
  if (preserved) return preserved.textContent ?? '';
  return placeholder.textContent ?? '';
}

/**
 * Reset a placeholder to show only its inert source and record why it holds no drawing (so state
 * stays consistent, and so a later pass can tell "not drawn" from "drawn and still current" — see
 * {@link FAILED_ATTRIBUTE}).
 */
function showSourceOnly(placeholder: HTMLElement, source: string, code: DiagramWarningCode): void {
  placeholder.textContent = source;
  placeholder.setAttribute(FAILED_ATTRIBUTE, code);
}

/**
 * Replace a placeholder's content with the sanitized SVG plus the preserved inert source. Rebuilding
 * from scratch each pass is what makes re-render idempotent — a prior SVG/source is discarded, never
 * nested.
 */
function injectRendered(placeholder: HTMLElement, source: string, sanitizedSvg: string): void {
  placeholder.textContent = '';
  // A drawing is here now, so any earlier record of a failure is stale and must not outlive it.
  placeholder.removeAttribute(FAILED_ATTRIBUTE);

  const preserved = placeholder.ownerDocument.createElement('div');
  preserved.className = SOURCE_CLASS;
  preserved.hidden = true;
  preserved.textContent = source;

  const output = placeholder.ownerDocument.createElement('div');
  output.className = OUTPUT_CLASS;
  output.innerHTML = sanitizedSvg;

  placeholder.append(preserved, output);
}

function sourceLineOf(placeholder: HTMLElement): number | null {
  const raw = placeholder.dataset.sourceLine;
  if (raw === undefined) return null;
  const parsed = Number.parseInt(raw, 10);
  return Number.isNaN(parsed) ? null : parsed;
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * Draw every `.adc-diagram` placeholder inside a container that is not drawn already, in place.
 * Entirely client-side: no diagram source or URL ever leaves the browser. Fail-soft (a bad diagram
 * becomes a warning, never a throw) and remote-safe (a spec referencing a remote data url is skipped
 * with a warning, never fetched).
 *
 * Incremental rather than merely idempotent: a placeholder that already holds a drawing of its
 * current source is left untouched, so running this after a refresh costs one engine run per diagram
 * the author actually changed instead of one per diagram in the document. See {@link alreadyDrawn}.
 *
 * @param container - The scoped preview element holding the already-sanitized placeholders.
 * @param deps - Optional injectable engine/sanitize seams; omitted entries fall back to the real ones.
 * @returns How many diagrams were drawn, how many were left alone, and any non-fatal warnings.
 */
export async function renderDiagrams(
  container: HTMLElement,
  deps: Partial<DiagramRenderDeps> = {},
): Promise<RenderDiagramsResult> {
  const resolved: DiagramRenderDeps = { ...DEFAULT_DEPS, ...deps };
  const warnings: DiagramWarning[] = [];
  let rendered = 0;
  let preserved = 0;

  const placeholders = container.querySelectorAll<HTMLElement>(PLACEHOLDER_SELECTOR);
  for (const placeholder of placeholders) {
    if (alreadyDrawn(placeholder)) {
      preserved += 1;
      continue;
    }
    const engine = placeholder.dataset.diagramEngine ?? '';
    const sourceLine = sourceLineOf(placeholder);
    const source = readSource(placeholder);

    const renderer = rendererForEngine(engine, resolved);
    if (!renderer) {
      showSourceOnly(placeholder, source, 'unsupported-engine');
      warnings.push({ engine, sourceLine, code: 'unsupported-engine', message: `unsupported diagram engine: ${engine}` });
      continue;
    }

    const remote = remoteResourceOf(engine, source);
    if (remote !== null) {
      // Do NOT fetch — skip with a warning so no source or URL leaves the client.
      showSourceOnly(placeholder, source, 'remote-resource-blocked');
      warnings.push({ engine, sourceLine, code: 'remote-resource-blocked', message: `remote data reference blocked: ${remote}` });
      continue;
    }

    try {
      const svg = await renderer(source);
      injectRendered(placeholder, source, resolved.sanitizeSvg(svg));
      rendered += 1;
    } catch (error) {
      // Fail-soft: a malformed/unsupported diagram must never break the preview — the others render.
      showSourceOnly(placeholder, source, 'render-failed');
      warnings.push({ engine, sourceLine, code: 'render-failed', message: messageOf(error) });
    }
  }

  return { rendered, preserved, warnings };
}
