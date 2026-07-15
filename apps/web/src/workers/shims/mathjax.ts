// The MathJax math shim: turns one block of inert TeX/LaTeX or AsciiMath source into a
// prawn-svg-friendly, fully self-contained SVG asset for the client-side PDF export pipeline.
//
// It implements the environment-agnostic `RenderShim` port from `@asciidocollab/asciidoc-pdf`, so the
// pre-processing pipeline drives it without importing any DOM API. The actual MathJax engine call is
// isolated behind an injectable {@link MathSvgConverter} seam: the composition root wires the real
// converter, while unit tests inject an in-memory fake. Malformed source or an engine failure is
// returned as a `malformed-math` diagnostic — this shim never throws across the boundary and never
// performs network I/O.
//
// DOM-FREE by construction (Constitution VI/VIII/IX): the default converter typesets with the
// `mathjax-full` liteAdaptor — an in-memory DOM shim — so math renders INSIDE the PDF Web Worker, which
// has no `window`/`document`. No `<script>` tag, no self-hosted bundle, no CDN, no font URL, no network.
// Every glyph is embedded per expression (`svg.fontCache: 'local'`) so each produced SVG is standalone
// and the output is deterministic (identical source + params → identical bytes).
//
// Notation handling mirrors the preview renderer's TeX/AsciiMath split: the diagrams-math pipeline stage
// tags each block with its AsciiDoc notation (`latexmath`/`asciimath`/`stem`) in `params`, and this shim
// maps that to the TeX or AsciiMath input jax. Per Asciidoctor, an unqualified `stem` block defaults to
// AsciiMath.

import { liteAdaptor } from 'mathjax-full/js/adaptors/liteAdaptor.js';
import { RegisterHTMLHandler } from 'mathjax-full/js/handlers/html.js';
import { AsciiMath } from 'mathjax-full/js/input/asciimath.js';
import { TeX } from 'mathjax-full/js/input/tex.js';
import { AllPackages } from 'mathjax-full/js/input/tex/AllPackages.js';
import { mathjax } from 'mathjax-full/js/mathjax.js';
import { SVG } from 'mathjax-full/js/output/svg.js';
import mathjaxPackage from 'mathjax-full/package.json';

import type { DiagnosticCode, RenderShim, ShimAssetFormat, ShimInput, ShimKind, ShimOutput } from '@asciidocollab/asciidoc-pdf';

// ---------------------------------------------------------------------------
// Shim identity, output format, and diagnostic code (named — never bare literals).
// ---------------------------------------------------------------------------

/** This shim's family. */
const SHIM_KIND: ShimKind = 'math';

/** The concrete engine name; also the key the diagrams-math stage resolves the math shim by. */
const SHIM_NAME = 'mathjax';

/** The format this shim emits. SVG-first; the separate raster-fallback guard handles PNG downgrades. */
const OUTPUT_FORMAT: ShimAssetFormat = 'svg';

/** The diagnostic returned when the source is not renderable math. */
const MALFORMED_MATH: DiagnosticCode = 'malformed-math';

// ---------------------------------------------------------------------------
// Render params (set by the diagrams-math pipeline stage) this shim reads.
// ---------------------------------------------------------------------------

/** Render param naming the block's AsciiDoc math notation (`latexmath`/`asciimath`/`stem`). */
export const MATH_NOTATION_PARAM = 'asciidoc-block-notation';

/** Render param carrying block(display) vs inline layout: `'true'` (default) renders display math. */
export const MATH_DISPLAY_PARAM = 'asciidoc-math-display';

/** The param value that selects display layout. */
const DISPLAY_VALUE = 'true';

// ---------------------------------------------------------------------------
// Notation model — mirrors the preview renderer's `Notation` split.
// ---------------------------------------------------------------------------

/** The math input notation MathJax converts — selects the TeX vs AsciiMath input jax. */
export type MathNotation = 'tex' | 'asciimath';

/** AsciiDoc notation param values that map to a specific MathJax input jax. */
const NOTATION_BY_PARAM: Readonly<Record<string, MathNotation>> = Object.freeze({
  latexmath: 'tex',
  asciimath: 'asciimath',
});

/** Asciidoctor treats an unqualified `stem` (and any unknown notation) as AsciiMath. */
const DEFAULT_NOTATION: MathNotation = 'asciimath';

function resolveNotation(parameters: Readonly<Record<string, string>>): MathNotation {
  const raw = parameters[MATH_NOTATION_PARAM]?.toLowerCase();
  if (raw !== undefined && raw in NOTATION_BY_PARAM) {
    return NOTATION_BY_PARAM[raw];
  }
  return DEFAULT_NOTATION;
}

function resolveDisplay(parameters: Readonly<Record<string, string>>): boolean {
  const raw = parameters[MATH_DISPLAY_PARAM]?.toLowerCase();
  return raw === undefined ? true : raw === DISPLAY_VALUE;
}

// ---------------------------------------------------------------------------
// The engine seam.
// ---------------------------------------------------------------------------

/** One inert math expression to convert, with the notation and layout it should render in. */
export interface MathConversion {
  /** The raw math source, treated purely as data (delimiters already stripped by the caller). */
  readonly expression: string;
  /** Which MathJax input jax converts it. */
  readonly notation: MathNotation;
  /** True for block (display) layout, false for inline. */
  readonly display: boolean;
}

/**
 * The seam that turns one inert math expression into a standalone SVG document string. The default
 * implementation ({@link createMathJaxSvgConverter}) drives the DOM-free `mathjax-full` liteAdaptor;
 * unit tests may inject an in-memory fake so the shim contract is testable in isolation.
 */
export interface MathSvgConverter {
  /**
   * Convert one expression to a serialized `<svg>…</svg>` string. May reject on a MathJax failure.
   *
   * @param conversion - The inert math expression, its input format, and its display mode.
   * @returns The serialized standalone SVG document string.
   */
  toSvg(conversion: MathConversion): Promise<string>;
}

/** Dependencies for {@link createMathJaxShim} — the composition root injects the converter. */
export interface MathJaxShimDeps {
  /** The engine seam that produces SVG from math source. */
  readonly converter: MathSvgConverter;
}

// ---------------------------------------------------------------------------
// The default DOM-free converter (mathjax-full liteAdaptor — runs in the worker, no DOM).
// ---------------------------------------------------------------------------

/**
 * The em size (in CSS pixels) MathJax lays glyphs out against. 16 mirrors the browser default so the
 * worker's typeset SVG matches the preview renderer's metrics.
 */
const EM_SIZE = 16;

/** The ex size (x-height, in CSS pixels) paired with {@link EM_SIZE} for consistent glyph metrics. */
const EX_SIZE = 8;

/** The container width (in CSS pixels) used when laying out display math; the standalone SVG is sized to content. */
const CONTAINER_WIDTH = 80 * EM_SIZE;

/**
 * The shared liteAdaptor: an in-memory DOM the html handler drives so MathJax never touches a real
 * `document`. It is stateless for our use (serialization only), so a single instance is safe to reuse,
 * and the html handler must be registered against it exactly once for the whole module.
 */
const adaptor = liteAdaptor();
RegisterHTMLHandler(adaptor);

/**
 * Build the DOM-free converter. Each conversion gets a FRESH input jax, output jax, and document so the
 * SVG output's per-document `local` font-cache counter always starts from the same value — that is what
 * makes identical source + params yield byte-identical SVG (deterministic export). `svg.fontCache:
 * 'local'` embeds every glyph as a `<defs>` path inside the produced SVG, so each asset is self-contained.
 */
export function createMathJaxSvgConverter(): MathSvgConverter {
  return {
    toSvg({ expression, notation, display }: MathConversion): Promise<string> {
      const inputJax =
        notation === 'asciimath' ? new AsciiMath({}) : new TeX({ packages: AllPackages });
      const outputJax = new SVG({ fontCache: 'local' });
      const document = mathjax.document('', { InputJax: inputJax, OutputJax: outputJax });

      const node = document.convert(expression, {
        display,
        em: EM_SIZE,
        ex: EX_SIZE,
        containerWidth: CONTAINER_WIDTH,
      });

      const svg = adaptor.tags(node, 'svg')[0];
      if (svg === undefined) {
        throw new Error('MathJax produced no SVG element for the expression.');
      }
      return Promise.resolve(adaptor.outerHTML(svg));
    },
  };
}

// ---------------------------------------------------------------------------
// The shim.
// ---------------------------------------------------------------------------

/**
 * Points per `ex` used to size the rendered math for the PDF. MathJax emits the root `<svg>`
 * width/height in `ex` (relative to the surrounding font size). In a browser those `ex` resolve against
 * the parent's font, so math matches the text; but a standalone SVG embedded by prawn-svg has NO
 * font-size context, so prawn-svg resolves `ex` against its own (large) default and renders math at
 * roughly TWICE the body-text size — display equations look bloated and inline math towers over the
 * line. Converting the root dimensions to absolute `pt` at this scale makes math track Asciidoctor-PDF's
 * default ~10.5pt body font (empirically 1ex ≈ 4.5pt), for both inline and display math. It is tuned to
 * the default theme's base font size; a project with a very different base size would want it scaled.
 */
const POINTS_PER_EX = 4.5;

// Matches the root `<svg>`'s `ex`-based width/height (MathJax emits them adjacent, width then height).
// The scanned input is our own MathJax-produced SVG (bounded), never an attacker-controlled stream, so
// the lazy `[^>]*?` before the dimensions cannot be driven into pathological backtracking here.
// eslint-disable-next-line redos/no-vulnerable -- bounded MathJax-produced input, see note above.
const ROOT_SVG_EX_SIZE_RE = /(<svg\b[^>]*?)\swidth="([\d.]+)ex"\s+height="([\d.]+)ex"/;

/**
 * Rewrite the root `<svg>`'s `ex`-based width/height to absolute `pt` so prawn-svg renders the math at
 * body-text size instead of roughly double it. The `ex`-based `vertical-align` (baseline offset) and the
 * inner geometry stay untouched, since the viewBox scales the glyphs to fit the new box. It is a no-op
 * when the root carries no `ex` dimensions (for example a test fake), so the shim stays engine-agnostic.
 *
 * @param svg - The serialized MathJax SVG document.
 * @returns The SVG with its root dimensions expressed in points.
 */
function sizeMathSvgToPoints(svg: string): string {
  return svg.replace(ROOT_SVG_EX_SIZE_RE, (_match, prefix: string, widthEx: string, heightEx: string) => {
    const width = (Number(widthEx) * POINTS_PER_EX).toFixed(2);
    const height = (Number(heightEx) * POINTS_PER_EX).toFixed(2);
    return `${prefix} width="${width}pt" height="${height}pt"`;
  });
}

function malformed(message: string): ShimOutput {
  return { ok: false, diagnostic: { code: MALFORMED_MATH, message } };
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

async function renderMath(converter: MathSvgConverter, input: ShimInput): Promise<ShimOutput> {
  const expression = input.source.trim();
  if (expression.length === 0) {
    return malformed('Empty math source.');
  }
  try {
    const rendered = await converter.toSvg({
      expression,
      notation: resolveNotation(input.params),
      display: resolveDisplay(input.params),
    });
    const svg = rendered.trim();
    if (svg.length === 0) {
      return malformed('MathJax produced no SVG output for the expression.');
    }
    // Size the root SVG in absolute points so prawn-svg renders math at body-text scale (not ~2x).
    const sized = sizeMathSvgToPoints(svg);
    return {
      ok: true,
      asset: { format: OUTPUT_FORMAT, bytes: new TextEncoder().encode(sized), rasterFallback: false },
    };
  } catch (error) {
    return malformed(messageOf(error));
  }
}

/**
 * Build the MathJax math {@link RenderShim}. With no arguments it uses the DOM-free `mathjax-full`
 * converter (SVG output, local font cache), which typesets inside the PDF Web Worker; tests may inject
 * an in-memory converter to exercise the contract in isolation.
 */
export function createMathJaxShim(dependencies?: MathJaxShimDeps): RenderShim {
  const converter = dependencies?.converter ?? createMathJaxSvgConverter();
  return {
    kind: SHIM_KIND,
    name: SHIM_NAME,
    version: mathjaxPackage.version,
    render: (input) => renderMath(converter, input),
  };
}
