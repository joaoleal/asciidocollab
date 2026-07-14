/**
 * Responsiveness budget for the main-thread mermaid pre-pass.
 *
 * The pre-pass renders mermaid diagrams on the typing thread (mermaid needs a DOM the PDF worker
 * lacks). To keep typing fluid while a worst-case diagram renders, two budgets must hold:
 *
 *  - the pre-pass must YIELD to the main thread at least every 50 ms, so no single synchronous chunk
 *    of pre-pass work between yields exceeds the 50 ms slice ceiling; and
 *  - an editor keystroke arriving mid-render must be serviced (input handler + editor state update)
 *    within the 100 ms interaction budget, even while the pre-pass is running.
 *
 * A real wall-clock timing test is flaky on shared CI. Instead this drives the prerenderer's injectable
 * seams over a VIRTUAL clock: the injected `mermaidRenderer` models a heavy render by ADVANCING the
 * clock (never burning CPU), and each injected `scheduleIdle` grant is the point where the event loop
 * could service other work — the yield boundary. The budgets are then asserted against that virtual
 * clock, fully deterministically.
 */

import { detectRenderableBlocks } from '@asciidocollab/asciidoc-pdf';

import { createMermaidPrerenderer, type IdleScheduler } from '@/lib/pdf/prerender-mermaid';
import type { MermaidRenderer } from '@/workers/shims/mermaid';

/** The main thread must yield at least this often; no un-yielded pre-pass chunk may exceed it. */
const SLICE_CEILING_MS = 50;
/** A keystroke must be serviced within this budget (RAIL interaction target). */
const INTERACTION_BUDGET_MS = 100;
/**
 * The modelled synchronous cost of one worst-case mermaid diagram render. Kept just under the slice
 * ceiling: a single diagram is the pre-pass's INDIVISIBLE unit of work (it yields between blocks, never
 * within one), so the ceiling can hold only while one diagram renders within it.
 */
const WORST_CASE_BLOCK_MS = 45;
/** The modelled cost of servicing one keystroke: input handler + editor state update. */
const KEYSTROKE_HANDLER_MS = 8;

/** A document with `count` mermaid diagrams (and nothing else the pre-pass would touch). */
function documentWithMermaidBlocks(count: number): string {
  const lines = ['= Title', ''];
  for (let index = 0; index < count; index += 1) {
    lines.push('[mermaid]', '----', `graph TD; A${index}-->B${index}`, '----', '');
  }
  return lines.join('\n');
}

describe('mermaid pre-pass responsiveness', () => {
  it('yields to the main thread within the 50ms slice ceiling, never batching diagrams into one chunk', async () => {
    // Enough diagrams that, WITHOUT per-block yielding, one synchronous chunk would be many times the
    // ceiling (8 * 45 = 360 ms) — so a passing assertion proves the pre-pass yields between every block.
    const blockCount = 8;
    const document = documentWithMermaidBlocks(blockCount);
    expect(detectRenderableBlocks(document)).toHaveLength(blockCount);

    let now = 0;
    // The virtual clock value at each yield boundary (each idle grant), in order.
    const yieldBoundaries: number[] = [];
    const scheduleIdle: IdleScheduler = (callback) => {
      yieldBoundaries.push(now);
      callback();
    };
    // A worst-case render: advance the virtual clock instead of burning CPU.
    const mermaidRenderer: MermaidRenderer = async () => {
      now += WORST_CASE_BLOCK_MS;
      return '<svg></svg>';
    };

    const prerenderer = createMermaidPrerenderer({ mermaidRenderer, scheduleIdle });
    const result = await prerenderer.prerender(document);

    expect(result.aborted).toBe(false);
    expect(result.assets).toHaveLength(blockCount);
    // The pre-pass yielded before every block (one grant per diagram).
    expect(yieldBoundaries).toHaveLength(blockCount);

    // Every synchronous chunk between consecutive yields — plus the trailing chunk after the last yield
    // up to completion — is exactly one diagram's render, and stays within the slice ceiling.
    const chunkBoundaries = [...yieldBoundaries, now];
    const chunks = chunkBoundaries
      .slice(1)
      .map((boundary, index) => boundary - chunkBoundaries[index]);
    for (const chunk of chunks) {
      expect(chunk).toBeLessThanOrEqual(SLICE_CEILING_MS);
    }
    // Sanity: the total pre-pass work vastly exceeds the ceiling, so the per-chunk bound is meaningful
    // only because the pre-pass yields between diagrams rather than running them as one chunk.
    const totalWork = chunks.reduce((sum, chunk) => sum + chunk, 0);
    expect(totalWork).toBeGreaterThan(SLICE_CEILING_MS);
  });

  it('services an editor keystroke within the 100ms interaction budget while diagrams pre-render', async () => {
    const document = documentWithMermaidBlocks(4);

    let now = 0;
    let renderCount = 0;
    // A keystroke that arrives mid-render and can only be serviced at the next yield boundary.
    const keystroke: { arrivedAt: number; servicedAt: number | undefined } = {
      arrivedAt: Number.NaN,
      servicedAt: undefined,
    };

    const scheduleIdle: IdleScheduler = (callback) => {
      // At a yield boundary the event loop services a pending keystroke before resuming idle work.
      const pending =
        !Number.isNaN(keystroke.arrivedAt) &&
        keystroke.servicedAt === undefined &&
        keystroke.arrivedAt <= now;
      if (pending) {
        now += KEYSTROKE_HANDLER_MS; // input handler + editor state update
        keystroke.servicedAt = now;
      }
      callback();
    };
    const mermaidRenderer: MermaidRenderer = async () => {
      renderCount += 1;
      // Worst case: the keystroke lands just as a diagram's synchronous render begins, so it must wait
      // the whole (un-yieldable) block before the next boundary can service it.
      if (renderCount === 2 && Number.isNaN(keystroke.arrivedAt)) {
        keystroke.arrivedAt = now;
      }
      now += WORST_CASE_BLOCK_MS;
      return '<svg></svg>';
    };

    const prerenderer = createMermaidPrerenderer({ mermaidRenderer, scheduleIdle });
    await prerenderer.prerender(document);

    expect(keystroke.servicedAt).toBeDefined();
    const responseTime = (keystroke.servicedAt as number) - keystroke.arrivedAt;
    expect(responseTime).toBeGreaterThan(0);
    expect(responseTime).toBeLessThanOrEqual(INTERACTION_BUDGET_MS);
    // The worst-case wait is bounded by one diagram's render plus the keystroke handler.
    expect(responseTime).toBeLessThanOrEqual(WORST_CASE_BLOCK_MS + KEYSTROKE_HANDLER_MS);
  });

  it('adds no batching overhead: a single diagram render is the pre-pass indivisible slice', async () => {
    // The pre-pass yields between blocks, never within one, so a lone diagram's chunk is exactly its own
    // render cost — the pre-pass contributes no extra un-yielded work. The ceiling therefore holds only
    // as long as a single diagram renders within it (the pre-pass cannot subdivide one block).
    const document = documentWithMermaidBlocks(1);

    let now = 0;
    const yieldBoundaries: number[] = [];
    const scheduleIdle: IdleScheduler = (callback) => {
      yieldBoundaries.push(now);
      callback();
    };
    const mermaidRenderer: MermaidRenderer = async () => {
      now += WORST_CASE_BLOCK_MS;
      return '<svg></svg>';
    };

    const prerenderer = createMermaidPrerenderer({ mermaidRenderer, scheduleIdle });
    await prerenderer.prerender(document);

    expect(yieldBoundaries).toEqual([0]);
    const soleChunk = now - yieldBoundaries[0];
    expect(soleChunk).toBe(WORST_CASE_BLOCK_MS);
    expect(soleChunk).toBeLessThanOrEqual(SLICE_CEILING_MS);
  });
});
