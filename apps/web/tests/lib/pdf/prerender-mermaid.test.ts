import {
  computeSourceHash,
  detectRenderableBlocks,
  type RenderableBlock,
} from '@asciidocollab/asciidoc-pdf';

import { createMermaidPrerenderer, type IdleScheduler } from '@/lib/pdf/prerender-mermaid';
import { createMermaidShim, type MermaidRenderer } from '@/workers/shims/mermaid';

/** A deterministic, DOM-free stand-in for the real mermaid engine: SVG derived purely from the source. */
const fakeRenderer: MermaidRenderer = async (_config, source) => `<svg data-source="${source}"></svg>`;

const failingRenderer: MermaidRenderer = async () => {
  throw new Error('bad diagram');
};

/** A document holding one mermaid diagram, one graphviz diagram, one block and one inline math macro. */
const MIXED_DOCUMENT = [
  '= Title',
  '',
  '[mermaid]',
  '----',
  'graph TD; A-->B',
  '----',
  '',
  '[graphviz]',
  '----',
  'digraph { a -> b }',
  '----',
  '',
  'Inline stem:[x^2] here.',
  '',
  '[stem]',
  '....',
  'y = mx + b',
  '....',
  '',
].join('\n');

/** Run the scheduled callback immediately (a synchronous idle). */
const runNow: IdleScheduler = (callback) => callback();

/** The single mermaid block the shared detector finds in {@link MIXED_DOCUMENT}. */
function mermaidBlockOf(text: string): RenderableBlock {
  const block = detectRenderableBlocks(text).find(
    (candidate) => candidate.category === 'diagram' && candidate.notation === 'mermaid',
  );
  if (block === undefined) {
    throw new Error('expected a mermaid block in the fixture');
  }
  return block;
}

describe('createMermaidPrerenderer', () => {
  it('selects only mermaid diagrams, ignoring other diagram engines and math', async () => {
    const prerenderer = createMermaidPrerenderer({
      mermaidRenderer: fakeRenderer,
      scheduleIdle: runNow,
    });

    const result = await prerenderer.prerender(MIXED_DOCUMENT);

    expect(result.aborted).toBe(false);
    expect(result.assets).toHaveLength(1);
    expect(result.assets[0]).toMatchObject({ kind: 'diagram', format: 'svg' });
  });

  it('content-addresses each asset with the same hash the worker stage computes (cache-key parity)', async () => {
    const prerenderer = createMermaidPrerenderer({
      mermaidRenderer: fakeRenderer,
      scheduleIdle: runNow,
    });

    const result = await prerenderer.prerender(MIXED_DOCUMENT);
    const block = mermaidBlockOf(MIXED_DOCUMENT);

    // Parity recipe: the stage feeds computeSourceHash the block's own source + params (straight from
    // detectRenderableBlocks) and the mermaid shim's version — assert against that exact triple.
    const expectedHash = computeSourceHash({
      source: block.source,
      renderParams: block.params,
      shimVersion: createMermaidShim().version,
    });
    expect(result.assets[0].sourceHash).toBe(expectedHash);
  });

  it('renders deterministically: identical source yields byte-identical assets', async () => {
    const prerenderer = createMermaidPrerenderer({
      mermaidRenderer: fakeRenderer,
      scheduleIdle: runNow,
    });

    const first = await prerenderer.prerender(MIXED_DOCUMENT);
    const second = await prerenderer.prerender(MIXED_DOCUMENT);

    expect(first.assets[0].sourceHash).toBe(second.assets[0].sourceHash);
    expect([...first.assets[0].bytes]).toEqual([...second.assets[0].bytes]);
  });

  it('schedules its work through the idle scheduler seam', async () => {
    const scheduleIdle = jest.fn<void, [() => void]>((callback) => callback());
    const prerenderer = createMermaidPrerenderer({ mermaidRenderer: fakeRenderer, scheduleIdle });

    await prerenderer.prerender(MIXED_DOCUMENT);

    expect(scheduleIdle).toHaveBeenCalled();
  });

  it('supersedes an in-flight run: the older run emits nothing, the newer run wins (coalescing)', async () => {
    const queue: Array<() => void> = [];
    const scheduleIdle: IdleScheduler = (callback) => {
      queue.push(callback);
    };
    const renderer = jest.fn(fakeRenderer);
    const prerenderer = createMermaidPrerenderer({ mermaidRenderer: renderer, scheduleIdle });

    const stale = prerenderer.prerender(MIXED_DOCUMENT);
    const fresh = prerenderer.prerender(MIXED_DOCUMENT);
    while (queue.length > 0) {
      queue.shift()?.();
    }
    const [staleResult, freshResult] = await Promise.all([stale, fresh]);

    expect(staleResult.aborted).toBe(true);
    expect(staleResult.assets).toEqual([]);
    expect(freshResult.aborted).toBe(false);
    expect(freshResult.assets).toHaveLength(1);
    // The superseded run must never invoke the DOM-bound engine: only the winner rendered.
    expect(renderer).toHaveBeenCalledTimes(1);
  });

  it('stops promptly on an aborted signal and emits nothing (cancellation)', async () => {
    const queue: Array<() => void> = [];
    const scheduleIdle: IdleScheduler = (callback) => {
      queue.push(callback);
    };
    const renderer = jest.fn(fakeRenderer);
    const prerenderer = createMermaidPrerenderer({ mermaidRenderer: renderer, scheduleIdle });
    const controller = new AbortController();

    const pending = prerenderer.prerender(MIXED_DOCUMENT, { signal: controller.signal });
    controller.abort();
    while (queue.length > 0) {
      queue.shift()?.();
    }
    const result = await pending;

    expect(result.aborted).toBe(true);
    expect(result.assets).toEqual([]);
    expect(renderer).not.toHaveBeenCalled();
  });

  it('records a diagnostic and emits no asset when a block fails to render', async () => {
    const prerenderer = createMermaidPrerenderer({ mermaidRenderer: failingRenderer, scheduleIdle: runNow });

    const result = await prerenderer.prerender(MIXED_DOCUMENT);

    expect(result.assets).toEqual([]);
    expect(result.diagnostics).toHaveLength(1);
    expect(result.diagnostics[0].message).toContain('bad diagram');
  });

  it('drives a real idle scheduler when none is injected', async () => {
    const prerenderer = createMermaidPrerenderer({ mermaidRenderer: fakeRenderer });

    const result = await prerenderer.prerender(MIXED_DOCUMENT);

    expect(result.assets).toHaveLength(1);
  });
});
