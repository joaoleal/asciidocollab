/**
 * Browser/worker shim that turns a mermaid diagram source into a prawn-svg-friendly SVG asset.
 *
 * The diagram source is treated as INERT DATA: mermaid runs in its most restrictive mode
 * (`securityLevel: 'strict'`) and is forced to emit real `<text>` labels instead of
 * `<foreignObject>` HTML (`htmlLabels: false`, plus the legacy per-diagram `flowchart.htmlLabels`),
 * because the downstream Ruby PDF renderer (prawn-svg) cannot draw `<foreignObject>`.
 *
 * The actual mermaid call sits behind the {@link MermaidRenderer} seam so the contract and the
 * security configuration are unit-testable without a real DOM; the default renderer is only
 * exercisable in a real browser/worker (verified by e2e).
 */

import type { MermaidConfig } from 'mermaid';

import type {
  DiagnosticCode,
  RenderShim,
  ShimAssetFormat,
  ShimInput,
  ShimKind,
  ShimOutput,
} from '@asciidocollab/asciidoc-pdf';

import { flattenMermaidLabelTspans } from './mermaid-svg';

const DIAGRAM_KIND: ShimKind = 'diagram';
const SVG_FORMAT: ShimAssetFormat = 'svg';
const MALFORMED_CODE: DiagnosticCode = 'malformed-diagram';

const ENGINE_NAME = 'mermaid';
const ENGINE_VERSION = '11.16.0';

/** The container id mermaid renders into; fixed (with deterministic ids) so output stays stable. */
const RENDER_TARGET_ID = 'adc-mermaid-render';

const SECURITY_LEVEL: NonNullable<MermaidConfig['securityLevel']> = 'strict';

/**
 * The seam over the real (DOM-bound) mermaid engine: apply {@link MermaidConfig} and render one
 * source string to an SVG string. Unit tests inject a fake; the default drives real mermaid.
 */
export type MermaidRenderer = (config: MermaidConfig, source: string) => Promise<string>;

/** The strict, foreignObject-free, deterministic configuration applied to every render. */
function buildMermaidConfig(): MermaidConfig {
  return {
    startOnLoad: false,
    securityLevel: SECURITY_LEVEL,
    deterministicIds: true,
    htmlLabels: false,
    flowchart: { htmlLabels: false },
    // On a parse error mermaid otherwise draws its "Syntax error" bomb graphic into a throwaway element
    // it appends to the document and leaves behind. Suppress it so a malformed diagram throws cleanly
    // (the shim/caller then fails soft) and no bomb is ever injected or embedded.
    suppressErrorRendering: true,
  };
}

/**
 * The strict, deterministic configuration for the NATIVE on-screen preview render (main thread).
 *
 * Identical to {@link buildMermaidConfig}: although a browser CAN paint mermaid's default
 * `<foreignObject>` HTML labels, the rendered preview SVG is passed through the svg-profile DOMPurify
 * sanitizer, which strips `<foreignObject>` and its HTML children — leaving shapes with empty labels.
 * Forcing native `<text>` labels (`htmlLabels: false`) makes the labels survive that sanitize, exactly
 * as the downstream prawn-svg PDF path requires. Error suppression and the security-critical bits
 * (`securityLevel: 'strict'`, `deterministicIds`) are shared too, so the preview stays safe, labelled,
 * and reproducible. Kept as a named seam for the preview call site and its tests.
 */
export function buildPreviewMermaidConfig(): MermaidConfig {
  return buildMermaidConfig();
}

/** Drives the real mermaid engine; only runnable in a browser/worker (DOM-dependent). */
const defaultMermaidRenderer: MermaidRenderer = async (config, source) => {
  const mermaidModule = await import('mermaid');
  const mermaid = mermaidModule.default;
  mermaid.initialize(config);
  const { svg } = await mermaid.render(RENDER_TARGET_ID, source);
  return svg;
};

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function succeed(svg: string): ShimOutput {
  return {
    ok: true,
    asset: { format: SVG_FORMAT, bytes: new TextEncoder().encode(svg), rasterFallback: false },
  };
}

function fail(error: unknown): ShimOutput {
  return { ok: false, diagnostic: { code: MALFORMED_CODE, message: messageOf(error) } };
}

/** Build a mermaid {@link RenderShim}, optionally over an injected renderer seam (for tests). */
export function createMermaidShim(renderer: MermaidRenderer = defaultMermaidRenderer): RenderShim {
  return {
    kind: DIAGRAM_KIND,
    name: ENGINE_NAME,
    version: ENGINE_VERSION,
    async render(input: ShimInput): Promise<ShimOutput> {
      try {
        const svg = await renderer(buildMermaidConfig(), input.source);
        // Flatten mermaid's nested per-word label tspans so prawn-svg lays the text out correctly in the
        // exported PDF (this is the PDF render path; the on-screen preview uses mermaid's output as-is).
        return succeed(flattenMermaidLabelTspans(svg));
      } catch (error) {
        return fail(error);
      }
    },
  };
}
