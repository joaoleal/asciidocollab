/**
 * The ordered pre-processing orchestrator. It sequences a set of injected {@link PipelineStage}s in a
 * FIXED order (each earlier stage rewrites the in-memory VFS that later stages read), threads a single
 * {@link StageContext} of injected seams through them, accumulates {@link RenderDiagnostic}s, and
 * cancels at a stage boundary the moment a staleness/cancel token trips (a superseded `requestId`).
 *
 * The orchestrator does NOT implement any stage — the concrete stages (include-resolve, citations,
 * diagrams-math, image-guard, mount-assets, convert) are supplied to it. It is pure with respect to
 * its injected seams, so it is fully unit-testable with in-memory fakes.
 */

import type { GeneratedAsset, PipelineStageKind, RenderDiagnostic, RenderRequest } from '../protocol';
import type { IncludeAssembler, ProjectFileReader } from '../ports/include-assembler';
import type {  ShimRegistry } from '../ports/shim';

// ---------------------------------------------------------------------------
// Injected seams the orchestrator threads through every stage.
// ---------------------------------------------------------------------------

/**
 * The narrow read/write surface over the in-memory `/project` VFS that stages share. A concrete
 * adapter (over the WASI bridge) is supplied at the composition root; stages program only against
 * this port so they stay environment-agnostic and testable with an in-memory map.
 */
export interface PipelineVfs {
  /**
   * Write raw bytes to an absolute VFS path, creating parent directories.
   *
   * @param path - The absolute VFS path the bytes are written to.
   * @param bytes - The raw content stored at that path.
   */
  writeFile(path: string, bytes: Uint8Array): void;
  /**
   * Read raw bytes from an absolute VFS path, or `null` if absent.
   *
   * @param path - The absolute VFS path to read.
   * @returns The stored bytes, or `null` when no file occupies that path.
   */
  readFile(path: string): Uint8Array | null;
  /**
   * Write UTF-8 text to an absolute VFS path.
   *
   * @param path - The absolute VFS path the text is written to.
   * @param content - The UTF-8 text stored at that path.
   */
  writeText(path: string, content: string): void;
  /**
   * Read UTF-8 text from an absolute VFS path, or `null` if absent.
   *
   * @param path - The absolute VFS path to read.
   * @returns The decoded UTF-8 text, or `null` when no file occupies that path.
   */
  readText(path: string): string | null;
  /**
   * Whether a file or directory exists at the given absolute path.
   *
   * @param path - The absolute path to probe for occupancy.
   * @returns `true` when a file or directory occupies that path.
   */
  exists(path: string): boolean;
  /**
   * Remove a file if present (no-op when absent).
   *
   * @param path - The absolute VFS path whose file is deleted.
   */
  remove(path: string): void;
  /**
   * List entries under a directory/prefix.
   *
   * @param path - The directory or path prefix whose entries are enumerated.
   * @returns The entry paths found beneath that directory.
   */
  list(path: string): readonly string[];
}

/**
 * The narrow content-addressed generated-asset cache port. The concrete store (logical-tick LRU) is
 * built separately; stages and the orchestrator depend only on this get/has/set surface so a hit on
 * an unchanged block's `sourceHash` skips re-rendering it.
 */
export interface AssetCachePort {
  /**
   * The cached asset for a `sourceHash`, or `undefined` on a miss.
   *
   * @param sourceHash - The content hash keying the block's cached render.
   * @returns The cached asset, or `undefined` when nothing is stored for that hash.
   */
  get(sourceHash: string): GeneratedAsset | undefined;
  /**
   * Whether an asset is cached for a `sourceHash`.
   *
   * @param sourceHash - The content hash to probe for a cached render.
   * @returns `true` when an asset is stored for that hash.
   */
  has(sourceHash: string): boolean;
  /**
   * Store an asset under its own `sourceHash`.
   *
   * @param asset - The generated asset cached under its own content hash.
   */
  set(asset: GeneratedAsset): void;
}

/** A sink stages push per-block/per-resource diagnostics into; the orchestrator reads the total. */
export interface DiagnosticsCollector {
  /**
   * Record one diagnostic.
   *
   * @param diagnostic - The per-resource warning or error appended to the collected set.
   */
  report(diagnostic: RenderDiagnostic): void;
  /**
   * Replay every diagnostic recorded so far.
   *
   * @returns The recorded diagnostics in report order.
   */
  all(): readonly RenderDiagnostic[];
}

/**
 * Build an in-memory {@link DiagnosticsCollector}.
 *
 * @returns A collector that appends reported diagnostics and replays them in report order.
 */
export function createDiagnosticsCollector(): DiagnosticsCollector {
  const collected: RenderDiagnostic[] = [];
  return {
    report: (diagnostic) => void collected.push(diagnostic),
    all: () => collected,
  };
}

/**
 * A read-only staleness/cancel signal checked at every stage boundary. It reports `true` once the
 * request it guards has been superseded by a newer `requestId`; the orchestrator then stops before
 * the next stage runs.
 */
export interface CancellationToken {
  /** Whether the guarded request has been cancelled/superseded. */
  readonly cancelled: boolean;
}

/** Wrap a predicate (e.g. "a newer requestId exists") as a lazily-evaluated {@link CancellationToken}. */
export function cancellationToken(isCancelled: () => boolean): CancellationToken {
  return {
    get cancelled(): boolean {
      return isCancelled();
    },
  };
}

/** Everything a stage needs, injected so the orchestrator stays pure and testable. */
export interface StageContext {
  /** The render request being served (id, mode, snapshot, changed paths, optimize flag). */
  readonly request: RenderRequest;
  /** Reads a project-relative source file's content, or `null` if unavailable. */
  readonly readFile: ProjectFileReader;
  /** The in-memory VFS the stages rewrite and the convert reads. */
  readonly vfs: PipelineVfs;
  /** The rendering shims (diagram/math/citations) supplied at the composition root. */
  readonly shims: ShimRegistry;
  /** The include-tree pre-expander (supplied concretely by the worker; a port here). */
  readonly includeAssembler: IncludeAssembler;
  /** The content-addressed generated-asset cache. */
  readonly cache: AssetCachePort;
  /** The diagnostics sink stages push per-resource warnings/errors into. */
  readonly diagnostics: DiagnosticsCollector;
  /** The staleness/cancel signal checked between stages. */
  readonly cancellation: CancellationToken;
}

/** What a stage returns: diagnostics it wishes to fold into the accumulated set (all optional). */
export interface StageResult {
  /** Per-resource/per-block diagnostics produced by this stage (never abort the pipeline). */
  readonly diagnostics?: readonly RenderDiagnostic[];
  /**
   * How many renders this stage performed fell back from SVG to a PNG raster. Reported as a count of
   * its own rather than derived from the diagnostics: the code those warnings carry
   * (`unsupported-image`) is shared with the image-guard stage's unsupported and oversized images,
   * so counting them would report failures that are not raster fallbacks at all. Absent means none.
   */
  readonly rasterFallbacks?: number;
}

/**
 * One ordered pre-processing step. Its {@link PipelineStage.kind} fixes where it runs in the pipeline;
 * `run` reads and rewrites the VFS through the injected {@link StageContext}.
 */
export interface PipelineStage {
  /** The stage's position in the fixed pipeline order. */
  readonly kind: PipelineStageKind;
  /**
   * Execute the stage against the shared context.
   *
   * @param context - The injected seams, VFS, and cancel signal the stage reads and rewrites.
   * @returns The diagnostics this stage folds into the accumulated set.
   */
  run(context: StageContext): Promise<StageResult>;
}

/**
 * A recoverable, per-block problem a stage may raise instead of returning. The orchestrator catches
 * it, records the carried diagnostic, and continues — so a single malformed block never aborts the
 * export. Any other thrown error is treated as a fatal, whole-render failure and propagates.
 */
export class StageDiagnosticError extends Error {
  /**
   * Carry the recoverable diagnostic so the orchestrator can record it and continue.
   *
   * @param diagnostic - The per-block problem surfaced without aborting the export.
   */
  constructor(readonly diagnostic: RenderDiagnostic) {
    super(diagnostic.message);
    this.name = 'StageDiagnosticError';
  }
}

/**
 * The fixed pipeline order (earlier stages rewrite the VFS later stages read). Anchored to the
 * {@link PipelineStageKind} literals so the runtime sequence and the compile-time union cannot drift;
 * the exhaustiveness guard below fails the build if a stage kind is missing.
 */
export const PIPELINE_STAGE_ORDER = Object.freeze([
  'include-resolve',
  'citations',
  'diagrams-math',
  'image-guard',
  'mount-assets',
  'convert',
] as const) satisfies readonly PipelineStageKind[];

/** Compile-time proof that {@link PIPELINE_STAGE_ORDER} covers every {@link PipelineStageKind}. */
type MissingStageKind = Exclude<PipelineStageKind, (typeof PIPELINE_STAGE_ORDER)[number]>;
const _exhaustiveStageOrder: MissingStageKind extends never ? true : never = true;
void _exhaustiveStageOrder;

/** The outcome of an orchestrator run. */
export interface OrchestratorResult {
  /** True only if every injected stage ran to completion (not cancelled). */
  readonly completed: boolean;
  /** True if the run stopped early because the cancel/staleness token tripped. */
  readonly cancelled: boolean;
  /** The stage kinds that actually ran, in execution order. */
  readonly ranStages: readonly PipelineStageKind[];
  /** All diagnostics accumulated across the run, in report order. */
  readonly diagnostics: readonly RenderDiagnostic[];
  /** How many renders fell back from SVG to a PNG raster, across every stage that ran. */
  readonly rasterFallbacks: number;
}

/**
 * Run the injected stages in the fixed {@link PIPELINE_STAGE_ORDER}, regardless of the order they were
 * registered in. Between every stage the cancel/staleness token is checked; a tripped token stops the
 * run before the next stage. Diagnostics returned by a stage, or raised as a {@link StageDiagnosticError},
 * are folded into the accumulated set without aborting. Any other thrown error propagates as fatal.
 */
export async function runPipeline(
  stages: readonly PipelineStage[],
  context: StageContext,
): Promise<OrchestratorResult> {
  const byKind = new Map<PipelineStageKind, PipelineStage>();
  for (const stage of stages) {
    byKind.set(stage.kind, stage);
  }

  const ranStages: PipelineStageKind[] = [];
  let cancelled = false;
  let rasterFallbacks = 0;

  for (const kind of PIPELINE_STAGE_ORDER) {
    const stage = byKind.get(kind);
    if (stage === undefined) {
      continue;
    }
    if (context.cancellation.cancelled) {
      cancelled = true;
      break;
    }
    let result: StageResult;
    try {
      result = await stage.run(context);
    } catch (error) {
      if (error instanceof StageDiagnosticError) {
        context.diagnostics.report(error.diagnostic);
        ranStages.push(kind);
        continue;
      }
      throw error;
    }
    for (const diagnostic of result.diagnostics ?? []) {
      context.diagnostics.report(diagnostic);
    }
    rasterFallbacks += result.rasterFallbacks ?? 0;
    ranStages.push(kind);
  }

  return {
    completed: !cancelled,
    cancelled,
    ranStages,
    diagnostics: context.diagnostics.all(),
    rasterFallbacks,
  };
}



export {type RenderShim} from '../ports/shim';