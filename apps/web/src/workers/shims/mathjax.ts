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

/**
 * MathJax tags its root glyph group with `stroke="currentColor"` alongside `stroke-width="0"`: it draws
 * every glyph, fraction bar, and radical rule as a FILLED path, and the zero width declares "never
 * stroke". The prawn-svg renderer, however, decides fill-vs-`fill_and_stroke` purely on whether the
 * stroke paint is `none` — a non-`none` stroke makes it stroke every glyph with a zero-width line, which
 * PDF renders as a 1-device-pixel hairline in the glyph's own colour. That hairline thickens each glyph,
 * so the exported equation looks bold/heavy next to the body text (and unlike the on-screen preview,
 * where the browser honours `stroke-width="0"`). Rewriting the root's stroke paint to `none` makes
 * prawn-svg fill the glyphs only — matching MathJax's intent.
 *
 * BUT enclosure/strike notations (`\boxed`, `\fbox`, `\cancel`, `menclose`) draw a `<rect>`/`<line>` with
 * a NON-zero `stroke-width` and NO stroke attribute of their own — they rely on inheriting the root's
 * paint. Neutralising the root alone would make those inherit `stroke="none"` and vanish. So after
 * neutralising the root, {@link restoreNonZeroStrokes} re-adds an explicit `stroke="currentColor"` on
 * every element that carries a non-zero stroke width, keeping real strokes drawn while the zero-width
 * glyphs stay fill-only.
 */
const GLYPH_STROKE_PAINT = 'stroke="currentColor"';

/** The neutralised stroke paint that makes prawn-svg fill glyphs without a hairline outline. */
const NO_STROKE_PAINT = 'stroke="none"';

/**
 * Rewrite MathJax's root `stroke="currentColor"` to `stroke="none"` so prawn-svg fills the glyphs without
 * adding a zero-width hairline outline (see {@link GLYPH_STROKE_PAINT}). MathJax emits this paint exactly
 * once (on the root group), so a blanket replace only touches the root; enclosure/strike strokes are
 * re-added afterwards by {@link restoreNonZeroStrokes}. A no-op for a fake SVG that carries no such stroke.
 *
 * @param svg - The serialized MathJax SVG document.
 * @returns The SVG with its root glyph stroke neutralised.
 */
function neutralizeGlyphStroke(svg: string): string {
  return svg.replaceAll(GLYPH_STROKE_PAINT, NO_STROKE_PAINT);
}

/**
 * Any SVG shape element MathJax may draw a real (non-zero-width) stroke with — the enclosure/strike
 * primitives of `menclose`/`\boxed`/`\cancel` (`rect`, `line`, `path`, …). Matched as a whole opening tag
 * so its attributes can be inspected. The scanned input is our own MathJax-produced SVG (bounded), so the
 * `[^>]*` runs cannot be driven into pathological backtracking.
 */
// eslint-disable-next-line redos/no-vulnerable -- bounded MathJax-produced input, see note above.
const STROKE_WIDTH_ELEMENT_RE = /<(rect|line|path|ellipse|circle|polyline|polygon)\b[^>]*\bstroke-width="([^"]+)"[^>]*>/g;

/** Whether an opening tag already carries an explicit stroke PAINT attribute (not `stroke-width`). */
function hasStrokePaint(tag: string): boolean {
  return /\sstroke="/.test(tag);
}

/**
 * Re-add an explicit `stroke="currentColor"` to every element that carries a NON-zero `stroke-width` but
 * no stroke paint of its own, so enclosure/strike notations still draw after {@link neutralizeGlyphStroke}
 * set the root paint to `none`. Zero-width elements (the root group, glyph rules) are left unstroked so
 * the glyph-hairline fix holds; elements that already declare a stroke paint are untouched. The paint is
 * inserted right after the element name so it is robust to attribute order and self-closing tags.
 *
 * @param svg - The SVG whose root stroke has already been neutralised.
 * @returns The SVG with real (non-zero-width) strokes restored.
 */
function restoreNonZeroStrokes(svg: string): string {
  return svg.replaceAll(STROKE_WIDTH_ELEMENT_RE, (tag: string, _name: string, width: string) => {
    if (hasStrokePaint(tag) || Number.parseFloat(width) === 0) return tag;
    return tag.replace(/^<([\w-]+)/, `<$1 ${GLYPH_STROKE_PAINT}`);
  });
}

/** Matches the root `<svg>`'s `viewBox` so the selectable text layer can be stretched over the glyphs. */
const VIEWBOX_RE = /viewBox="(-?[\d.]+)\s+(-?[\d.]+)\s+(-?[\d.]+)\s+(-?[\d.]+)"/;

// Matches the root `<svg>` open tag. The scanned input is our own MathJax-produced SVG (bounded), never
// an attacker-controlled stream, so the `[^>]*` run cannot be driven into pathological backtracking.
// eslint-disable-next-line redos/no-vulnerable -- bounded MathJax-produced input, see note above.
const SVG_ROOT_OPEN_RE = /(<svg\b[^>]*>)/;

/** Escape a string for safe placement as SVG/XML text content. */
function escapeXmlText(value: string): string {
  return value.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;');
}

/**
 * Overlay an invisible, selectable text layer carrying the math source over the vector glyphs. MathJax
 * draws glyphs as paths that carry no text, so the rendered math is otherwise unselectable. The
 * prawn-svg renderer emits a zero-opacity text element as a real, extractable PDF text object, so the
 * formula becomes searchable and copyable as its AsciiMath or LaTeX source. The text is stretched across
 * the equation box so selecting the equation selects its source. The input is returned unchanged when
 * the root has no viewBox.
 *
 * @param svg - The MathJax SVG document.
 * @param source - The inert math source to embed as the selectable layer.
 * @returns The SVG with an invisible selectable source-text layer added over the glyphs.
 */
function addSelectableSourceLayer(svg: string, source: string): string {
  const box = VIEWBOX_RE.exec(svg);
  if (box === null) {
    return svg;
  }
  const [, minX, minY, width, height] = box;
  const baseline = (Number(minY) + Number(height)).toFixed(2); // box bottom ≈ text baseline
  const layer =
    `<text x="${minX}" y="${baseline}" font-size="${height}" textLength="${width}" ` +
    `lengthAdjust="spacingAndGlyphs" fill="#000000" fill-opacity="0">${escapeXmlText(source)}</text>`;
  return svg.replace(SVG_ROOT_OPEN_RE, `$1${layer}`);
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
    // Size the root SVG in absolute points so prawn-svg renders math at body-text scale (not ~2x),
    // neutralise MathJax's zero-width root stroke so prawn-svg does not thicken every glyph with a
    // hairline outline (then restore real, non-zero-width enclosure/strike strokes), and finally overlay
    // an invisible selectable text layer so the formula is searchable/copyable as its source.
    const sized = sizeMathSvgToPoints(svg);
    const unstroked = restoreNonZeroStrokes(neutralizeGlyphStroke(sized));
    const withText = addSelectableSourceLayer(unstroked, expression);
    return {
      ok: true,
      asset: { format: OUTPUT_FORMAT, bytes: new TextEncoder().encode(withText), rasterFallback: false },
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
