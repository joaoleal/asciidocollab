import type { MermaidConfig } from 'mermaid';

import type { ShimInput } from '@asciidocollab/asciidoc-pdf';

import {
  buildPreviewMermaidConfig,
  createMermaidShim,
  type MermaidRenderer,
} from '@/workers/shims/mermaid';

const SAMPLE_SVG = '<svg xmlns="http://www.w3.org/2000/svg"><text>A</text></svg>';

const blockInput = (source: string): ShimInput => ({ source, params: {}, preferredFormat: 'svg' });

const constantRenderer: MermaidRenderer = async () => SAMPLE_SVG;

describe('mermaid diagram shim', () => {
  it('exposes the diagram-shim identity', () => {
    const shim = createMermaidShim(constantRenderer);
    expect(shim.kind).toBe('diagram');
    expect(shim.name).toBe('mermaid');
    expect(shim.version).toMatch(/\d/);
  });

  it('renders source to UTF-8 SVG bytes on success', async () => {
    const shim = createMermaidShim(constantRenderer);

    const output = await shim.render(blockInput('graph TD; A-->B'));

    expect(output.ok).toBe(true);
    if (output.ok) {
      expect(output.asset.format).toBe('svg');
      expect(output.asset.rasterFallback).toBe(false);
      expect(new TextDecoder().decode(output.asset.bytes)).toBe(SAMPLE_SVG);
    }
  });

  it('applies the strict, foreignObject-free security configuration', async () => {
    let captured: MermaidConfig | undefined;
    const capturingRenderer: MermaidRenderer = async (config) => {
      captured = config;
      return SAMPLE_SVG;
    };

    await createMermaidShim(capturingRenderer).render(blockInput('graph TD; A-->B'));

    expect(captured?.securityLevel).toBe('strict');
    // The global htmlLabels flag (mermaid's non-deprecated home for it) forces real <text> labels.
    expect(captured?.htmlLabels).toBe(false);
    // Deterministic ids keep byte output stable across identical renders.
    expect(captured?.deterministicIds).toBe(true);
    expect(captured?.startOnLoad).toBe(false);
  });

  it('hands the block source to the engine unchanged (inert data)', async () => {
    let seen: string | undefined;
    const shim = createMermaidShim(async (_config, source) => {
      seen = source;
      return SAMPLE_SVG;
    });
    const source = 'graph TD; A-->B';

    await shim.render(blockInput(source));

    expect(seen).toBe(source);
  });

  it('maps a render throw to a malformed-diagram diagnostic and never throws', async () => {
    const shim = createMermaidShim(async () => {
      throw new Error('parse boom');
    });

    const output = await shim.render(blockInput('not a diagram'));

    expect(output.ok).toBe(false);
    if (!output.ok) {
      expect(output.diagnostic.code).toBe('malformed-diagram');
      expect(output.diagnostic.message).toContain('boom');
    }
  });

  it('reports a non-Error render failure by its string form', async () => {
    const shim = createMermaidShim(async () => {
      throw 'the engine gave up';
    });

    const output = await shim.render(blockInput('graph TD; A-->B'));

    expect(output.ok).toBe(false);
    if (!output.ok) {
      expect(output.diagnostic.message).toBe('the engine gave up');
    }
  });
});

describe('preview mermaid configuration', () => {
  it('matches the export configuration so the preview is strict and label-safe too', async () => {
    let exportConfig: MermaidConfig | undefined;
    await createMermaidShim(async (config) => {
      exportConfig = config;
      return SAMPLE_SVG;
    }).render(blockInput('graph TD; A-->B'));

    expect(buildPreviewMermaidConfig()).toEqual(exportConfig);
    expect(buildPreviewMermaidConfig().securityLevel).toBe('strict');
    expect(buildPreviewMermaidConfig().htmlLabels).toBe(false);
    expect(buildPreviewMermaidConfig().suppressErrorRendering).toBe(true);
  });
});

describe('mermaid diagram shim — bundled engine', () => {
  beforeEach(() => {
    jest.resetModules();
  });

  afterEach(() => {
    jest.dontMock('mermaid');
  });

  it('initializes the real engine with the strict config and returns its SVG', async () => {
    const initialized: MermaidConfig[] = [];
    const renderCalls: string[][] = [];
    jest.doMock('mermaid', () => ({
      __esModule: true,
      default: {
        initialize: (config: MermaidConfig) => {
          initialized.push(config);
        },
        render: async (id: string, source: string) => {
          renderCalls.push([id, source]);
          return { svg: SAMPLE_SVG };
        },
      },
    }));
    const { createMermaidShim: create } = await import('@/workers/shims/mermaid');

    const output = await create().render(blockInput('graph TD; A-->B'));

    expect(initialized).toHaveLength(1);
    expect(initialized[0].securityLevel).toBe('strict');
    expect(renderCalls[0][1]).toBe('graph TD; A-->B');
    expect(output.ok).toBe(true);
    if (output.ok) {
      expect(new TextDecoder().decode(output.asset.bytes)).toBe(SAMPLE_SVG);
    }
  });
});
