/**
 * Main-thread mermaid pre-pass for the in-browser PDF pipeline.
 *
 * Mermaid is the one diagram engine with no headless renderer: it needs a DOM, which the PDF Web Worker
 * does not have. So its diagrams are rendered HERE, on the main thread, and the resulting bytes are
 * pre-seeded into the worker's content-addressed cache before the `diagrams-math` stage runs. For that
 * hand-off to land, each asset's `sourceHash` must be BYTE-IDENTICAL to the one the worker stage computes
 * for the same block — otherwise the seed misses and the worker falls back to its DOM-less mermaid shim.
 *
 * Parity is guaranteed structurally rather than by copying constants: this module drives the exact same
 * {@link detectRenderableBlocks} detector, the exact same mermaid {@link createMermaidShim} (so both the
 * `version` fed to the hash and the emitted bytes come from one code path), and the exact same
 * {@link computeSourceHash} the stage uses — over the block's own `source` and `params` (which already
 * carry the synthetic `asciidoc-block-notation` param), untouched.
 *
 * The work is kept off the typing-critical path by design: it is idle-scheduled (one block per idle
 * slice, so it yields between blocks), coalesced (a newer invocation supersedes an in-flight one), and
 * cancellation-guarded (an aborted or superseded run stops at the next slice boundary and emits nothing).
 * The mermaid engine treats its source as inert data (strict, deterministic — see the shim), and nothing
 * here touches the network: the only side effect is rendering already-present source text.
 */

import {
  computeSourceHash,
  detectRenderableBlocks,
  type GeneratedAsset,
} from '@asciidocollab/asciidoc-pdf';

import { createMermaidShim, type MermaidRenderer } from '@/workers/shims/mermaid';

/** The diagram engine this pre-pass owns; every other engine renders headlessly in the worker. */
const MERMAID_NOTATION = 'mermaid';

/** The format the mermaid shim is asked for first (it never rasterizes; PNG is a math/vega fallback). */
const PREFERRED_FORMAT = 'svg' as const;

/** Mermaid diagrams are diagram assets in the generated-asset taxonomy. */
const DIAGRAM_KIND: GeneratedAsset['kind'] = 'diagram';

/** A per-block render failure, surfaced without aborting the rest of the pre-pass. */
export interface MermaidPrerenderDiagnostic {
  /** 1-based line of the block's attribute line, for editor surfacing. */
  readonly line: number;
  /** The shim's failure message. */
  readonly message: string;
}

/** The outcome of one pre-pass invocation. An aborted/superseded run always carries no assets. */
export interface MermaidPrerenderResult {
  /** The rendered mermaid assets, content-addressed for worker cache parity. */
  readonly assets: GeneratedAsset[];
  /** Per-block render failures (never thrown). */
  readonly diagnostics: MermaidPrerenderDiagnostic[];
  /** True when the run was superseded or its signal aborted; then `assets` is empty. */
  readonly aborted: boolean;
}

/**
 * Schedule a callback to run when the main thread is idle. Mirrors `requestIdleCallback`'s essential
 * shape (deadline omitted — the pre-pass slices by block, not by remaining idle time), so tests can
 * inject a deterministic scheduler without a real browser idle loop.
 */
export type IdleScheduler = (callback: () => void) => void;

/** Engine + scheduling seams; every unset seam uses its real (browser) implementation. */
export interface MermaidPrerendererDeps {
  /** Replaces the DOM-bound mermaid engine (unit tests inject a deterministic fake). */
  readonly mermaidRenderer?: MermaidRenderer;
  /** Replaces the idle scheduler (unit tests drive slices synchronously). */
  readonly scheduleIdle?: IdleScheduler;
}

/** Per-invocation options. */
export interface MermaidPrerenderRun {
  /** Aborts the run promptly at the next slice boundary; an aborted run emits nothing. */
  readonly signal?: AbortSignal;
}

/** A coalescing mermaid pre-pass: each invocation supersedes any still-in-flight one. */
export interface MermaidPrerenderer {
  /** Render the document's mermaid diagrams into content-addressed assets. */
  prerender(text: string, run?: MermaidPrerenderRun): Promise<MermaidPrerenderResult>;
}

/** The real idle scheduler: `requestIdleCallback` when present, else a macrotask fallback. */
const defaultScheduleIdle: IdleScheduler = (callback) => {
  const idle = (globalThis as { requestIdleCallback?: (cb: () => void) => unknown }).requestIdleCallback;
  if (typeof idle === 'function') {
    idle(callback);
  } else {
    setTimeout(callback, 0);
  }
};

/** Resolve once the scheduler grants an idle slice — the yield point between blocks. */
function waitForIdle(scheduleIdle: IdleScheduler): Promise<void> {
  return new Promise((resolve) => {
    scheduleIdle(() => resolve());
  });
}

/** An empty, aborted result — the single shape both supersession and cancellation return. */
function abortedResult(): MermaidPrerenderResult {
  return { assets: [], diagnostics: [], aborted: true };
}

/**
 * Build a coalescing, idle-scheduled mermaid pre-pass. State (the run token) lives in the closure so
 * that starting a new `prerender` supersedes any run still awaiting an idle slice.
 */
export function createMermaidPrerenderer(deps: MermaidPrerendererDeps = {}): MermaidPrerenderer {
  const scheduleIdle = deps.scheduleIdle ?? defaultScheduleIdle;
  // One shim instance is the single source of BOTH the hash `version` and the rendered bytes, so this
  // module can never drift from the worker stage's mermaid code path.
  const shim = createMermaidShim(deps.mermaidRenderer);
  let latestToken = 0;

  async function prerender(text: string, run?: MermaidPrerenderRun): Promise<MermaidPrerenderResult> {
    const token = (latestToken += 1);
    const signal = run?.signal;
    const isStale = (): boolean => token !== latestToken || signal?.aborted === true;

    const blocks = detectRenderableBlocks(text).filter(
      (block) => block.category === 'diagram' && block.notation === MERMAID_NOTATION,
    );

    const assets: GeneratedAsset[] = [];
    const diagnostics: MermaidPrerenderDiagnostic[] = [];

    for (const block of blocks) {
      await waitForIdle(scheduleIdle);
      if (isStale()) {
        return abortedResult();
      }

      const output = await shim.render({
        source: block.source,
        params: block.params,
        preferredFormat: PREFERRED_FORMAT,
      });
      if (isStale()) {
        return abortedResult();
      }
      if (!output.ok) {
        diagnostics.push({ line: block.line, message: output.diagnostic.message });
        continue;
      }

      assets.push({
        // Parity: same source + same params (untouched, incl. `asciidoc-block-notation`) + same shim
        // version the stage's renderOrReuse feeds computeSourceHash.
        sourceHash: computeSourceHash({
          source: block.source,
          renderParams: block.params,
          shimVersion: shim.version,
        }),
        kind: DIAGRAM_KIND,
        format: output.asset.format,
        bytes: output.asset.bytes,
        rasterFallback: output.asset.rasterFallback,
        altText: '',
      });
    }

    if (isStale()) {
      return abortedResult();
    }
    return { assets, diagnostics, aborted: false };
  }

  return { prerender };
}
