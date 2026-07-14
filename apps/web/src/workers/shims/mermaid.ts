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
  };
}

/**
 * The strict, deterministic configuration for the NATIVE on-screen preview render (main thread).
 *
 * Distinct from {@link buildMermaidConfig}: the browser preview can display mermaid's default
 * `<foreignObject>` HTML labels directly, so this config does NOT force `htmlLabels: false` (that
 * constraint exists only for the downstream prawn-svg PDF renderer, which cannot draw foreignObject).
 * The security-critical bits are unchanged — `securityLevel: 'strict'` keeps the diagram source inert,
 * and `deterministicIds` keeps output stable — so the preview render stays safe and reproducible.
 */
export function buildPreviewMermaidConfig(): MermaidConfig {
  return {
    startOnLoad: false,
    securityLevel: SECURITY_LEVEL,
    deterministicIds: true,
  };
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
        return succeed(svg);
      } catch (error) {
        return fail(error);
      }
    },
  };
}
