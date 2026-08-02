import {
  PdfRenderController,
  type BuildPipelineArguments,
  type BuiltPipeline,
  type ConvertOutcome,
  type PdfRenderControllerDeps,
} from '@/lib/pdf/pdf-render-controller';
import type {
  AssetCachePort,
  FromWorker,
  GeneratedAsset,
  IncludeAssembler,
  PipelineStage,
  PipelineVfs,
  ProjectSnapshot,
  RenderDiagnostic,
  RenderRequest,
  RenderResult,
  ShimRegistry,
  StageContext,
  WarmupOutcome,
} from '@asciidocollab/asciidoc-pdf';

// ---------------------------------------------------------------------------
// Deferred helper for the staleness/supersession test.
// ---------------------------------------------------------------------------

interface Deferred<T> {
  readonly promise: Promise<T>;
  resolve(value: T): void;
}

function deferred<T>(): Deferred<T> {
  // The Promise executor runs synchronously, so `resolveFunction` is always assigned before use;
  // the definite-assignment `!` avoids a throwaway placeholder arrow.
  let resolveFunction!: (value: T) => void;
  const promise = new Promise<T>((resolve) => {
    resolveFunction = resolve;
  });
  return { promise, resolve: resolveFunction };
}

/** Flush both microtasks and the macrotask queue so parked awaits make progress. */
const flush = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0));

// ---------------------------------------------------------------------------
// In-memory fakes for every injected collaborator.
// ---------------------------------------------------------------------------

const ROOT_PATH = 'main.adoc';

function makeSnapshot(): ProjectSnapshot {
  return {
    files: { [ROOT_PATH]: '= Title\n\nBody' },
    binaryAssets: {},
    rootPath: ROOT_PATH,
    openPath: ROOT_PATH,
    fontPaths: [],
    attributes: {},
  };
}

function makeRequest(overrides: Partial<RenderRequest> = {}): RenderRequest {
  return {
    requestId: 'r1',
    mode: 'export',
    snapshot: makeSnapshot(),
    optimize: true,
    ...overrides,
  };
}

const fakeCache: AssetCachePort = {
  get: () => undefined,
  has: () => false,
  set: () => undefined,
};

const fakeVfs: PipelineVfs = {
  writeFile: () => undefined,
  readFile: () => null,
  writeText: () => undefined,
  readText: () => null,
  exists: () => false,
  remove: () => undefined,
  list: () => [],
};

const fakeShims: ShimRegistry = {
  byName: () => undefined,
  byKind: () => [],
};

const fakeIncludeAssembler: IncludeAssembler = {
  assemble: (request) => ({ content: request.readFile(request.rootPath) ?? '', unresolved: [] }),
};

/** A fake `buildPipeline` that runs no stages but threads the controller-owned context through. */
function makeBuildPipeline(arguments_: BuildPipelineArguments): BuiltPipeline {
  const context: StageContext = {
    request: arguments_.request,
    readFile: (path) => arguments_.request.snapshot.files[path] ?? null,
    vfs: fakeVfs,
    shims: fakeShims,
    includeAssembler: arguments_.includeAssembler,
    cache: arguments_.cache,
    diagnostics: arguments_.diagnostics,
    cancellation: arguments_.cancellation,
  };
  return { stages: [], context };
}

interface Harness {
  readonly controller: PdfRenderController;
  readonly messages: FromWorker[];
  readonly warmupCalls: () => number;
}

/** The engine starting up: the session's one announced boot. */
const ENGINE_START: WarmupOutcome = { booted: true, firstBoot: true };
/** The replacement instance a render gets once the engine is already running. */
const REPLACEMENT_BOOT: WarmupOutcome = { booted: true, firstBoot: false };
/** A warmup that handed back an instance someone else had already booted. */
const NO_BOOT: WarmupOutcome = { booted: false, firstBoot: false };

function makeHarness(
  overrides: Partial<PdfRenderControllerDeps> = {},
  warmupOutcomes: WarmupOutcome[] = [ENGINE_START],
): Harness {
  const messages: FromWorker[] = [];
  let warmups = 0;
  const queue = [...warmupOutcomes];

  const deps: PdfRenderControllerDeps = {
    vm: {
      warmup: () => {
        warmups += 1;
        return Promise.resolve(queue.shift() ?? NO_BOOT);
      },
    },
    populate: () => ({ written: [], rejected: [], rootPresent: true }),
    runConvert: () =>
      Promise.resolve<ConvertOutcome>({
        ok: true,
        pdf: new Blob([new Uint8Array([1, 2, 3])], { type: 'application/pdf' }),
        bytes: new Uint8Array([1, 2, 3]),
        diagnostics: [],
      }),
    buildPipeline: makeBuildPipeline,
    resolveSandboxedPath: (_from, target) => ({ ok: true, path: target }),
    buildIncludeAssembler: () => fakeIncludeAssembler,
    cache: fakeCache,
    postMessage: (message) => void messages.push(message),
    ...overrides,
  };

  return { controller: new PdfRenderController(deps), messages, warmupCalls: () => warmups };
}

const progressPhases = (messages: readonly FromWorker[]): string[] =>
  messages.filter((m) => m.type === 'progress').map((m) => m.phase);

const results = (messages: readonly FromWorker[]): RenderResult[] =>
  messages.filter((m): m is Extract<FromWorker, { type: 'result' }> => m.type === 'result').map((m) => m.result);

// ---------------------------------------------------------------------------
// Tests.
// ---------------------------------------------------------------------------

describe('PdfRenderController', () => {
  it('warms the VM once and emits vm-init progress only on the real cold start', async () => {
    const { controller, messages, warmupCalls } = makeHarness({}, [ENGINE_START, NO_BOOT]);

    await controller.handleMessage({ type: 'warmup' });
    await controller.handleMessage({ type: 'warmup' });

    expect(warmupCalls()).toBe(2);
    const vmInit = messages.filter((m) => m.type === 'progress' && m.phase === 'vm-init');
    expect(vmInit).toHaveLength(1);
    // No stray result/error emitted by a bare warmup.
    expect(messages.filter((m) => m.type === 'result' || m.type === 'error')).toHaveLength(0);
  });

  it('emits ordered progress then a result carrying the pdf and normalized diagnostics', async () => {
    const properDiagnostic: RenderDiagnostic = {
      severity: 'warning',
      code: 'missing-glyph',
      resource: ROOT_PATH,
      message: 'A glyph is missing.',
    };
    const optimizeNotice = {
      severity: 'warning' as const,
      code: 'optimize-unavailable',
      message: 'PDF optimization skipped: the optimizer is unavailable.',
    };
    const pdf = new Blob([new Uint8Array([9, 9, 9])], { type: 'application/pdf' });

    const { controller, messages } = makeHarness({
      runConvert: () =>
        Promise.resolve<ConvertOutcome>({
          ok: true,
          pdf,
          bytes: new Uint8Array([9, 9, 9]),
          diagnostics: [properDiagnostic, optimizeNotice],
        }),
    });

    await controller.handleMessage({ type: 'render', request: makeRequest({ optimize: true }) });

    expect(progressPhases(messages)).toEqual([
      'vm-init',
      'preprocessing',
      'converting',
      'optimizing',
      'done',
    ]);

    const posted = results(messages);
    expect(posted).toHaveLength(1);
    const result = posted[0];
    expect(result.pdf).toBe(pdf);
    expect(result.requestId).toBe('r1');
    expect(result.mode).toBe('export');
    expect(typeof result.stats.renderMs).toBe('number');
    expect(result.stats.coldStartMs).toBeDefined();

    // The proper diagnostic passes through unchanged; the notice is normalized into a full diagnostic.
    expect(result.diagnostics).toEqual([
      properDiagnostic,
      {
        severity: 'warning',
        code: 'optimize-unavailable',
        resource: ROOT_PATH,
        message: optimizeNotice.message,
      },
    ]);
  });

  it('threads the convert source map onto the posted result, and omits it when absent', async () => {
    const sourceMap = [
      { line: 1, page: 1, yFraction: 0 },
      { line: 8, page: 1, yFraction: 0.4 },
    ];
    const withMap = makeHarness({
      runConvert: () =>
        Promise.resolve<ConvertOutcome>({
          ok: true,
          pdf: new Blob([new Uint8Array([1])], { type: 'application/pdf' }),
          bytes: new Uint8Array([1]),
          diagnostics: [],
          sourceMap,
        }),
    });
    await withMap.controller.handleMessage({ type: 'render', request: makeRequest() });
    expect(results(withMap.messages)[0].sourceMap).toEqual(sourceMap);

    // A convert that emits no map leaves the field off the result entirely (backward compatible).
    const withoutMap = makeHarness();
    await withoutMap.controller.handleMessage({ type: 'render', request: makeRequest() });
    expect(results(withoutMap.messages)[0].sourceMap).toBeUndefined();
  });

  it('skips the optimizing phase when the request opts out of optimization', async () => {
    const { controller, messages } = makeHarness();

    await controller.handleMessage({ type: 'render', request: makeRequest({ optimize: false }) });

    expect(progressPhases(messages)).toEqual(['vm-init', 'preprocessing', 'converting', 'done']);
  });

  it('discards a superseded render so no stale result is posted', async () => {
    const pending = deferred<ConvertOutcome>();
    const { controller, messages } = makeHarness(
      {
        runConvert: (request) =>
          request.requestId === 'A'
            ? pending.promise
            : Promise.resolve<ConvertOutcome>({
                ok: true,
                pdf: new Blob([new Uint8Array([2])], { type: 'application/pdf' }),
                bytes: new Uint8Array([2]),
                diagnostics: [],
              }),
      },
      [NO_BOOT, NO_BOOT],
    );

    const pA = controller.handleMessage({
      type: 'render',
      request: makeRequest({ requestId: 'A', mode: 'export' }),
    });
    // Let A run up to its parked `await runConvert`.
    await flush();

    const pB = controller.handleMessage({
      type: 'render',
      request: makeRequest({ requestId: 'B', mode: 'export' }),
    });
    await pB;

    // Now release A's convert; it must notice it was superseded and post nothing.
    pending.resolve({
      ok: true,
      pdf: new Blob([new Uint8Array([1])], { type: 'application/pdf' }),
      bytes: new Uint8Array([1]),
      diagnostics: [],
    });
    await pA;

    const posted = results(messages);
    expect(posted).toHaveLength(1);
    expect(posted[0].requestId).toBe('B');
  });

  it('posts a structured preprocessing error when the snapshot root never made it into the vfs', async () => {
    const { controller, messages } = makeHarness({
      populate: () => ({ written: [], rejected: [], rootPresent: false }),
    });

    await controller.handleMessage({ type: 'render', request: makeRequest() });

    const errors = messages.filter((m): m is Extract<FromWorker, { type: 'error' }> => m.type === 'error');
    expect(errors).toHaveLength(1);
    expect(errors[0].error.phase).toBe('preprocessing');
    expect(errors[0].error.code).toBe('root-missing');
    // No convert ran and no result was posted for a snapshot the VFS could not seat.
    expect(results(messages)).toHaveLength(0);
    expect(progressPhases(messages)).not.toContain('converting');
  });

  it('discards a render superseded during VM warmup before it ever populates the vfs', async () => {
    const firstWarmup = deferred<WarmupOutcome>();
    let warmupCall = 0;
    let populateCalls = 0;
    const { controller, messages } = makeHarness({
      vm: {
        warmup: () => {
          warmupCall += 1;
          return warmupCall === 1 ? firstWarmup.promise : Promise.resolve(NO_BOOT);
        },
      },
      populate: () => {
        populateCalls += 1;
        return { written: [], rejected: [], rootPresent: true };
      },
    });

    const pA = controller.handleMessage({
      type: 'render',
      request: makeRequest({ requestId: 'A', mode: 'export' }),
    });
    // Let A park at its `await vm.warmup()`.
    await flush();

    const pB = controller.handleMessage({
      type: 'render',
      request: makeRequest({ requestId: 'B', mode: 'export' }),
    });
    await flush();

    // Release A's warmup; A must notice B superseded it and stop before populating.
    firstWarmup.resolve(NO_BOOT);
    await pA;
    await pB;

    // Only B populated and only B posted a result.
    expect(populateCalls).toBe(1);
    expect(results(messages).map((result) => result.requestId)).toEqual(['B']);
  });

  it('emits a stage-specific progress phase and folds counted cache hits into the stats', async () => {
    const asset: GeneratedAsset = {
      sourceHash: 'hash-1',
      kind: 'bibliography',
      format: 'svg',
      bytes: new Uint8Array([1]),
      rasterFallback: false,
    };
    const hittingCache: AssetCachePort = {
      get: (sourceHash) => (sourceHash === asset.sourceHash ? asset : undefined),
      has: () => true,
      set: () => undefined,
    };
    const citationsStage: PipelineStage = {
      kind: 'citations',
      run: (context) => {
        // Exercise the counting cache the controller wraps: one hit and one miss, so only the hit
        // is folded into the reported stats.
        context.cache.get(asset.sourceHash);
        context.cache.get('absent-hash');
        context.cache.has(asset.sourceHash);
        context.cache.set(asset);
        return Promise.resolve({ diagnostics: [] });
      },
    };

    const { controller, messages } = makeHarness({
      cache: hittingCache,
      // An injected clock keeps the reported render time deterministic.
      now: () => 1000,
      buildPipeline: (arguments_) => ({ ...makeBuildPipeline(arguments_), stages: [citationsStage] }),
    });

    await controller.handleMessage({ type: 'render', request: makeRequest() });

    // The citations stage surfaces its own distinct progress phase, in pipeline order.
    expect(progressPhases(messages)).toContain('citations');
    const posted = results(messages);
    expect(posted).toHaveLength(1);
    expect(posted[0].stats.cacheHits).toBe(1);
  });

  it('breaks the render cost down into the stages the main thread can observe', async () => {
    // A clock each collaborator moves by what it "spent", so every stage figure below is a value the
    // test set — the point being which stage each one is attributed to.
    let clock = 0;
    const spend = (ms: number) => {
      clock += ms;
    };
    const slowStage: PipelineStage = {
      kind: 'diagrams-math',
      run: () => {
        spend(40);
        return Promise.resolve({ diagnostics: [] });
      },
    };

    const { controller, messages } = makeHarness({
      now: () => clock,
      vm: {
        warmup: () => {
          spend(900);
          return Promise.resolve(ENGINE_START);
        },
      },
      populate: () => {
        spend(20);
        return { written: [], rejected: [], rootPresent: true };
      },
      buildPipeline: (arguments_) => ({ ...makeBuildPipeline(arguments_), stages: [slowStage] }),
      runConvert: () => {
        spend(300);
        return Promise.resolve<ConvertOutcome>({
          ok: true,
          pdf: new Blob([new Uint8Array([1])], { type: 'application/pdf' }),
          bytes: new Uint8Array([1]),
          diagnostics: [],
        });
      },
    });

    await controller.handleMessage({ type: 'render', request: makeRequest() });

    const { stats } = results(messages)[0]!;
    expect(stats.stages).toEqual(
      expect.objectContaining({ vmBootMs: 900, populateMs: 20, pipelineMs: 40, convertMs: 300 }),
    );
    // The whole-render figure still covers everything, so the breakdown never contradicts the total.
    expect(stats.renderMs).toBeGreaterThanOrEqual(1260);
  });

  it('folds the stages the convert measured inside the VM into the same breakdown', async () => {
    const { controller, messages } = makeHarness({
      runConvert: () =>
        Promise.resolve<ConvertOutcome>({
          ok: true,
          pdf: new Blob([new Uint8Array([1])], { type: 'application/pdf' }),
          bytes: new Uint8Array([1]),
          diagnostics: [],
          vmStages: { parseMs: 30, converterWalkMs: 700, dryRunMs: 1200, fontMs: 250, serializeMs: 180 },
        }),
    });

    await controller.handleMessage({ type: 'render', request: makeRequest() });

    const { stages } = results(messages)[0]!.stats;
    expect(stages).toEqual(
      expect.objectContaining({
        parseMs: 30,
        converterWalkMs: 700,
        dryRunMs: 1200,
        fontMs: 250,
        serializeMs: 180,
      }),
    );
  });

  it('carries no in-VM stage keys at all when the convert measured none', async () => {
    const { controller, messages } = makeHarness();

    await controller.handleMessage({ type: 'render', request: makeRequest() });

    const { stages } = results(messages)[0]!.stats;
    expect(Object.keys(stages).toSorted()).toEqual(['convertMs', 'pipelineMs', 'populateMs', 'vmBootMs']);
  });

  it('reports a warm VM as no boot time rather than omitting the stage', async () => {
    let clock = 0;
    const { controller, messages } = makeHarness(
      {
        now: () => clock,
        vm: {
          warmup: () => {
            clock += 900;
            return Promise.resolve(NO_BOOT);
          },
        },
      },
      [NO_BOOT],
    );

    await controller.handleMessage({ type: 'render', request: makeRequest() });

    // A warm VM did not boot; the 900 ms above is the fake being deliberately slow about saying so.
    // What the stage reports is boot time, and there was none — which is a measurement, not a gap.
    const { stats } = results(messages)[0]!;
    expect(stats.stages.vmBootMs).toBe(0);
    expect(stats.coldStartMs).toBeUndefined();
  });

  it('announces the engine starting once, not on every render that boots its own instance', async () => {
    // A session as it really runs: the mount-time pre-warm starts the engine, the first render reuses
    // that instance, and every render after it gets a replacement because an instance serves one render.
    const { controller, messages } = makeHarness({}, [
      ENGINE_START,
      NO_BOOT,
      REPLACEMENT_BOOT,
      REPLACEMENT_BOOT,
    ]);

    await controller.handleMessage({ type: 'warmup' });
    for (const requestId of ['r1', 'r2', 'r3']) {
      await controller.handleMessage({ type: 'render', request: makeRequest({ requestId }) });
    }

    const announcements = messages.filter((m) => m.type === 'progress' && m.phase === 'vm-init');
    expect(announcements).toHaveLength(1);
    // And it belongs to the pre-warm, not to any of the three renders the author sat through.
    expect(announcements[0]).toEqual({ type: 'progress', requestId: 'warmup', phase: 'vm-init' });
  });

  it('still measures the boot a render pays for its own instance, while calling it no cold start', async () => {
    let clock = 0;
    const { controller, messages } = makeHarness(
      {
        now: () => clock,
        vm: {
          warmup: () => {
            clock += 120;
            return Promise.resolve(REPLACEMENT_BOOT);
          },
        },
      },
      [REPLACEMENT_BOOT],
    );

    await controller.handleMessage({ type: 'render', request: makeRequest() });

    const { stats } = results(messages)[0]!;
    // The instantiation this render paid for is a real per-render cost and stays in the breakdown...
    expect(stats.stages.vmBootMs).toBe(120);
    // ...but the engine was already running, so nothing here was a cold start.
    expect(stats.coldStartMs).toBeUndefined();
    expect(progressPhases(messages)).not.toContain('vm-init');
  });

  it('reports the raster fallbacks the pipeline counted, not a fixed zero', async () => {
    const rasterizingStage: PipelineStage = {
      kind: 'diagrams-math',
      run: () => Promise.resolve({ diagnostics: [], rasterFallbacks: 2 }),
    };

    const { controller, messages } = makeHarness({
      buildPipeline: (arguments_) => ({ ...makeBuildPipeline(arguments_), stages: [rasterizingStage] }),
    });

    await controller.handleMessage({ type: 'render', request: makeRequest() });

    expect(results(messages)[0].stats.rasterFallbacks).toBe(2);
  });

  it('discards a render explicitly cancelled while its pipeline stages run', async () => {
    const stagePaused = deferred<void>();
    const pausingStage: PipelineStage = {
      kind: 'citations',
      run: async () => {
        await stagePaused.promise;
        return { diagnostics: [] };
      },
    };

    const { controller, messages } = makeHarness(
      {
        buildPipeline: (arguments_) => ({ ...makeBuildPipeline(arguments_), stages: [pausingStage] }),
      },
      [false],
    );

    const rendering = controller.handleMessage({
      type: 'render',
      request: makeRequest({ requestId: 'A', mode: 'export' }),
    });
    // Let A park inside its pipeline stage, then explicitly cancel it.
    await flush();
    await controller.handleMessage({ type: 'cancel', requestId: 'A' });
    stagePaused.resolve();
    await rendering;

    // A was cancelled mid-pipeline, so it converts nothing and posts no result.
    expect(results(messages)).toHaveLength(0);
    expect(progressPhases(messages)).not.toContain('converting');
  });

  it('posts a structured convert-phase error when the convert fails', async () => {
    const { controller, messages } = makeHarness({
      runConvert: (request) =>
        Promise.resolve<ConvertOutcome>({
          ok: false,
          error: {
            requestId: request.requestId,
            phase: 'convert',
            code: 'convert-failed',
            message: 'The convert blew up.',
          },
        }),
    });

    await controller.handleMessage({ type: 'render', request: makeRequest() });

    const errors = messages.filter((m): m is Extract<FromWorker, { type: 'error' }> => m.type === 'error');
    expect(errors).toHaveLength(1);
    expect(errors[0].error.phase).toBe('convert');
    expect(errors[0].error.code).toBe('convert-failed');
    expect(results(messages)).toHaveLength(0);
  });
});
