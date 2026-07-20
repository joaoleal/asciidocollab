/**
 * @file The PDF Web Worker entry — the composition root that wires the environment-agnostic
 * `@asciidocollab/asciidoc-pdf` engine to concrete browser adapters and hands every message to the
 * testable {@link PdfRenderController}.
 *
 * Responsibilities that MUST live here (they touch the browser/wasm surface the controller stays free
 * of): fetch + compile the vendored Asciidoctor-PDF wasm module (the ONLY network I/O this worker
 * performs — same-origin, no document-content egress; the protocol carries no URLs to fetch), build the
 * warm Ruby VM over the typed WASI bridge, adapt the VM into the pipeline VFS + populate ports, supply
 * the app's sandbox path boundary and the concrete include assembler, and post typed messages back.
 *
 * All render logic — staleness, ordered progress, diagnostic normalization, error shaping — lives in
 * {@link PdfRenderController} and is unit-tested with in-memory fakes.
 */

import {
  createCitationsStage,
  createDiagramsMathStage,
  createImageGuardStage,
  createIncludeResolveStage,
  createMountAssetsStage,
  createRubyPdfVm,
  createShimRegistry,
  createWasiBridge,
  GeneratedAssetCache,
  invokeConvert,
  mountPdfExtensions,
  populateProject,
  type AssetCachePort,
  type GeneratedAsset,
  type IncludeAssembler,
  type PipelineStage,
  type PipelineVfs,
  type ProjectSnapshot,
  type RenderError,
  type RenderRequest,
  type RubyPdfVm,
  type StageContext,
  type ToWorker,
} from '@asciidocollab/asciidoc-pdf';
import { assembleIncludes } from './assemble-includes';
import { createDiagramsMathShims, seedGeneratedAssets } from './diagrams-math-wiring';
import { createCitationJsShim } from './shims/citation-js';
import { createWoff2FontConverter } from './woff2-font-converter';
import { resolveSandboxedPath } from '../lib/asciidoc/sandbox-path';
import {
  PdfRenderController,
  type BuildPipelineArguments,
  type BuiltPipeline,
  type ConvertOutcome,
} from '../lib/pdf/pdf-render-controller';

/** Same-origin URL of the vendored wasm blob (copied into `public/` by the wasm build step). */
const WASM_URL = '/vendor/asciidoctor-pdf/asciidoctor-pdf.wasm';

/**
 * How many times to fetch + compile the wasm engine before giving up. The blob is large (tens of MiB),
 * so under a loaded machine its body can abort mid-transfer; a bounded retry rides out that transient
 * failure instead of surfacing it as a permanent render error.
 */
const MAX_COMPILE_ATTEMPTS = 3;

/** Base backoff between compile attempts, scaled by attempt number so contention has time to clear. */
const COMPILE_RETRY_BASE_MS = 250;

/** Resolve after `milliseconds`, so a failed compile can back off before the next attempt. */
function delay(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

/** Render an unknown thrown value as a short, human-readable string for the give-up error message. */
function describeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * Fetch and compile the vendored Ruby-with-Asciidoctor-PDF wasm module (same-origin only), retrying a
 * transient fetch/compile failure up to {@link MAX_COMPILE_ATTEMPTS} times.
 *
 * The whole response body is buffered and handed to {@link WebAssembly.compile} rather than piped
 * through `compileStreaming`: streaming-compile of this large blob can abort mid-flight under load
 * ("Response body loading was aborted"), whereas a buffered `arrayBuffer` tolerates a stalled body.
 */
async function compileModule(): Promise<WebAssembly.Module> {
  let lastError: unknown;
  for (let attempt = 1; attempt <= MAX_COMPILE_ATTEMPTS; attempt += 1) {
    try {
      const response = await fetch(WASM_URL);
      if (!response.ok) {
        throw new Error(`Failed to fetch the Asciidoctor-PDF wasm module (HTTP ${response.status}).`);
      }
      const bytes = await response.arrayBuffer();
      return await WebAssembly.compile(bytes);
    } catch (error) {
      lastError = error;
      if (attempt < MAX_COMPILE_ATTEMPTS) {
        await delay(COMPILE_RETRY_BASE_MS * attempt);
      }
    }
  }
  throw new Error(
    `Failed to compile the Asciidoctor-PDF wasm module after ${MAX_COMPILE_ATTEMPTS} attempts: ` +
      describeError(lastError),
  );
}

/** Adapt the injected {@link AssetCachePort} over the concrete content-addressed cache. */
function createCacheAdapter(): AssetCachePort {
  const cache = new GeneratedAssetCache();
  return {
    get: (sourceHash: string): GeneratedAsset | undefined => cache.get(sourceHash),
    has: (sourceHash: string): boolean => cache.has(sourceHash),
    set: (asset: GeneratedAsset): void => cache.set(asset.sourceHash, asset),
  };
}

/** Adapt the warm VM's VFS into the pipeline's read/write port (text via UTF-8, absent reads → null). */
function createPipelineVfs(vm: RubyPdfVm): PipelineVfs {
  const encoder = new TextEncoder();
  const decoder = new TextDecoder();
  return {
    writeFile: (path, bytes) => vm.writeFile(path, bytes),
    readFile: (path) => (vm.exists(path) ? vm.readFile(path) : null),
    writeText: (path, content) => vm.writeFile(path, encoder.encode(content)),
    readText: (path) => (vm.exists(path) ? decoder.decode(vm.readFile(path)) : null),
    exists: (path) => vm.exists(path),
    remove: (path) => vm.removeFile(path),
    list: (path) => vm.readdir(path),
  };
}

/**
 * The concrete include assembler: wraps the app's shared assembly primitive (which itself carries the
 * app's sandbox boundary + HTML placeholder policy) behind the engine's {@link IncludeAssembler} port,
 * so the package never imports the web app.
 */
function createIncludeAssembler(): IncludeAssembler {
  return {
    assemble: (request) => {
      const assembled = assembleIncludes(request.rootPath, request.readFile, request.options);
      return { content: assembled.content, unresolved: assembled.unresolved };
    },
  };
}

/** Machine code for an extension the project enabled that this render did not apply. */
const EXTENSION_NOT_LOADED_CODE = 'extension-not-loaded' as const;

/** A built controller together with the VM it owns. */
interface WorkerInstance {
  /** The wired controller every message is handed to. */
  readonly controller: PdfRenderController;
  /** The warm VM this controller renders through. */
  readonly vm: RubyPdfVm;
}

/** Assemble the whole worker over a compiled wasm module and return the wired controller. */
function buildController(module: WebAssembly.Module): WorkerInstance {
  const vm = createRubyPdfVm({ createBridge: () => createWasiBridge({ module }) });
  const vfs = createPipelineVfs(vm);

  const populate = (snapshot: ProjectSnapshot, changedPaths?: readonly string[]): ReturnType<typeof populateProject> =>
    populateProject(vm, snapshot, { changedPaths });

  const runConvert = async (request: RenderRequest): Promise<ConvertOutcome> => {
    // Extension source is written into the VM immediately before the convert requires it, from the
    // request itself. Nothing about what an EARLIER render loaded matters: the convert publishes
    // this request's selection as the enabled set, and every extension gates its hooks on it, so a
    // module left in the ancestor chain by a previous render declines to act.
    const mounted = mountPdfExtensions(vm, request);

    const outcome = await invokeConvert({ vm, request, loadedExtensions: mounted.loadedExtensions });
    if (!outcome.ok || mounted.rejected.length === 0) return outcome;

    // A refusal rides out with the render rather than being logged and forgotten. An extension the
    // project enabled that did not load changes the document, and an author told nothing about it
    // would read the result as correct — which is the failure this whole feature is most exposed to.
    return {
      ...outcome,
      diagnostics: [
        ...outcome.diagnostics,
        ...mounted.rejected.map((rejection) => ({
          severity: 'warning' as const,
          code: EXTENSION_NOT_LOADED_CODE,
          resource: rejection.id,
          message: `The "${rejection.id}" extension was not applied: ${rejection.reason}`,
        })),
      ],
    };
  };

  // One WOFF2 codec, initialized on first use and reused across renders (fonts embed rarely).
  const fontConverter = createWoff2FontConverter();

  const buildPipeline = (arguments_: BuildPipelineArguments): BuiltPipeline => {
    // Pre-seed assets the main thread already rendered (e.g. mermaid diagrams the worker's DOM-bound
    // shim cannot produce headlessly) into the content-addressed cache before any stage runs, so each
    // matching block resolves as a cache hit and its shim is never invoked here. Additive: a request
    // without `generatedAssets` seeds nothing and renders exactly as before.
    seedGeneratedAssets(arguments_.cache, arguments_.request.generatedAssets);

    // Ordered stage list; the orchestrator re-sorts to the fixed pipeline order regardless. The
    // `diagrams-math` stage renders math and the graphviz/vega diagrams headlessly in-worker (their
    // shims need no DOM), and serves mermaid blocks from the pre-seeded cache above.
    const stages: PipelineStage[] = [
      createIncludeResolveStage({ resolveSandboxedPath: arguments_.resolveSandboxedPath }),
      createCitationsStage(),
      createDiagramsMathStage(),
      createImageGuardStage(),
      createMountAssetsStage({ fontConverter }),
    ];
    const context: StageContext = {
      request: arguments_.request,
      readFile: (path) => arguments_.request.snapshot.files[path] ?? null,
      vfs,
      // citation-js is pure JS; the diagram/math shims render headlessly (graphviz/vega via WASM, math
      // via the DOM-free MathJax liteAdaptor). The DOM-bound mermaid shim is registered so its blocks
      // resolve, but pre-seeded mermaid assets make it a cache hit, so it is never invoked in-worker.
      shims: createShimRegistry([createCitationJsShim(), ...createDiagramsMathShims()]),
      includeAssembler: arguments_.includeAssembler,
      cache: arguments_.cache,
      diagnostics: arguments_.diagnostics,
      cancellation: arguments_.cancellation,
    };
    return { stages, context };
  };

  return {
    vm,
    controller: new PdfRenderController({
      vm,
      populate,
      runConvert,
      buildPipeline,
      resolveSandboxedPath,
      buildIncludeAssembler: createIncludeAssembler,
      cache: createCacheAdapter(),
      postMessage: (message) => postMessage(message),
    }),
  };
}

// The wasm module is compiled once and REUSED across VMs. Compiling costs seconds and tens of MiB;
// building a VM over an already-compiled module is comparatively cheap, which is what makes discarding
// a VM (see below) an acceptable price for correctness rather than a reason to avoid it.
//
// A FAILED compile is not memoized — the slot is reset so the next message retries.
let modulePromise: Promise<WebAssembly.Module> | null = null;

/** The current VM and its controller, or null before the first message and after a discard. */
let instancePromise: Promise<WorkerInstance> | null = null;

function getModule(): Promise<WebAssembly.Module> {
  if (modulePromise === null) {
    const pending = compileModule();
    // Do NOT poison the memoized slot on failure: a transient compile abort would otherwise be replayed
    // forever, wedging every later render. Clear the slot (only if it still holds THIS attempt) so the
    // next message re-attempts a clean compile. This runs on a DETACHED catch chain whose own rejection
    // is swallowed, so `pending` — the promise returned to the current caller — still rejects for it.
    pending.catch(() => {
      if (modulePromise === pending) {
        modulePromise = null;
      }
    });
    modulePromise = pending;
  }
  return modulePromise;
}

/**
 * The instance to serve this message with — a plain memoized getter, which it was not able to be
 * until extensions started gating themselves at render time.
 *
 * It used to discard the VM whenever a request asked for fewer extensions than were loaded, because
 * `Module#prepend` cannot be undone and a reused VM would apply an extension nobody asked for.
 * Extensions now read the per-render enabled set the convert publishes, so a module left in the
 * ancestor chain declines to act and the VM can be reused unconditionally. SC-015a and FR-031b1 are
 * satisfied by the gate rather than by throwing the VM away.
 *
 * Removing the discard also removes a defect it carried: the superset check ran for EVERY message,
 * and a non-render message reports an empty selection — so any non-render arriving after a render
 * with extensions failed the check and destroyed a perfectly good warm VM, forcing a full wasm
 * rebuild on the next render.
 */
function getInstance(): Promise<WorkerInstance> {
  if (instancePromise !== null) return instancePromise;

  const pending = getModule().then(buildController);
  pending.catch(() => {
    if (instancePromise === pending) {
      instancePromise = null;
    }
  });
  instancePromise = pending;
  return pending;
}

/** Machine code for a render that never started because the wasm engine could not be initialized. */
const ENGINE_INIT_FAILED_CODE = 'engine-init-failed';

onmessage = function (event: MessageEvent<ToWorker>): void {
  const message = event.data;
  void getInstance()
    .then((instance) => instance.controller.handleMessage(message))
    .catch((error: unknown) => {
      // `getInstance()` rejects when the wasm engine fails to compile after every retry. Surface it as
      // a fatal `vm-init` error for a render request (which carries a requestId) so the UI stops waiting
      // instead of hanging on the pending label; `warmup`/`cancel` have no request to fail, and the next
      // render re-attempts a clean compile because the memoized slot was cleared.
      if (message.type !== 'render') return;
      const failure: RenderError = {
        requestId: message.request.requestId,
        phase: 'vm-init',
        code: ENGINE_INIT_FAILED_CODE,
        message: `The PDF engine could not be initialized: ${describeError(error)}`,
      };
      postMessage({ type: 'error', error: failure });
    });
};
