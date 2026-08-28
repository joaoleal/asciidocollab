import type { ShimInput } from '@asciidocollab/asciidoc-pdf';

import { createGraphvizShim, type GraphvizRenderer } from '@/workers/shims/graphviz';

const SAMPLE_SVG = '<svg xmlns="http://www.w3.org/2000/svg"><g class="node"><text>A</text></g></svg>';

const blockInput = (source: string): ShimInput => ({ source, params: {}, preferredFormat: 'svg' });

const constantRenderer: GraphvizRenderer = async () => SAMPLE_SVG;

describe('graphviz diagram shim', () => {
  it('exposes the diagram-shim identity', () => {
    const shim = createGraphvizShim(constantRenderer);
    expect(shim.kind).toBe('diagram');
    expect(shim.name).toBe('graphviz');
    expect(shim.version).toMatch(/\d/);
  });

  it('renders DOT source to UTF-8 SVG bytes on success', async () => {
    const shim = createGraphvizShim(constantRenderer);

    const output = await shim.render(blockInput('digraph { a -> b }'));

    expect(output.ok).toBe(true);
    if (output.ok) {
      expect(output.asset.format).toBe('svg');
      expect(output.asset.rasterFallback).toBe(false);
      expect(new TextDecoder().decode(output.asset.bytes)).toBe(SAMPLE_SVG);
    }
  });

  it('hands the DOT source to the engine unchanged (inert data)', async () => {
    let seen: string | undefined;
    const shim = createGraphvizShim(async (source) => {
      seen = source;
      return SAMPLE_SVG;
    });
    const source = 'digraph { a -> b }';

    await shim.render(blockInput(source));

    expect(seen).toBe(source);
  });

  it('reports a non-Error render failure by its string form', async () => {
    const shim = createGraphvizShim(async () => {
      throw 'the engine gave up';
    });

    const output = await shim.render(blockInput('digraph { a -> b }'));

    expect(output.ok).toBe(false);
    if (!output.ok) {
      expect(output.diagnostic.message).toBe('the engine gave up');
    }
  });

  it('maps a render throw to a malformed-diagram diagnostic and never throws', async () => {
    const shim = createGraphvizShim(async () => {
      throw new Error('syntax error in line 1');
    });

    const output = await shim.render(blockInput('digraph { a -> '));

    expect(output.ok).toBe(false);
    if (!output.ok) {
      expect(output.diagnostic.code).toBe('malformed-diagram');
      expect(output.diagnostic.message).toContain('syntax error');
    }
  });
});

describe('graphviz diagram shim — bundled WASM engine', () => {
  beforeEach(() => {
    jest.resetModules();
  });

  afterEach(() => {
    jest.dontMock('@hpcc-js/wasm');
  });

  it('loads the WASM engine and hands it the DOT source unchanged', async () => {
    const seen: string[] = [];
    jest.doMock('@hpcc-js/wasm', () => ({
      __esModule: true,
      Graphviz: {
        load: async () => ({
          dot: (source: string) => {
            seen.push(source);
            return SAMPLE_SVG;
          },
        }),
      },
    }));
    const { createGraphvizShim: create } = await import('@/workers/shims/graphviz');

    const output = await create().render(blockInput('digraph { a -> b }'));

    expect(seen).toEqual(['digraph { a -> b }']);
    expect(output.ok).toBe(true);
    if (output.ok) {
      expect(new TextDecoder().decode(output.asset.bytes)).toBe(SAMPLE_SVG);
    }
  });

  it('reports a WASM engine that will not load as a malformed-diagram diagnostic', async () => {
    jest.doMock('@hpcc-js/wasm', () => ({
      __esModule: true,
      Graphviz: {
        load: async () => {
          throw new Error('wasm unavailable');
        },
      },
    }));
    const { createGraphvizShim: create } = await import('@/workers/shims/graphviz');

    const output = await create().render(blockInput('digraph { a -> b }'));

    expect(output.ok).toBe(false);
    if (!output.ok) {
      expect(output.diagnostic.code).toBe('malformed-diagram');
      expect(output.diagnostic.message).toContain('wasm unavailable');
    }
  });
});
