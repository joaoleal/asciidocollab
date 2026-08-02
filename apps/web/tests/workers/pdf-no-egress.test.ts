/**
 * @file Security deliverable: prove the in-browser PDF render performs ZERO document-content network
 * I/O and that every remote / out-of-sandbox reference surfaces as a `remote-skipped` diagnostic
 * instead of being silently fetched or dropped.
 *
 * The proof is exercised three ways, all under a hard network guard that replaces every browser egress
 * primitive (`fetch`, `XMLHttpRequest`, `WebSocket`, `navigator.sendBeacon`, worker `importScripts`)
 * with a recorder that also throws — so a genuine leak fails loudly, not just an assertion:
 *
 *  1. A full render driven through the real {@link PdfRenderController} with in-memory fakes for its
 *     injected collaborators (VM, populate, convert, cache, postMessage) but the REAL offline guards
 *     (`include-resolve` + `image-guard` stages, the app's real include assembler + sandbox boundary),
 *     so remote-reference handling is genuinely executed rather than re-mocked.
 *  2. The `image-guard` stage in isolation.
 *  3. The `include-resolve` stage in isolation.
 *
 * The document under render deliberately references remote `include::`/`image::` targets and a
 * sandbox-escaping `../` target, alongside content that exports fine — so partial success is asserted
 * too.
 */

import {
  cancellationToken,
  createDiagnosticsCollector,
  createImageGuardStage,
  createIncludeResolveStage,
  createShimRegistry,
  isErrorMessage,
  isResultMessage,
  type AssetCachePort,
  type DiagnosticCode,
  type FromWorker,
  type GeneratedAsset,
  type IncludeAssembler,
  type PipelineVfs,
  type PopulateResult,
  type ProjectSnapshot,
  type RenderDiagnostic,
  type RenderMode,
  type RenderRequest,
  type StageContext,
  type ToWorker,
} from '@asciidocollab/asciidoc-pdf';
import {
  PdfRenderController,
  type BuildPipelineArguments,
  type BuiltPipeline,
  type ConvertOutcome,
} from '@/lib/pdf/pdf-render-controller';
import { assembleIncludes } from '@/workers/assemble-includes';
import { resolveSandboxedPath } from '@/lib/asciidoc/sandbox-path';

// ---------------------------------------------------------------------------
// Fixture targets — the references the render must NEVER fetch.
// ---------------------------------------------------------------------------

const ROOT_PATH = 'main.adoc';
const LOCAL_INCLUDE = 'chapter.adoc';

/** A remote include target (`scheme://`): must be skipped, never fetched. */
const REMOTE_INCLUDE = 'https://includes.example.com/remote.adoc';
/** An include target that escapes the project sandbox via `..`: must be skipped, never read. */
const ESCAPING_INCLUDE = '../outside/appendix.adoc';
/** A remote image target: must be skipped, never fetched. */
const REMOTE_IMAGE = 'https://cdn.example.com/logo.png';
/** An image target that escapes the project sandbox via `..`: must be skipped, never read. */
const ESCAPING_IMAGE = '../secrets/diagram.png';

/** Every reference the render must report as skipped rather than fetch or silently drop. */
const EXPECTED_SKIPPED: readonly string[] = [
  REMOTE_INCLUDE,
  ESCAPING_INCLUDE,
  REMOTE_IMAGE,
  ESCAPING_IMAGE,
];

/** The diagnostic code a remote / out-of-sandbox reference must carry. */
const REMOTE_SKIPPED: DiagnosticCode = 'remote-skipped';

const REQUEST_ID = 'render-1';
const MODE_EXPORT: RenderMode = 'export';
const PDF_MIME = 'application/pdf';

/** A root document mixing skippable remote/escaping refs with content that must still export. */
const ROOT_DOC = [
  '= Faithful Export',
  '',
  'Local intro paragraph that must still export.',
  '',
  `include::${REMOTE_INCLUDE}[]`,
  `include::${ESCAPING_INCLUDE}[]`,
  `include::${LOCAL_INCLUDE}[]`,
  '',
  `image::${REMOTE_IMAGE}[Remote logo]`,
  `image::${ESCAPING_IMAGE}[Escaping diagram]`,
  '',
].join('\n');

const LOCAL_DOC = ['== Local Chapter', '', 'Body that exports fine.', ''].join('\n');

// ---------------------------------------------------------------------------
// Hard network guard: replace every egress primitive with a throwing recorder.
// ---------------------------------------------------------------------------

interface InstalledGuard {
  /** The egress APIs that were touched during the guarded window (must stay empty). */
  readonly calls: readonly string[];
  /** Restore every replaced global to its original state. */
  restore(): void;
}

/**
 * Replace `fetch`/`XMLHttpRequest`/`WebSocket`/`navigator.sendBeacon`/`importScripts` with recorders
 * that both log the attempt and throw, so any real egress fails the render loudly. Returns the recorded
 * calls plus a restore hook.
 */
function installNetworkGuards(): InstalledGuard {
  const calls: string[] = [];
  const record = (api: string): never => {
    calls.push(api);
    throw new Error(`Blocked unexpected network access via ${api}.`);
  };
  const restorers: Array<() => void> = [];

  const overrideGlobal = (name: string, value: unknown): void => {
    const original = Object.getOwnPropertyDescriptor(globalThis, name);
    Object.defineProperty(globalThis, name, { configurable: true, writable: true, value });
    restorers.push((): void => {
      if (original === undefined) {
        Reflect.deleteProperty(globalThis, name);
      } else {
        Object.defineProperty(globalThis, name, original);
      }
    });
  };

  overrideGlobal('fetch', (): never => record('fetch'));
  overrideGlobal(
    'XMLHttpRequest',
    class {
      open(): never {
        return record('XMLHttpRequest.open');
      }
      send(): never {
        return record('XMLHttpRequest.send');
      }
    },
  );
  overrideGlobal(
    'WebSocket',
    class {
      constructor() {
        record('WebSocket');
      }
    },
  );
  overrideGlobal('importScripts', (): never => record('importScripts'));

  if (typeof navigator !== 'undefined') {
    try {
      const original = Object.getOwnPropertyDescriptor(navigator, 'sendBeacon');
      Object.defineProperty(navigator, 'sendBeacon', {
        configurable: true,
        writable: true,
        value: (): never => record('navigator.sendBeacon'),
      });
      restorers.push((): void => {
        if (original === undefined) {
          Reflect.deleteProperty(navigator, 'sendBeacon');
        } else {
          Object.defineProperty(navigator, 'sendBeacon', original);
        }
      });
    } catch {
      // The runtime's `navigator` is immutable — the other four guards still cover egress.
    }
  }

  return {
    calls,
    restore: (): void => {
      for (const restoreOne of restorers) {
        restoreOne();
      }
    },
  };
}

/** Run `body` with the network guards installed, restoring them even if the body rejects. */
async function underNetworkGuard(body: () => Promise<void>): Promise<readonly string[]> {
  const guard = installNetworkGuards();
  try {
    await body();
  } finally {
    guard.restore();
  }
  return guard.calls;
}

// ---------------------------------------------------------------------------
// In-memory fakes for the controller's injected collaborators + stage context.
// ---------------------------------------------------------------------------

const encoder = new TextEncoder();
const decoder = new TextDecoder();

/** A minimal in-memory {@link PipelineVfs} (the include-resolve stage writes the inlined doc here). */
function createFakeVfs(): PipelineVfs {
  const files = new Map<string, Uint8Array>();
  return {
    writeFile: (path, bytes): void => void files.set(path, bytes),
    readFile: (path): Uint8Array | null => files.get(path) ?? null,
    writeText: (path, content): void => void files.set(path, encoder.encode(content)),
    readText: (path): string | null => {
      const bytes = files.get(path);
      return bytes === undefined ? null : decoder.decode(bytes);
    },
    exists: (path): boolean => files.has(path),
    remove: (path): void => void files.delete(path),
    list: (): readonly string[] => [...files.keys()],
  };
}

/** A no-op in-memory generated-asset cache. */
function createFakeCache(): AssetCachePort {
  const store = new Map<string, GeneratedAsset>();
  return {
    get: (sourceHash): GeneratedAsset | undefined => store.get(sourceHash),
    has: (sourceHash): boolean => store.has(sourceHash),
    set: (asset): void => void store.set(asset.sourceHash, asset),
  };
}

/**
 * The app's real include assembler (wrapping the shared assembly primitive + real sandbox boundary),
 * mirroring the worker composition root so remote/escaping handling is genuinely exercised.
 */
function createRealIncludeAssembler(): IncludeAssembler {
  return {
    assemble: (request) => {
      const assembled = assembleIncludes(request.rootPath, request.readFile, request.options);
      return { content: assembled.content, unresolved: assembled.unresolved };
    },
  };
}

/** A snapshot whose root references remote + sandbox-escaping targets plus a resolvable local include. */
function createSnapshot(): ProjectSnapshot {
  return {
    files: { [ROOT_PATH]: ROOT_DOC, [LOCAL_INCLUDE]: LOCAL_DOC },
    binaryAssets: {},
    rootPath: ROOT_PATH,
    openPath: ROOT_PATH,
    fontPaths: [],
    attributes: {},
  };
}

/** A stage context wired to a snapshot, the real assembler, and in-memory fakes. */
function createStageContext(snapshot: ProjectSnapshot): StageContext {
  return {
    request: { requestId: REQUEST_ID, mode: MODE_EXPORT, snapshot, optimize: true },
    readFile: (path): string | null => snapshot.files[path] ?? null,
    vfs: createFakeVfs(),
    shims: createShimRegistry([]),
    includeAssembler: createRealIncludeAssembler(),
    cache: createFakeCache(),
    diagnostics: createDiagnosticsCollector(),
    cancellation: cancellationToken(() => false),
  };
}

/** The bytes of a stub PDF (`%PDF`) the fake convert returns so the render completes. */
const STUB_PDF_BYTES = new Uint8Array([0x25, 0x50, 0x44, 0x46]);

/**
 * Build a controller whose collaborators are in-memory fakes EXCEPT the pipeline, which runs the REAL
 * offline guards over the real include assembler + sandbox boundary. `postMessage` records outbound
 * messages into `sink`.
 */
// Runs the REAL include-resolve + image-guard stages over an in-memory context so the no-egress
// assertions exercise the actual offline guards rather than a stub.
function offlineBuildPipeline(arguments_: BuildPipelineArguments): BuiltPipeline {
  return {
    stages: [
      createIncludeResolveStage({ resolveSandboxedPath: arguments_.resolveSandboxedPath }),
      createImageGuardStage(),
    ],
    context: {
      request: arguments_.request,
      readFile: (path): string | null => arguments_.request.snapshot.files[path] ?? null,
      vfs: createFakeVfs(),
      shims: createShimRegistry([]),
      includeAssembler: arguments_.includeAssembler,
      cache: arguments_.cache,
      diagnostics: arguments_.diagnostics,
      cancellation: arguments_.cancellation,
    },
  };
}

function createController(sink: FromWorker[]): PdfRenderController {
  return new PdfRenderController({
    vm: { warmup: () => Promise.resolve({ booted: false, firstBoot: false }) },
    populate: (): PopulateResult => ({ written: [], rejected: [], rootPresent: true }),
    runConvert: (): Promise<ConvertOutcome> =>
      Promise.resolve({
        ok: true,
        pdf: new Blob([STUB_PDF_BYTES], { type: PDF_MIME }),
        bytes: STUB_PDF_BYTES,
        diagnostics: [],
      }),
    buildPipeline: offlineBuildPipeline,
    resolveSandboxedPath,
    buildIncludeAssembler: createRealIncludeAssembler,
    cache: createFakeCache(),
    postMessage: (message): void => void sink.push(message),
  });
}

// ---------------------------------------------------------------------------
// Helpers.
// ---------------------------------------------------------------------------

/** The `resource` of every diagnostic carrying `code`, sorted for stable comparison. */
function resourcesWithCode(diagnostics: readonly RenderDiagnostic[], code: DiagnosticCode): string[] {
  return diagnostics
    .filter((diagnostic) => diagnostic.code === code)
    .map((diagnostic) => diagnostic.resource)
    .toSorted();
}

// ---------------------------------------------------------------------------
// Tests.
// ---------------------------------------------------------------------------

describe('PDF render performs no document-content network egress', () => {
  it('drives a full render through the controller with zero network I/O and skips every remote ref', async () => {
    const sink: FromWorker[] = [];
    const controller = createController(sink);
    const request: RenderRequest = {
      requestId: REQUEST_ID,
      mode: MODE_EXPORT,
      snapshot: createSnapshot(),
      optimize: true,
    };

    const networkCalls = await underNetworkGuard(() =>
      controller.handleMessage({ type: 'render', request } satisfies ToWorker),
    );

    // (1) No egress primitive was touched during the render.
    expect(networkCalls).toEqual([]);

    // (3) The render completed (partial success) — a result, not a fatal error, with a PDF Blob.
    expect(sink.filter(isErrorMessage)).toEqual([]);
    const results = sink.filter(isResultMessage);
    expect(results).toHaveLength(1);
    const { result } = results[0];
    expect(result.pdf).toBeInstanceOf(Blob);

    // (2) Every remote / escaping reference surfaced as a `remote-skipped` diagnostic — none silently
    // fetched, none silently dropped.
    expect(resourcesWithCode(result.diagnostics, REMOTE_SKIPPED)).toEqual([...EXPECTED_SKIPPED].toSorted());
  });

  it('image-guard skips remote and sandbox-escaping images without touching the network', async () => {
    const context = createStageContext(createSnapshot());
    let diagnostics: readonly RenderDiagnostic[] = [];

    const networkCalls = await underNetworkGuard(async () => {
      const outcome = await createImageGuardStage().run(context);
      diagnostics = outcome.diagnostics ?? [];
    });

    expect(networkCalls).toEqual([]);
    expect(resourcesWithCode(diagnostics, REMOTE_SKIPPED)).toEqual([ESCAPING_IMAGE, REMOTE_IMAGE].toSorted());
  });

  it('include-resolve skips remote and sandbox-escaping includes without touching the network', async () => {
    const context = createStageContext(createSnapshot());
    let diagnostics: readonly RenderDiagnostic[] = [];

    const networkCalls = await underNetworkGuard(async () => {
      const outcome = await createIncludeResolveStage({ resolveSandboxedPath }).run(context);
      diagnostics = outcome.diagnostics ?? [];
    });

    expect(networkCalls).toEqual([]);
    expect(resourcesWithCode(diagnostics, REMOTE_SKIPPED)).toEqual(
      [ESCAPING_INCLUDE, REMOTE_INCLUDE].toSorted(),
    );
  });
});
