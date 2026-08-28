import type { ShimInput } from '@asciidocollab/asciidoc-pdf';

import {
  createVegaShim,
  type RemoteBlockingLoader,
  type VegaEngine,
} from '@/workers/shims/vega';

const SAMPLE_SVG = '<svg xmlns="http://www.w3.org/2000/svg"><rect width="1" height="1" /></svg>';

const blockInput = (source: string): ShimInput => ({ source, params: {}, preferredFormat: 'svg' });

const passthroughEngine = (svg = SAMPLE_SVG): VegaEngine => ({
  compileVegaLite: async (spec) => spec,
  renderToSvg: async () => svg,
});

describe('vega diagram shim', () => {
  it('exposes the diagram-shim identity', () => {
    const shim = createVegaShim(passthroughEngine());
    expect(shim.kind).toBe('diagram');
    expect(shim.name).toBe('vega');
    expect(shim.version).toMatch(/\d/);
  });

  it('renders a spec to UTF-8 SVG bytes on success', async () => {
    const shim = createVegaShim(passthroughEngine());

    const output = await shim.render(blockInput(JSON.stringify({ marks: [] })));

    expect(output.ok).toBe(true);
    if (output.ok) {
      expect(output.asset.format).toBe('svg');
      expect(output.asset.rasterFallback).toBe(false);
      expect(new TextDecoder().decode(output.asset.bytes)).toBe(SAMPLE_SVG);
    }
  });

  it('compiles a vega-lite spec to vega before rendering', async () => {
    const compiled: Record<string, unknown> = { marks: [{ type: 'rect' }] };
    let compiledFrom: Record<string, unknown> | undefined;
    let rendered: Record<string, unknown> | undefined;
    const engine: VegaEngine = {
      compileVegaLite: async (spec) => {
        compiledFrom = spec;
        return compiled;
      },
      renderToSvg: async (spec) => {
        rendered = spec;
        return SAMPLE_SVG;
      },
    };
    const vegaLiteSpec = {
      $schema: 'https://vega.github.io/schema/vega-lite/v6.json',
      mark: 'bar',
    };

    const output = await createVegaShim(engine).render(blockInput(JSON.stringify(vegaLiteSpec)));

    expect(output.ok).toBe(true);
    expect(compiledFrom).toEqual(vegaLiteSpec);
    expect(rendered).toEqual(compiled);
  });

  it('renders a plain vega spec without compiling', async () => {
    let compileCalled = false;
    const engine: VegaEngine = {
      compileVegaLite: async (spec) => {
        compileCalled = true;
        return spec;
      },
      renderToSvg: async () => SAMPLE_SVG,
    };
    const vegaSpec = {
      $schema: 'https://vega.github.io/schema/vega/v6.json',
      marks: [],
    };

    const output = await createVegaShim(engine).render(blockInput(JSON.stringify(vegaSpec)));

    expect(output.ok).toBe(true);
    expect(compileCalled).toBe(false);
  });

  it('classifies a spec with a non-decisive $schema and a top-level marks array as plain Vega', async () => {
    let compileCalled = false;
    const engine: VegaEngine = {
      compileVegaLite: async (spec) => {
        compileCalled = true;
        return spec;
      },
      renderToSvg: async () => SAMPLE_SVG,
    };
    const spec = { $schema: 'https://example.com/unknown.json', marks: [] };

    const output = await createVegaShim(engine).render(blockInput(JSON.stringify(spec)));

    expect(output.ok).toBe(true);
    // A `marks` array means Vega, so no Vega-Lite compilation runs despite the unrecognised schema.
    expect(compileCalled).toBe(false);
  });

  it('classifies a spec with a non-decisive $schema and a Vega-Lite key as Vega-Lite', async () => {
    let compileCalled = false;
    const engine: VegaEngine = {
      compileVegaLite: async () => {
        compileCalled = true;
        return { marks: [] };
      },
      renderToSvg: async () => SAMPLE_SVG,
    };
    const spec = { $schema: 'https://example.com/unknown.json', mark: 'bar' };

    await createVegaShim(engine).render(blockInput(JSON.stringify(spec)));

    // A singular Vega-Lite key (`mark`) with no `marks` array routes through Vega-Lite compilation.
    expect(compileCalled).toBe(true);
  });

  it('renders with a loader that blocks all remote/offline I/O', async () => {
    let loader: RemoteBlockingLoader | undefined;
    const engine: VegaEngine = {
      compileVegaLite: async (spec) => spec,
      renderToSvg: async (_spec, injected) => {
        loader = injected;
        return SAMPLE_SVG;
      },
    };

    await createVegaShim(engine).render(blockInput(JSON.stringify({ marks: [] })));

    expect(loader).toBeDefined();
    await expect(loader?.load('http://example.com/data.json')).rejects.toThrow();
    await expect(loader?.http('http://example.com/data.json', {})).rejects.toThrow();
    await expect(loader?.file('/etc/passwd')).rejects.toThrow();
  });

  it('maps malformed JSON to a malformed-diagram diagnostic', async () => {
    const output = await createVegaShim(passthroughEngine()).render(blockInput('{ not: json'));

    expect(output.ok).toBe(false);
    if (!output.ok) {
      expect(output.diagnostic.code).toBe('malformed-diagram');
    }
  });

  it('maps a non-object spec to a malformed-diagram diagnostic', async () => {
    const output = await createVegaShim(passthroughEngine()).render(blockInput('[1, 2, 3]'));

    expect(output.ok).toBe(false);
    if (!output.ok) {
      expect(output.diagnostic.code).toBe('malformed-diagram');
    }
  });

  it('reports a non-Error render failure by its string form', async () => {
    const engine: VegaEngine = {
      compileVegaLite: async (spec) => spec,
      renderToSvg: async () => {
        throw 'the runtime gave up';
      },
    };

    const output = await createVegaShim(engine).render(blockInput(JSON.stringify({ marks: [] })));

    expect(output.ok).toBe(false);
    if (!output.ok) {
      expect(output.diagnostic.message).toBe('the runtime gave up');
    }
  });

  it('maps a render throw to a malformed-diagram diagnostic and never throws', async () => {
    const engine: VegaEngine = {
      compileVegaLite: async (spec) => spec,
      renderToSvg: async () => {
        throw new Error('invalid spec');
      },
    };

    const output = await createVegaShim(engine).render(blockInput(JSON.stringify({ marks: [] })));

    expect(output.ok).toBe(false);
    if (!output.ok) {
      expect(output.diagnostic.code).toBe('malformed-diagram');
      expect(output.diagnostic.message).toContain('invalid spec');
    }
  });
});

/** The options the shim hands the Vega `View` it constructs. */
interface FakeViewOptions {
  readonly renderer: string;
  readonly loader: RemoteBlockingLoader;
}

describe('vega diagram shim — bundled engine', () => {
  let viewOptions: FakeViewOptions | undefined;
  let finalized: number;
  let parsedSpecs: unknown[];

  beforeEach(() => {
    jest.resetModules();
    viewOptions = undefined;
    finalized = 0;
    parsedSpecs = [];
  });

  afterEach(() => {
    jest.dontMock('vega');
    jest.dontMock('vega-lite');
  });

  /** Records every spec handed to `vega.parse` and stands in for the compiled runtime. */
  const record = (spec: unknown): unknown => {
    parsedSpecs.push(spec);
    return { runtime: true };
  };

  /** Install a `vega` module whose `View` records its options and yields `svg` from `toSVG`. */
  function mockVegaModule(svg: string | Error): void {
    class FakeView {
      constructor(_runtime: unknown, options: FakeViewOptions) {
        viewOptions = options;
      }

      async toSVG(): Promise<string> {
        if (svg instanceof Error) throw svg;
        return svg;
      }

      finalize(): void {
        finalized += 1;
      }
    }
    jest.doMock('vega', () => ({ __esModule: true, parse: record, View: FakeView }));
  }

  it('compiles a vega-lite spec with the bundled compiler before rendering it', async () => {
    const compiled = { marks: [{ type: 'rect' }] };
    const seen: unknown[] = [];
    jest.doMock('vega-lite', () => ({
      __esModule: true,
      compile: (spec: unknown) => {
        seen.push(spec);
        return { spec: compiled };
      },
    }));
    mockVegaModule(SAMPLE_SVG);
    const { createVegaShim: create } = await import('@/workers/shims/vega');

    const source = JSON.stringify({ $schema: 'https://vega.github.io/schema/vega-lite/v6.json', mark: 'bar' });
    const output = await create().render(blockInput(source));

    expect(seen).toHaveLength(1);
    expect(parsedSpecs).toEqual([compiled]);
    expect(output.ok).toBe(true);
    if (output.ok) {
      expect(new TextDecoder().decode(output.asset.bytes)).toBe(SAMPLE_SVG);
    }
  });

  it('renders a plain vega spec with the offline loader and finalizes the view', async () => {
    mockVegaModule(SAMPLE_SVG);
    const { createVegaShim: create } = await import('@/workers/shims/vega');

    const output = await create().render(blockInput(JSON.stringify({ marks: [] })));

    expect(output.ok).toBe(true);
    expect(viewOptions?.renderer).toBe('none');
    expect(finalized).toBe(1);
    await expect(viewOptions?.loader.http('https://example.com/data.json', {})).rejects.toThrow();
  });

  it('finalizes the view even when the render fails', async () => {
    mockVegaModule(new Error('render blew up'));
    const { createVegaShim: create } = await import('@/workers/shims/vega');

    const output = await create().render(blockInput(JSON.stringify({ marks: [] })));

    expect(output.ok).toBe(false);
    expect(finalized).toBe(1);
  });

  it('reports a vega-lite module without the expected compile surface as a diagnostic', async () => {
    jest.doMock('vega-lite', () => ({ __esModule: true }));
    mockVegaModule(SAMPLE_SVG);
    const { createVegaShim: create } = await import('@/workers/shims/vega');

    const source = JSON.stringify({ $schema: 'https://vega.github.io/schema/vega-lite/v6.json', mark: 'bar' });
    const output = await create().render(blockInput(source));

    expect(output.ok).toBe(false);
    if (!output.ok) {
      expect(output.diagnostic.message).toContain('compile surface');
    }
  });

  it('reports a vega module without the expected parse/View surface as a diagnostic', async () => {
    jest.doMock('vega', () => ({ __esModule: true, parse: () => undefined }));
    const { createVegaShim: create } = await import('@/workers/shims/vega');

    const output = await create().render(blockInput(JSON.stringify({ marks: [] })));

    expect(output.ok).toBe(false);
    if (!output.ok) {
      expect(output.diagnostic.message).toContain('parse/View surface');
    }
  });
});
