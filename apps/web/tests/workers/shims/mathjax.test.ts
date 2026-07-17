// Contract unit tests for the MathJax math shim. These run in the jest `node` project (NO DOM: there is
// no `window`/`document`), which is the whole point — the shim now typesets with the DOM-free
// `mathjax-full` liteAdaptor so it can run inside the PDF Web Worker, which has no DOM.
//
// Two layers are asserted here:
//   - the RenderShim CONTRACT, exercised through an injected in-memory `MathSvgConverter` fake
//     (identity, SVG-bytes mapping, notation/layout param selection, error mapping, determinism); and
//   - the DEFAULT converter (no injection), which drives the real `mathjax-full` engine and MUST
//     produce typeset SVG WITHOUT a DOM — the capability the browser `<script>` path could never have.

import { readFileSync } from 'node:fs';
import path from 'node:path';

import mathjaxPackage from 'mathjax-full/package.json';

import type { ShimInput, ShimOutput } from '@asciidocollab/asciidoc-pdf';

import {
  createMathJaxShim,
  MATH_DISPLAY_PARAM,
  MATH_NOTATION_PARAM,
  type MathConversion,
  type MathSvgConverter,
} from '@/workers/shims/mathjax';

/** An in-memory fake converter that records every conversion and answers via an injected behaviour. */
class FakeConverter implements MathSvgConverter {
  readonly calls: MathConversion[] = [];

  constructor(private readonly behaviour: (conversion: MathConversion) => Promise<string>) {}

  toSvg(conversion: MathConversion): Promise<string> {
    this.calls.push(conversion);
    return this.behaviour(conversion);
  }
}

/** A converter that always returns a fixed SVG document string. */
function svgConverter(svg = '<svg xmlns="http://www.w3.org/2000/svg"><path d="M0 0"/></svg>'): FakeConverter {
  return new FakeConverter(() => Promise.resolve(svg));
}

/** A converter that always throws (simulating a MathJax parse/render failure). */
function throwingConverter(message = 'bad TeX'): FakeConverter {
  return new FakeConverter(() => Promise.reject(new Error(message)));
}

function inputFor(source: string, parameters: Record<string, string> = {}): ShimInput {
  return { source, params: parameters, preferredFormat: 'svg' };
}

function expectOkSvg(output: ShimOutput): string {
  expect(output.ok).toBe(true);
  if (!output.ok) {
    throw new Error('expected a successful render');
  }
  expect(output.asset.format).toBe('svg');
  expect(output.asset.rasterFallback).toBe(false);
  return new TextDecoder().decode(output.asset.bytes);
}

function expectMalformed(output: ShimOutput): void {
  expect(output.ok).toBe(false);
  if (output.ok) {
    throw new Error('expected a malformed-math diagnostic');
  }
  expect(output.diagnostic.code).toBe('malformed-math');
  expect(output.diagnostic.message.length).toBeGreaterThan(0);
}

describe('createMathJaxShim — contract identity', () => {
  it('is a math-family shim named "mathjax" carrying the installed MathJax version', () => {
    const shim = createMathJaxShim({ converter: svgConverter() });
    expect(shim.kind).toBe('math');
    expect(shim.name).toBe('mathjax');
    expect(shim.version).toBe(mathjaxPackage.version);
  });
});

describe('createMathJaxShim — successful render (injected converter)', () => {
  it('returns the converter SVG as UTF-8 bytes with no raster fallback', async () => {
    const svg = '<svg xmlns="http://www.w3.org/2000/svg"><text>x</text></svg>';
    const shim = createMathJaxShim({ converter: svgConverter(svg) });

    const output = await shim.render(inputFor('x^2', { [MATH_NOTATION_PARAM]: 'latexmath' }));

    expect(expectOkSvg(output)).toBe(svg);
  });

  it('sizes the root in points and overlays an invisible selectable source-text layer', async () => {
    // A MathJax-shaped SVG: ex-based root dimensions plus a viewBox for the text layer to span.
    const svg =
      '<svg xmlns="http://www.w3.org/2000/svg" width="8ex" height="2ex" viewBox="0 -800 4000 1000">' +
      '<path d="M0 0"/></svg>';
    const shim = createMathJaxShim({ converter: svgConverter(svg) });

    const out = expectOkSvg(await shim.render(inputFor('E = mc^2', { [MATH_NOTATION_PARAM]: 'latexmath' })));

    // Root dimensions converted ex → absolute pt so prawn-svg renders math at body-text scale, not ~2x.
    expect(out).toContain('width="36.00pt"');
    expect(out).toContain('height="9.00pt"');
    // An invisible (zero-opacity) text layer carries the source verbatim — searchable/copyable, no visual change.
    expect(out).toContain('fill-opacity="0"');
    expect(out).toContain('>E = mc^2</text>');
  });

  it('neutralises MathJax\'s zero-width glyph stroke so prawn-svg does not thicken the glyphs', async () => {
    // MathJax tags its glyph group with a non-none stroke plus stroke-width="0"; prawn-svg keys its
    // fill-vs-fill_and_stroke choice on the stroke paint alone, so a non-none stroke makes it outline
    // every glyph with a 1px hairline (the equation renders bold). The shim must rewrite it to none.
    const svg =
      '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 -800 4000 1000">' +
      '<g fill="currentColor" stroke="currentColor" stroke-width="0"><path d="M0 0"/></g></svg>';
    const shim = createMathJaxShim({ converter: svgConverter(svg) });

    const out = expectOkSvg(await shim.render(inputFor('x', { [MATH_NOTATION_PARAM]: 'latexmath' })));

    expect(out).toContain('stroke="none"');
    expect(out).not.toContain('stroke="currentColor"');
    // The fill paint is untouched — only the stroke is neutralised.
    expect(out).toContain('fill="currentColor"');
  });

  it('preserves a non-zero-width enclosure stroke (menclose/boxed/cancel) while neutralising glyphs', async () => {
    // The root group declares the zero-width glyph stroke; the enclosure <rect> carries a REAL non-zero
    // stroke-width and no stroke of its own, relying on inheritance. Neutralising the root must not erase
    // it — the rect must keep an explicit stroke paint so the box still draws.
    const svg =
      '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 -800 4000 1000">' +
      '<g fill="currentColor" stroke="currentColor" stroke-width="0">' +
      '<path d="M0 0"/><rect x="0" y="0" width="100" height="50" fill="none" stroke-width="67"/></g></svg>';
    const shim = createMathJaxShim({ converter: svgConverter(svg) });

    const out = expectOkSvg(await shim.render(inputFor(String.raw`\boxed{x}`, { [MATH_NOTATION_PARAM]: 'latexmath' })));

    // Root group is neutralised (glyphs render fill-only, no hairline).
    expect(out).toContain('<g fill="currentColor" stroke="none" stroke-width="0">');
    // The enclosure rect keeps its non-zero width AND regains an explicit stroke so it still draws.
    const rect = /<rect\b[^>]*>/.exec(out)?.[0] ?? '';
    expect(rect).toContain('stroke-width="67"');
    expect(rect).toContain('stroke="currentColor"');
  });

  it('escapes markup-significant characters in the selectable source layer', async () => {
    const svg = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 -800 4000 1000"><path d="M0 0"/></svg>';
    const shim = createMathJaxShim({ converter: svgConverter(svg) });

    const out = expectOkSvg(await shim.render(inputFor('a < b & c', { [MATH_NOTATION_PARAM]: 'asciimath' })));

    expect(out).toContain('a &lt; b &amp; c');
    expect(out).not.toContain('>a < b & c<');
  });

  it('produces identical bytes for identical source + params (determinism)', async () => {
    const shim = createMathJaxShim({ converter: svgConverter() });
    const first = await shim.render(inputFor('a+b', { [MATH_NOTATION_PARAM]: 'latexmath' }));
    const second = await shim.render(inputFor('a+b', { [MATH_NOTATION_PARAM]: 'latexmath' }));

    expect(first.ok && second.ok).toBe(true);
    if (!first.ok || !second.ok) {
      throw new Error('expected success');
    }
    expect(first.asset.bytes).toEqual(second.asset.bytes);
  });
});

describe('createMathJaxShim — notation selection (mirrors the preview renderer)', () => {
  it('maps latexmath → tex', async () => {
    const converter = svgConverter();
    await createMathJaxShim({ converter }).render(inputFor('x', { [MATH_NOTATION_PARAM]: 'latexmath' }));
    expect(converter.calls[0].notation).toBe('tex');
  });

  it('maps asciimath → asciimath', async () => {
    const converter = svgConverter();
    await createMathJaxShim({ converter }).render(inputFor('x', { [MATH_NOTATION_PARAM]: 'asciimath' }));
    expect(converter.calls[0].notation).toBe('asciimath');
  });

  it('treats an unqualified "stem" as AsciiMath (Asciidoctor default)', async () => {
    const converter = svgConverter();
    await createMathJaxShim({ converter }).render(inputFor('x', { [MATH_NOTATION_PARAM]: 'stem' }));
    expect(converter.calls[0].notation).toBe('asciimath');
  });

  it('defaults to AsciiMath when no notation param is present', async () => {
    const converter = svgConverter();
    await createMathJaxShim({ converter }).render(inputFor('x'));
    expect(converter.calls[0].notation).toBe('asciimath');
  });
});

describe('createMathJaxShim — layout (display vs inline)', () => {
  it('renders display layout by default', async () => {
    const converter = svgConverter();
    await createMathJaxShim({ converter }).render(inputFor('x'));
    expect(converter.calls[0].display).toBe(true);
  });

  it('renders inline layout when the display param is "false"', async () => {
    const converter = svgConverter();
    await createMathJaxShim({ converter }).render(inputFor('x', { [MATH_DISPLAY_PARAM]: 'false' }));
    expect(converter.calls[0].display).toBe(false);
  });
});

describe('createMathJaxShim — error mapping (never throws)', () => {
  it('maps a converter throw to a malformed-math diagnostic', async () => {
    const shim = createMathJaxShim({ converter: throwingConverter('unexpected }') });
    const output = await shim.render(inputFor(String.raw`\frac{1}{`, { [MATH_NOTATION_PARAM]: 'latexmath' }));
    expectMalformed(output);
  });

  it('maps blank source to malformed-math without invoking the converter', async () => {
    const converter = svgConverter();
    const output = await createMathJaxShim({ converter }).render(inputFor('   \n  '));
    expectMalformed(output);
    expect(converter.calls).toHaveLength(0);
  });

  it('maps empty converter output to malformed-math', async () => {
    const shim = createMathJaxShim({ converter: new FakeConverter(() => Promise.resolve('   ')) });
    const output = await shim.render(inputFor('x'));
    expectMalformed(output);
  });
});

describe('createMathJaxShim — default converter typesets WITHOUT a DOM (mathjax-full liteAdaptor)', () => {
  // Guard the premise: this project is the jest `node` environment, so there is genuinely no DOM. If
  // the default converter still produces SVG below, it proves the engine never touched `window`/`document`.
  it('runs in a genuinely DOM-free environment', () => {
    expect(typeof (globalThis as { window?: unknown }).window).toBe('undefined');
    expect(typeof (globalThis as { document?: unknown }).document).toBe('undefined');
  });

  it('typesets a TeX (latexmath) expression to standalone SVG with no DOM present', async () => {
    const shim = createMathJaxShim();
    const svg = expectOkSvg(await shim.render(inputFor('x^2', { [MATH_NOTATION_PARAM]: 'latexmath' })));
    expect(svg.startsWith('<svg')).toBe(true);
    expect(svg).toContain('</svg>');
    // A local font cache embeds glyph paths as `<defs>` inside each standalone SVG (self-contained output).
    expect(svg).toContain('<defs');
    expect(svg).toContain('<path');
  });

  it('typesets an AsciiMath expression to standalone SVG with no DOM present', async () => {
    const shim = createMathJaxShim();
    const svg = expectOkSvg(await shim.render(inputFor('sqrt 4', { [MATH_NOTATION_PARAM]: 'asciimath' })));
    expect(svg.startsWith('<svg')).toBe(true);
    expect(svg).toContain('</svg>');
  });

  it('produces byte-identical SVG for identical source + params (deterministic local font cache)', async () => {
    const shim = createMathJaxShim();
    const first = await shim.render(inputFor('a+b', { [MATH_NOTATION_PARAM]: 'latexmath' }));
    const second = await shim.render(inputFor('a+b', { [MATH_NOTATION_PARAM]: 'latexmath' }));

    const firstSvg = expectOkSvg(first);
    const secondSvg = expectOkSvg(second);
    expect(firstSvg).toBe(secondSvg);
    if (first.ok && second.ok) {
      expect(first.asset.bytes).toEqual(second.asset.bytes);
    }
    // No timestamp/random-id leakage that would defeat a deterministic cache-key.
    expect(firstSvg).not.toMatch(/\d{13}/);
  });

  it('honours the display param — displaystyle limits differ from inline for the same source', async () => {
    // A summation places its bounds above/below in display style but as sub/superscripts inline, so the
    // typeset SVG genuinely differs — proving the layout flag reaches the real engine, not just the seam.
    const source = String.raw`\sum_{i=1}^{n} i`;
    const shim = createMathJaxShim();
    const display = expectOkSvg(await shim.render(inputFor(source, { [MATH_NOTATION_PARAM]: 'latexmath' })));
    const inline = expectOkSvg(
      await shim.render(inputFor(source, { [MATH_NOTATION_PARAM]: 'latexmath', [MATH_DISPLAY_PARAM]: 'false' })),
    );
    expect(display).not.toBe(inline);
  });

  it('emits only self-hosted, offline SVG (no remote/CDN URL)', async () => {
    const shim = createMathJaxShim();
    const svg = expectOkSvg(await shim.render(inputFor('E = mc^2', { [MATH_NOTATION_PARAM]: 'latexmath' })));
    expect(svg).not.toMatch(/https?:\/\/(?!www\.w3\.org)/);
  });

  it('emits no non-none glyph stroke, so prawn-svg fills glyphs without a bolding hairline', async () => {
    // The real engine tags its glyph group `stroke="currentColor" stroke-width="0"`. prawn-svg would
    // stroke that with a 1px hairline (bold-looking math); the shim must leave no such stroke behind for a
    // plain (enclosure-free) expression.
    const shim = createMathJaxShim();
    const svg = expectOkSvg(await shim.render(inputFor('E = mc^2', { [MATH_NOTATION_PARAM]: 'latexmath' })));
    expect(svg).toContain('<path');
    expect(svg).not.toContain('stroke="currentColor"');
  });

  it('keeps a boxed equation\'s border stroked (enclosure notations are not erased)', async () => {
    // Regression: neutralising the root stroke must not wipe \boxed/\cancel/menclose borders, which are
    // drawn as a non-zero-width <rect>/<line> that inherits the root paint. The engine draws \boxed's box
    // as a rect with a real stroke-width; after the shim it must carry an explicit stroke so it still draws.
    const shim = createMathJaxShim();
    const svg = expectOkSvg(await shim.render(inputFor(String.raw`\boxed{x}`, { [MATH_NOTATION_PARAM]: 'latexmath' })));
    const stroked = [...svg.matchAll(/<(?:rect|line)\b[^>]*>/g)].find(
      (match) => /stroke-width="([\d.]+)"/.exec(match[0]) !== null && Number.parseFloat(/stroke-width="([\d.]+)"/.exec(match[0])![1]) > 0,
    );
    expect(stroked).toBeDefined();
    expect(stroked?.[0]).toContain('stroke="currentColor"');
  });
});

// ---------------------------------------------------------------------------
// Reference-parity guard: the DOM-free liteAdaptor (the production PDF-worker path) must lay glyphs out
// identically to the committed PDF-parity reference SVGs, which were captured from the BROWSER MathJax
// engine (see e2e/pdf-parity/emit-reference-inputs.spec.ts). The reference PDF the parity suite compares
// against embeds those exact SVGs, so this guard is what ties the worker's typeset output to that visual
// reference: same MathJax version + same `svg.fontCache: 'local'`, so the geometry — viewBox, glyph paths,
// element placement — must be byte-equal up to serialization cosmetics (attribute order, the browser's
// `aria-hidden`, void-element self-closing). If a future engine/adaptor change moves a glyph, this fails
// loudly and the committed reference (and PDF) must be regenerated together.
describe('createMathJaxShim — default converter matches the committed PDF-parity reference geometry', () => {
  const REFERENCE_GEN_DIR = path.resolve(
    __dirname,
    '../../../e2e/pdf-parity/fixtures/math/reference-build/.gen',
  );

  /** The two displayed fixture expressions and the reference SVG each one produced (math/source/main.adoc). */
  const FIXTURE_CASES = [
    {
      label: 'quadratic formula (latexmath, display)',
      source: String.raw`x = \frac{-b \pm \sqrt{b^2 - 4ac}}{2a}`,
      notation: 'latexmath',
      referenceFile: '1087f6478a440397.svg',
    },
    {
      label: 'summation (asciimath, display)',
      source: 'sum_(i=1)^n i = (n(n+1))/2',
      notation: 'asciimath',
      referenceFile: 'd2dce427889c5ba9.svg',
    },
  ] as const;

  /** Read one attribute from a single element's opening tag, robust to attribute ordering. */
  function attribute(tag: string, name: string): string {
    return new RegExp(String.raw`\b${name}="([^"]*)"`).exec(tag)?.[1] ?? '';
  }

  /** Every opening tag of the given element name (self-closing or not). */
  function elements(svg: string, name: string): string[] {
    return [...svg.matchAll(new RegExp(String.raw`<${name}\b[^>]*?/?>`, 'g'))].map((match) => match[0]);
  }

  /**
   * A serialization-independent geometry fingerprint: the root SVG's sizing box plus the sorted set of
   * glyph paths, glyph placements, fraction/root rules, and group transforms. Two SVGs with the same
   * fingerprint render identical ink; attribute order, `aria-hidden`, and void-element style are ignored.
   */
  function geometryFingerprint(svg: string): unknown {
    const root = /<svg\b[^>]*>/.exec(svg)?.[0] ?? '';
    return {
      width: attribute(root, 'width'),
      height: attribute(root, 'height'),
      viewBox: attribute(root, 'viewBox'),
      verticalAlign: (/vertical-align:\s*([^;"]*)/.exec(root)?.[1] ?? '').trim(),
      paths: elements(svg, 'path')
        .map((tag) => `${attribute(tag, 'id')}|${attribute(tag, 'd')}`)
        .toSorted(),
      uses: elements(svg, 'use')
        .map(
          (tag) =>
            `${attribute(tag, 'xlink:href')}|${attribute(tag, 'transform')}|${attribute(tag, 'x')}|${attribute(tag, 'y')}`,
        )
        .toSorted(),
      rects: elements(svg, 'rect')
        .map((tag) => `${attribute(tag, 'x')}|${attribute(tag, 'y')}|${attribute(tag, 'width')}|${attribute(tag, 'height')}`)
        .toSorted(),
      groupTransforms: elements(svg, 'g')
        .map((tag) => attribute(tag, 'transform'))
        .filter((transform) => transform.length > 0)
        .toSorted(),
    };
  }

  it.each(FIXTURE_CASES)(
    'lays out $label identically to its committed reference SVG',
    async ({ source, notation, referenceFile }) => {
      const shim = createMathJaxShim();
      const ours = expectOkSvg(await shim.render(inputFor(source, { [MATH_NOTATION_PARAM]: notation })));
      const reference = readFileSync(path.join(REFERENCE_GEN_DIR, referenceFile), 'utf8');

      expect(geometryFingerprint(ours)).toEqual(geometryFingerprint(reference));
    },
  );
});
