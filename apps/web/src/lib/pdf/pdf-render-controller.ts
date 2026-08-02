/**
 * @file The environment-agnostic PDF render controller: the testable core of the PDF Web Worker.
 *
 * It owns ALL of the worker's message-handling logic (warmup, render, cancel) but touches no browser
 * API, wasm module, or interop library directly — every collaborator is injected through
 * {@link PdfRenderControllerDeps}. The worker composition root supplies the concrete adapters (warm VM,
 * VFS population, convert invocation, the ordered pre-processing pipeline, the app's sandbox path
 * boundary and include assembler, the generated-asset cache, and the outbound `postMessage`); unit
 * tests supply in-memory fakes. This keeps the wiring fully unit-testable and the DOM/wasm surface
 * confined to the thin worker entry.
 *
 * The controller enforces the protocol's guarantees: a staleness guard (only the latest `requestId`
 * per mode is honored; superseded renders are discarded at the next boundary), an ordered progress
 * signal at each phase boundary, per-resource diagnostics folded into a successful result (with the
 * convert path's optimize notice normalized into a proper diagnostic), and a structured, non-thrown
 * error for a whole-render failure. It performs no I/O of its own — all of that is injected.
 */

import {
  cancellationToken,
  createDiagnosticsCollector,
  isDiagnosticCode,
  runPipeline,
} from '@asciidocollab/asciidoc-pdf';
import type {
  AssetCachePort,
  CancellationToken,
  DiagnosticsCollector,
  DiagnosticCode,
  DiagnosticSeverity,
  FromWorker,
  GeneratedAsset,
  IncludeAssembler,
  PdfRenderStages,
  PdfSourceMap,
  PdfVmStages,
  PipelineStage,
  PipelineStageKind,
  PopulateResult,
  ProjectSnapshot,
  RenderDiagnostic,
  RenderError,
  RenderErrorPhase,
  RenderMode,
  RenderPhase,
  RenderRequest,
  RenderResult,
  RenderStats,
  RubyPdfVm,
  SandboxPathResolver,
  StageContext,
  ToWorker,
} from '@asciidocollab/asciidoc-pdf';

// ---------------------------------------------------------------------------
// Named constants (no magic strings scattered through the logic).
// ---------------------------------------------------------------------------

/** Inbound message discriminators. */
const MESSAGE_TYPE = { RENDER: 'render', CANCEL: 'cancel', WARMUP: 'warmup' } as const;

/** Outbound message discriminators. */
const OUTBOUND = { PROGRESS: 'progress', RESULT: 'result', ERROR: 'error' } as const;

/** The progress phases emitted at each stage boundary. */
const PHASE = {
  VM_INIT: 'vm-init',
  PREPROCESSING: 'preprocessing',
  CONVERTING: 'converting',
  OPTIMIZING: 'optimizing',
  DONE: 'done',
} as const satisfies Record<string, RenderPhase>;

/** The pipeline-stage kinds that surface their own distinct progress phase. */
const STAGE_PROGRESS = {
  citations: 'citations',
  'diagrams-math': 'diagrams-math',
} as const satisfies Partial<Record<PipelineStageKind, RenderPhase>>;

/** Whole-render (fatal) failure phases this controller can originate. */
const ERROR_PHASE = { PREPROCESSING: 'preprocessing' } as const satisfies Record<string, RenderErrorPhase>;

/** Stable machine code for a snapshot whose root document never made it into the VFS. */
const ROOT_MISSING_CODE = 'root-missing';

/** The diagnostic code a normalized optimize notice carries. */
const OPTIMIZE_UNAVAILABLE_CODE: DiagnosticCode = 'optimize-unavailable';

/** Correlation id used for a bare `warmup` message's `vm-init` progress (no render is in flight). */
const WARMUP_REQUEST_ID = 'warmup';

// ---------------------------------------------------------------------------
// Injected-collaborator contract.
// ---------------------------------------------------------------------------

/**
 * A non-fatal engine notice that is not itself a full {@link RenderDiagnostic} (it lacks a per-resource
 * `resource`) — e.g. The convert path's "optimize skipped" notice. The controller normalizes it into a
 * proper diagnostic before it rides out in a result.
 */
export interface ConvertNotice {
  /** The non-fatal severity the engine attached to the notice. */
  readonly severity: DiagnosticSeverity;
  /** The engine's own code for the notice, promoted to an enumerated diagnostic code downstream. */
  readonly code: string;
  /** The human-readable notice text carried through into the normalized diagnostic. */
  readonly message: string;
}

/** A diagnostic the convert path may surface: an already-shaped diagnostic, or an engine notice. */
export type ConvertDiagnosticInput = RenderDiagnostic | ConvertNotice;

/** The outcome of the injected convert invocation — a rendered PDF (with diagnostics) or a fatal error. */
export type ConvertOutcome =
  | {
      readonly ok: true;
      readonly pdf: Blob;
      readonly bytes: Uint8Array;
      readonly diagnostics: readonly ConvertDiagnosticInput[];
      /** The engine-emitted block source map for scroll sync, when the convert produced one. */
      readonly sourceMap?: PdfSourceMap;
      /** What the stages inside the render VM cost, when the convert was able to measure them. */
      readonly vmStages?: PdfVmStages;
    }
  | { readonly ok: false; readonly error: RenderError };

/** The controller-owned inputs handed to {@link PdfRenderControllerDeps.buildPipeline}. */
export interface BuildPipelineArguments {
  /** The render request being served. */
  readonly request: RenderRequest;
  /** The staleness/cancel signal checked between stages. */
  readonly cancellation: CancellationToken;
  /** The diagnostics sink shared with the orchestrator. */
  readonly diagnostics: DiagnosticsCollector;
  /** The generated-asset cache (already wrapped to count hits for stats). */
  readonly cache: AssetCachePort;
  /** The concrete include assembler supplied at the composition root. */
  readonly includeAssembler: IncludeAssembler;
  /** The app's sandbox path boundary threaded into the include-resolve stage. */
  readonly resolveSandboxedPath: SandboxPathResolver;
}

/** The assembled, ordered pipeline: the stages to run and the context to thread through them. */
export interface BuiltPipeline {
  /** The ordered stages the controller runs for the request. */
  readonly stages: readonly PipelineStage[];
  /** The shared context threaded through every stage. */
  readonly context: StageContext;
}

/** Everything the controller needs, injected so it stays environment-agnostic and unit-testable. */
export interface PdfRenderControllerDeps {
  /** The warm-VM facade; the controller only warms it (convert/populate close over it themselves). */
  readonly vm: Pick<RubyPdfVm, 'warmup'>;
  /**
   * Map the snapshot into the in-memory `/project` VFS.
   *
   * @param snapshot - The project snapshot to write into the virtual filesystem.
   * @param changedPaths - The paths that changed since the last populate. A delta-only write is
   *   possible only against a VFS that still holds the project; the render VM the pipeline uses hands
   *   each render an empty filesystem, so the population upgrades a delta to a full write.
   */
  readonly populate: (snapshot: ProjectSnapshot, changedPaths?: readonly string[]) => PopulateResult;
  /**
   * Drive the Ruby convert for a request and return the rendered PDF (or a structured failure).
   *
   * @param request - The render request to convert.
   */
  readonly runConvert: (request: RenderRequest) => Promise<ConvertOutcome>;
  /**
   * Assemble the ordered pipeline (stages + context) for a request.
   *
   * @param arguments_ - The controller-owned inputs for the request.
   */
  readonly buildPipeline: (arguments_: BuildPipelineArguments) => BuiltPipeline;
  /** The app's sandbox path boundary (Constitution IX), passed through to the pipeline. */
  readonly resolveSandboxedPath: SandboxPathResolver;
  /** Build the concrete include assembler (wraps the shared assembly primitive). */
  readonly buildIncludeAssembler: () => IncludeAssembler;
  /** The content-addressed generated-asset cache. */
  readonly cache: AssetCachePort;
  /**
   * Post a message back to the main thread.
   *
   * @param message - The worker-to-main message to post.
   */
  readonly postMessage: (message: FromWorker) => void;
  /** Monotonic clock for stats; defaults to {@link Date.now}. Injected for deterministic tests. */
  readonly now?: () => number;
}

// ---------------------------------------------------------------------------
// Helpers.
// ---------------------------------------------------------------------------

/** A cache wrapper that counts hits so the render stats can report them. */
interface CountingCache {
  readonly port: AssetCachePort;
  hits(): number;
}

function createCountingCache(inner: AssetCachePort): CountingCache {
  let hits = 0;
  return {
    port: {
      get: (sourceHash: string): GeneratedAsset | undefined => {
        const asset = inner.get(sourceHash);
        if (asset !== undefined) {
          hits += 1;
        }
        return asset;
      },
      has: (sourceHash: string): boolean => inner.has(sourceHash),
      set: (asset: GeneratedAsset): void => inner.set(asset),
    },
    hits: (): number => hits,
  };
}

/**
 * Normalize a convert diagnostic into a proper {@link RenderDiagnostic}. An already-shaped diagnostic
 * (carrying a `resource` and an enumerated code) passes through unchanged; anything else is an engine
 * notice and is promoted to a full diagnostic pinned to the document root with the optimize-unavailable
 * code.
 */
function normalizeConvertDiagnostic(
  diagnostic: ConvertDiagnosticInput,
  resource: string,
): RenderDiagnostic {
  if ('resource' in diagnostic && typeof diagnostic.resource === 'string' && isDiagnosticCode(diagnostic.code)) {
    return diagnostic;
  }
  return {
    severity: diagnostic.severity,
    code: OPTIMIZE_UNAVAILABLE_CODE,
    resource,
    message: diagnostic.message,
  };
}

// ---------------------------------------------------------------------------
// Controller.
// ---------------------------------------------------------------------------

/**
 * The testable message-handling core of the PDF Web Worker. One instance is long-lived per worker; it
 * routes each inbound {@link ToWorker} message to the matching handler and drives the render pipeline
 * through its injected collaborators.
 */
export class PdfRenderController {
  /** The latest `requestId` accepted for each mode; anything older is superseded. */
  private readonly latestByMode = new Map<RenderMode, string>();

  /** Explicitly cancelled request ids (best-effort supersede via a `cancel` message). */
  private readonly cancelled = new Set<string>();

  private readonly now: () => number;

  /**
   * Create a controller over its injected collaborators.
   *
   * @param deps - The collaborators the controller drives the render pipeline through.
   */
  constructor(private readonly deps: PdfRenderControllerDeps) {
    this.now = deps.now ?? ((): number => Date.now());
  }

  /** Route one inbound message to its handler. */
  async handleMessage(message: ToWorker): Promise<void> {
    switch (message.type) {
      case MESSAGE_TYPE.WARMUP: {
        await this.handleWarmup();
        return;
      }
      case MESSAGE_TYPE.RENDER: {
        await this.handleRender(message.request);
        return;
      }
      case MESSAGE_TYPE.CANCEL: {
        this.cancelled.add(message.requestId);
        return;
      }
    }
  }

  /** Instantiate the VM ahead of the first render; announce `vm-init` for the engine's own start-up. */
  private async handleWarmup(): Promise<void> {
    const { firstBoot } = await this.deps.vm.warmup();
    if (firstBoot) {
      this.emitProgress(WARMUP_REQUEST_ID, PHASE.VM_INIT);
    }
  }

  /** Serve a render request end to end, discarding it the moment a newer request supersedes it. */
  private async handleRender(request: RenderRequest): Promise<void> {
    const { requestId, mode, snapshot, changedPaths, optimize } = request;
    this.latestByMode.set(mode, requestId);
    const startedAt = this.now();

    // Warm the VM. A VM instance serves one render, so all but the first render of a session get a
    // freshly instantiated one here — booting is the normal case, and the two figures below say
    // different things about it.
    const warmupStartedAt = this.now();
    const { booted, firstBoot } = await this.deps.vm.warmup();
    // What THIS render paid to have a VM. `0` when it reused an instance a pre-warm had already booted;
    // otherwise the real instantiation cost, which the breakdown carries on every render that pays it.
    const vmBootMs = booted ? this.now() - warmupStartedAt : 0;
    // What starting the engine cost, reported once per session. Every other boot is a replacement for a
    // spent instance, which is `vmBootMs` — calling it a cold start would claim the engine keeps
    // restarting.
    const coldStartMs = firstBoot ? vmBootMs : undefined;
    // Announced only for the engine's own start-up. The author waits for that one; the per-render
    // replacement is machinery they never asked about, and a "starting the engine" notice on every edit
    // describes a session that is perpetually booting.
    if (firstBoot) {
      this.emitProgress(requestId, PHASE.VM_INIT);
    }
    if (this.isSuperseded(request)) {
      return;
    }

    // Map the snapshot into the VFS; a missing root is a fatal, structured failure.
    const populateStartedAt = this.now();
    const populated = this.deps.populate(snapshot, changedPaths);
    const populateMs = this.now() - populateStartedAt;
    if (!populated.rootPresent) {
      this.postError({
        requestId,
        phase: ERROR_PHASE.PREPROCESSING,
        code: ROOT_MISSING_CODE,
        message: 'The root document is missing from the project snapshot.',
      });
      return;
    }

    // Run the available pre-processing stages in their fixed order.
    this.emitProgress(requestId, PHASE.PREPROCESSING);
    const diagnostics = createDiagnosticsCollector();
    const cancellation = cancellationToken(() => this.isSuperseded(request));
    const countingCache = createCountingCache(this.deps.cache);
    const pipeline = this.deps.buildPipeline({
      request,
      cancellation,
      diagnostics,
      cache: countingCache.port,
      includeAssembler: this.deps.buildIncludeAssembler(),
      resolveSandboxedPath: this.deps.resolveSandboxedPath,
    });
    const pipelineStartedAt = this.now();
    const pipelineOutcome = await runPipeline(pipeline.stages, pipeline.context);
    const pipelineMs = this.now() - pipelineStartedAt;
    if (this.isSuperseded(request) || pipelineOutcome.cancelled) {
      return;
    }
    // A stage that produced a distinct progress phase (citations, diagrams-math) reports it now, in
    // pipeline order; stages without a distinct phase are folded into `preprocessing`.
    for (const kind of pipelineOutcome.ranStages) {
      const phase = stageProgressPhase(kind);
      if (phase !== undefined) {
        this.emitProgress(requestId, phase);
      }
    }

    // Convert.
    this.emitProgress(requestId, PHASE.CONVERTING);
    const convertStartedAt = this.now();
    const converted = await this.deps.runConvert(request);
    const convertMs = this.now() - convertStartedAt;
    if (this.isSuperseded(request)) {
      return;
    }
    if (!converted.ok) {
      this.postError(converted.error);
      return;
    }
    if (optimize) {
      this.emitProgress(requestId, PHASE.OPTIMIZING);
    }

    // Fold pipeline + convert diagnostics (normalizing any engine notice) into the result.
    const normalized = converted.diagnostics.map((diagnostic) =>
      normalizeConvertDiagnostic(diagnostic, snapshot.rootPath),
    );
    const allDiagnostics: readonly RenderDiagnostic[] = [...pipelineOutcome.diagnostics, ...normalized];
    // The in-VM figures sit INSIDE `convertMs` — they subdivide it rather than adding to it, which is
    // why they are spread into the same breakdown instead of being reported beside it. A convert that
    // measured none simply contributes no keys.
    const stages: PdfRenderStages = {
      vmBootMs,
      populateMs,
      pipelineMs,
      convertMs,
      ...converted.vmStages,
    };
    const stats: RenderStats = {
      renderMs: this.now() - startedAt,
      stages,
      cacheHits: countingCache.hits(),
      // Counted by the stage that does the rendering. It was reported as a flat `0` for as long as
      // the field existed, which reads as "nothing rasterized" — a claim about the render rather
      // than the absence of one.
      rasterFallbacks: pipelineOutcome.rasterFallbacks,
      ...(coldStartMs === undefined ? {} : { coldStartMs }),
    };

    this.emitProgress(requestId, PHASE.DONE);
    const result: RenderResult = {
      requestId,
      mode,
      pdf: converted.pdf,
      diagnostics: allDiagnostics,
      stats,
      ...(converted.sourceMap === undefined ? {} : { sourceMap: converted.sourceMap }),
    };
    this.deps.postMessage({ type: OUTBOUND.RESULT, result });
  }

  /** Whether `request` has been superseded by a newer request for its mode, or explicitly cancelled. */
  private isSuperseded(request: RenderRequest): boolean {
    return (
      this.latestByMode.get(request.mode) !== request.requestId || this.cancelled.has(request.requestId)
    );
  }

  private emitProgress(requestId: string, phase: RenderPhase): void {
    this.deps.postMessage({ type: OUTBOUND.PROGRESS, requestId, phase });
  }

  private postError(error: RenderError): void {
    this.deps.postMessage({ type: OUTBOUND.ERROR, error });
  }
}

/** The distinct progress phase a stage kind surfaces, or `undefined` when it folds into another phase. */
function stageProgressPhase(kind: PipelineStageKind): RenderPhase | undefined {
  const map: Partial<Record<PipelineStageKind, RenderPhase>> = STAGE_PROGRESS;
  return map[kind];
}
